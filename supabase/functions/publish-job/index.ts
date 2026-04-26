import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const REQUIRED_FIELDS = [
  "job_id",
  "job_title",
  "company_name",
  "location",
  "job_url",
  "description",
  "logo_url",
] as const;

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function buildUtmUrl(baseUrl: string, platform: string): string {
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}utm_source=${platform}&utm_medium=social&utm_campaign=job_post`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ status: "error", message: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const startTime = Date.now();

  try {
    // 1. Auth validation
    const authHeader = req.headers.get("Authorization");
    const expectedToken = Deno.env.get("API_AUTH_TOKEN");

    if (!authHeader || !expectedToken || authHeader !== `Bearer ${expectedToken}`) {
      return new Response(
        JSON.stringify({ status: "error", message: "Érvénytelen API token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 2. Body validation
    const body = await req.json();

    for (const field of REQUIRED_FIELDS) {
      if (!body[field]) {
        return new Response(
          JSON.stringify({ status: "error", message: `Hiányzó kötelező mező: ${field}` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // 3. Idempotency check
    const { data: existingJob } = await supabase
      .from("jobs")
      .select("id")
      .eq("external_job_id", body.job_id)
      .maybeSingle();

    if (existingJob) {
      return new Response(
        JSON.stringify({
          status: "error",
          message: "Ez a job_id már feldolgozás alatt van",
          post_id: existingJob.id,
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 4. Sanitize types before insert
    const weeklyHours = typeof body.weekly_hours === "number" ? body.weekly_hours
      : typeof body.weekly_hours === "string" ? parseInt(body.weekly_hours, 10) || null
      : null;
    const isPaid = body.is_paid === true || body.is_paid === "true";
    const isRemote = body.is_remote === true || body.is_remote === "true";
    const skills = Array.isArray(body.skills) ? body.skills : body.skills ? [String(body.skills)] : null;
    const benefits = Array.isArray(body.benefits) ? body.benefits : body.benefits ? [String(body.benefits)] : null;
    const deadline = body.deadline && /^\d{4}-\d{2}-\d{2}/.test(String(body.deadline))
      ? String(body.deadline).substring(0, 10) : null;

    const { data: job, error: jobError } = await supabase
      .from("jobs")
      .insert({
        external_job_id: body.job_id,
        job_title: body.job_title,
        company_name: body.company_name,
        category: body.category || null,
        skills,
        location: body.location,
        weekly_hours: weeklyHours,
        is_paid: isPaid,
        is_remote: isRemote,
        logo_url: body.logo_url,
        cover_image_url: body.cover_image_url || null,
        job_url: body.job_url,
        description: body.description,
        benefits,
        deadline,
      })
      .select("id")
      .single();

    if (jobError || !job) {
      // Handle race condition: unique constraint violation = duplicate
      if (jobError?.code === "23505") {
        const { data: existingJob } = await supabase
          .from("jobs").select("id").eq("external_job_id", body.job_id).maybeSingle();
        return new Response(
          JSON.stringify({
            status: "error",
            message: "Ez a job_id már feldolgozás alatt van",
            post_id: existingJob?.id,
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      console.error("Job insert failed:", jobError);
      return new Response(
        JSON.stringify({ status: "error", message: "Szerver hiba" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 5. Generate content (Claude API + image service)
    let copy: { linkedin: string; facebook: string; instagram: string };
    let imageUrl: string | null = null;

    try {
      copy = await generateCopy(body);
    } catch (err) {
      console.error("Claude API failed:", err);
      copy = {
        linkedin: `${body.job_title} pozíció - ${body.company_name}`,
        facebook: `${body.job_title} pozíció - ${body.company_name}`,
        instagram: `${body.job_title} pozíció - ${body.company_name}`,
      };
    }

    try {
      imageUrl = await generateImage(body);
    } catch (err) {
      console.warn("Image generation failed:", err);
    }

    // 6. Create social_posts with generated content
    const platformData = [
      { platform: "linkedin", text: copy.linkedin },
      { platform: "facebook_page", text: copy.facebook },
      { platform: "instagram", text: copy.instagram },
    ] as const;

    const postRows = platformData.map((p) => ({
      job_id: job.id,
      platform: p.platform,
      original_text: p.text,
      image_url: imageUrl,
      status: "pending" as const,
    }));

    const { error: postsError } = await supabase.from("social_posts").insert(postRows);

    if (postsError) {
      console.error("Social posts insert failed:", postsError);
      return new Response(
        JSON.stringify({ status: "error", message: "Szerver hiba" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 7. Log + return success
    const responseBody = {
      status: "ok",
      post_id: job.id,
      message: "Tartalom generálva, jóváhagyásra vár.",
    };

    await logRequest(supabase, startTime, 200, body, responseBody);

    return new Response(
      JSON.stringify(responseBody),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("Unhandled error:", err);

    // Best-effort logging
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const sb = createClient(supabaseUrl, supabaseKey);
      await logRequest(sb, startTime, 500, null, { error: String(err) });
    } catch { /* ignore */ }

    return new Response(
      JSON.stringify({ status: "error", message: "Szerver hiba" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

async function logRequest(
  supabase: ReturnType<typeof createClient>,
  startTime: number,
  statusCode: number,
  requestBody: Record<string, unknown> | null,
  responseBody: Record<string, unknown>,
) {
  try {
    await supabase.from("api_logs").insert({
      endpoint: "publish-job",
      method: "POST",
      status_code: statusCode,
      request_summary: requestBody
        ? `job_id=${requestBody.job_id} company=${requestBody.company_name} title=${requestBody.job_title}`
        : null,
      response_summary: JSON.stringify(responseBody).substring(0, 500),
      duration_ms: Date.now() - startTime,
    });
  } catch (e) {
    console.warn("Failed to write api_log:", e);
  }
}

// --- Content generation ---

interface JobBody {
  job_id: string;
  job_title: string;
  company_name: string;
  category?: string;
  skills?: string[];
  location: string;
  weekly_hours?: number;
  is_paid?: boolean;
  is_remote?: boolean;
  description: string;
  benefits?: string[];
  job_url: string;
  logo_url: string;
  cover_image_url?: string;
}

async function generateCopy(
  body: JobBody,
): Promise<{ linkedin: string; facebook: string; instagram: string }> {
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY not set");

  const rawDescription = stripHtml(body.description);
  const strippedDescription = rawDescription.length > 2000
    ? rawDescription.substring(0, 2000) + "..."
    : rawDescription;

  const linkedinUrl = buildUtmUrl(body.job_url, "linkedin");
  const facebookUrl = buildUtmUrl(body.job_url, "facebook");

  const systemPrompt = `Álláshirdetésekből social media posztokat írsz a Zyntern.hu számára. A Zyntern Magyarország vezető gyakornoki és pályakezdő állásportálja.

SZEREPED: A Zyntern hangjaként írsz. Tegezed az olvasót. Úgy szólsz hozzá mint egy segítőkész ismerős aki talált neki valamit.

HANGNEM IGAZÍTÁS A CÉG TÍPUSA ALAPJÁN:
- Multinacionális / Big4 / bank / tanácsadó cég: informatív, magabiztos, a cég brand erejét kihasználod ("A Deloitte audit csapata", "A Morgan Stanley budapesti irodája"). Nem kell eladni a céget, az eladja magát. Fókusz a pozíció részletein.
- Magyar KKV / startup / kevésbé ismert cég: több kontextus kell a cégről, emeld ki ami vonzó (rugalmasság, tanulás, csapat méret, növekedés). A pozíció mellett a céget is "el kell adni".
- IT / tech pozíció: technikai részletek fontosak (stack, eszközök, projektek). Ne legyél generic.
- Marketing / sales / kommunikáció: a kreativitást és az önállóságot emeld ki.

PLATFORMSZABÁLYOK:

LinkedIn (max 800 karakter):
- Egy erős nyitó mondat ami a cég vagy pozíció egyedi vonását emeli ki. NE kérdéssel nyiss.
- 2-3 mondat a lényegről: mit csinál, mit kap, miért jó.
- Záró CTA a linkkel.
- 3-5 hashtag. A hashtagek legyenek specifikusak a pozícióra (ne csak #Gyakornok #Diákmunka minden alkalommal, hanem pl. #Audit #Pénzügy #IT #Marketing a kategória alapján). #Zyntern mindig legyen benne.

Facebook (max 500 karakter):
- Rövid, pörgős. Olyan mintha chatben szólnál valakinek.
- 1 hook mondat (max 10 szó), 2-3 mondat lényeg, link.
- Max 2-3 emoji az egész posztban, és NE a sorok elején.
- Semmi lista, semmi struktúra, folyószöveg.

Instagram (max 600 karakter):
- NEM tartalmazhat linket a szövegben.
- Nyitó sor ami megállítja a scrollt (ne kérdés legyen, hanem kijelentés vagy FOMO).
- 2-3 mondat, aztán CTA: "Linket kommentben hagyjuk! 🔗"
- 5-8 hashtag a végén, mix: 2-3 általános (#Gyakornok #Diákmunka #Zyntern) + 3-5 specifikus a pozícióra.

HASHTAG LOGIKA:
- Mindig: #Zyntern
- Kategória alapján válaszd az alábbiak közül: #Gyakornok #Diákmunka #Pályakezdő #Audit #Pénzügy #Marketing #IT #Mérnök #HR #Jog #Értékesítés #Tech #Startup #Data #Excel #Könyvelés #Kommunikáció #Gazdaság #Budapest #Debrecen #Győr #Szeged #Pécs #Miskolc (a lokáció alapján adj hozzá város hashtaget)
- NE használj 3-nál több generic hashtaget (#Karrier #Munka #Lehetőség túl tág, kerüld)

TILTÓLISTA — ezeket SOHA ne írd:
- Kérdés-válasz struktúrák ("Mit csinálsz majd?" / "Mit kapsz cserébe?")
- ✅ emoji-listák vagy bármilyen emoji + szöveg felsorolás (📊📁🤝)
- "ne hagyd ki", "tökéletes lehetőség", "valóra válhat", "ki akarsz törni", "neked szól", "ez a te lehetőséged", "most valóra válhat", "készen állsz?"
- Üres motivációs mondatok. Minden mondatban legyen konkrét infó.
- Alany-állítmány keveredés ("A Deloitte keresünk" — vagy "A Deloitte keres" vagy "Keresünk")
- "Szeretnél X tapasztalatot szerezni?" típusú nyitások — túl generic, minden AI ezt írja
- "Ez a lehetőség neked szól" típusú zárások
- 🚀 emoji a poszt elején (dead giveaway)

KÖTELEZŐ TARTALOM — ha az adat elérhető, MINDIG említsd:
- Fizetett-e (ha igen, emeld ki, ez döntő info)
- Heti óraszám
- Helyszín
- Legalább 1 konkrét feladat a leírásból
- Legalább 1 juttatás (ha van)`;

  const userPrompt = `Írj social media posztokat az alábbi pozícióhoz:

Pozíció: ${body.job_title}
Cég: ${body.company_name}
Kategória: ${body.category || "nincs megadva"}
Skillek: ${body.skills?.join(", ") || "nincs megadva"}
Helyszín: ${body.location}
Heti óraszám: ${body.weekly_hours || "nincs megadva"}
Fizetett: ${body.is_paid ? "Igen" : "Nem"}
Remote: ${body.is_remote ? "Igen" : "Nem"}
Juttatások: ${body.benefits?.join(", ") || "nincs megadva"}
Leírás: ${strippedDescription}

LinkedIn CTA link: ${linkedinUrl}
Facebook link: ${facebookUrl}

Válaszolj KIZÁRÓLAG az alábbi JSON formátumban, semmi más:
{"linkedin": "...", "facebook": "...", "instagram": "..."}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const result = await response.json();
  const text = result.content?.[0]?.text || "";

  // Extract JSON from response (handle potential markdown wrapping)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Failed to parse Claude response: ${text.substring(0, 200)}`);
  }

  return JSON.parse(jsonMatch[0]);
}

async function generateImage(body: JobBody): Promise<string | null> {
  const imageServiceUrl = Deno.env.get("IMAGE_SERVICE_URL");
  if (!imageServiceUrl) {
    console.warn("IMAGE_SERVICE_URL not set — skipping image generation");
    return null;
  }

  const imageApiKey = Deno.env.get("IMAGE_API_KEY") || "";

  try {
    const response = await fetch(`${imageServiceUrl}/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": imageApiKey,
      },
      body: JSON.stringify({
        job_id: body.job_id,
        job_title: body.job_title,
        company_name: body.company_name,
        location: body.location,
        logo_url: body.logo_url,
        is_paid: body.is_paid,
        is_remote: body.is_remote,
        category: body.category,
        skills: body.skills,
        weekly_hours: body.weekly_hours,
        cover_image_url: body.cover_image_url,
      }),
    });

    if (!response.ok) {
      console.warn(`Image service returned ${response.status} — skipping`);
      return null;
    }

    const data = await response.json();
    return data.image_url || null;
  } catch (err) {
    console.warn("Image service unreachable — skipping:", err);
    return null;
  }
}
