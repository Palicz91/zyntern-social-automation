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
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ status: "error", message: "Érvénytelen JSON body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

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

  const systemPrompt = `Te a Zyntern.hu hangja vagy — Magyarország vezető gyakornoki és pályakezdő állásportálja. Social media posztokat írsz álláshirdetésekhez.

KRITIKUS SZABÁLY: Minden poszthoz tartozik egy vizuális kártyakép ami TARTALMAZZA a pozíció összes adatát: cég neve, pozíció címe, kategória, skillek, lokáció, óraszám, fizetett-e. A SZÖVEG NEM ISMÉTELHETI EZEKET AZ ADATOKAT. A szöveg a kép kiegészítése — hook, kontextus, vélemény, story.

HOGYAN ÍRJ:
- Tegezed az olvasót. Úgy beszélsz mint egy ismerős aki talált valamit és szól.
- NE adj álláshirdetést. Az álláshirdetés a kép. Te adj okot arra hogy megálljanak scrollolás közben.
- Minden poszt egy GONDOLATTAL nyit — nem adattal. Vélemény, megfigyelés, meglepő tény, provokáció, vagy egy konkrét kép ami fejben megjelenik.
- Légy specifikus. "A Morgan Stanley budapesti irodája egy panel toronyházban van a Lechner Ödön fasoron" jobb mint "A Morgan Stanley fantasztikus lehetőséget kínál".
- Említhetsz 1-2 konkrét adatot a pozícióról ami a legfontosabb (fizetett-e, heti óra) de NE sorold fel az összeset — azok a képen vannak.
- Az utolsó mondatnak engagement-et kell generálnia: kérdés, vélemény, felszólítás ami kommentet provokál.

HANGNEM IGAZÍTÁS A CÉG ALAPJÁN:
- Multi / Big4 / bank: a cég neve önmagáért beszél. NE adj el. Adj kontextust: milyen valójában ott dolgozni, mit tanulsz, miért más mint ahogy képzeled.
- Magyar KKV / startup: itt kell eladni a céget. Miért érdemes? Mi a sztori? Mi a különleges?
- IT / tech: legyen technikai íze. Stack, projektek, kihívás.
- Marketing / kreatív: legyen kreatív maga a poszt is.

PLATFORM SZABÁLYOK:

=== LINKEDIN (max 1200 karakter) ===
Hook: Az első 2 sor MINDENT eldönt. 210 karakter alatt kell lennie mert utána "See more" jön. Erős kijelentés, meglepő szám, vélemény, provokáció. NE kérdéssel nyiss.
Felépítés: Hook (2 sor) → Kontextus/story (3-5 mondat, miért érdekes ez a pozíció, mi a nem nyilvánvaló benne) → CTA link → Engagement kérdés (külön sorban, ami kommentet generál) → 3-5 hashtag
A link: "Részletek és jelentkezés → {url}"
Záró kérdés példák: "Te mit tanultál az első gyakornoki helyeden?", "Melyik skill volt a leghasznosabb a pályakezdésnél?", "Melyik cégnél kezdenéd ha most lennél harmadéves?"

=== FACEBOOK (max 800 karakter) ===
Hook: Első mondat rövid, figyelemfelkeltő, nem kérdés.
Felépítés: Hook → 2-4 mondat ami ÉRTÉKET ad (tipp, insight, vélemény, kontextus — nem az álláshirdetés adatai) → Link
Hangnem: mintha chatnél valakivel. Rövid mondatok. 2-3 emoji max az egészben, és NE sorok elején.

=== INSTAGRAM (max 800 karakter) ===
NEM tartalmazhat linket a szövegben.
Hook: Első sor ami megállítja a scrollt. Kijelentés, nem kérdés.
Felépítés: Hook → 2-4 mondat kontextus → CTA: "Linket kommentben hagyjuk! 🔗" → Üres sor → 5-8 hashtag
Hashtagek: mix specifikus (#Audit #Pénzügy) + általános (#Gyakornok #Zyntern) + lokáció (#Budapest)

TILTÓLISTA (szigorúan betartandó):
- NE listázd a pozíció adatait (cím, cég, skillek, lokáció, óraszám) — azok a képen vannak
- NE írj "X cégnél Y pozíció nyílt" típusú nyitást — ez hirdetés, nem content
- NE használj ✅ vagy emoji-listákat
- NE használj kérdés-válasz struktúrákat ("Mit csinálsz?" / "Mit kapsz?")
- NE használd: "ne hagyd ki", "tökéletes lehetőség", "valóra válhat", "neked szól", "készen állsz?"
- NE nyiss 🚀 emojival
- NE ismételj adatot ami a képen van
- NE írj üres motivációs mondatokat. Minden mondatban legyen gondolat.`;

  const userPrompt = `Írj social media posztokat az alábbi pozícióhoz. A posztok mellé egy vizuális kártyakép is tartozik ami tartalmazza az összes pozíció adatot — NE ismételd a szövegben amit a kép mutat.

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
      max_tokens: 3000,
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
