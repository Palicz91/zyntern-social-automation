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

  const strippedDescription = stripHtml(body.description);

  const linkedinUrl = buildUtmUrl(body.job_url, "linkedin");
  const facebookUrl = buildUtmUrl(body.job_url, "facebook");

  const prompt = `Generálj social media posztokat egy gyakornoki/diákmunka pozícióhoz. A válasz KIZÁRÓLAG egy JSON objektum legyen, semmi más.

Pozíció adatai:
- Pozíció neve: ${body.job_title}
- Cég: ${body.company_name}
- Kategória: ${body.category || "N/A"}
- Szükséges skillek: ${body.skills?.join(", ") || "N/A"}
- Helyszín: ${body.location}
- Heti óraszám: ${body.weekly_hours || "N/A"}
- Fizetett: ${body.is_paid ? "Igen" : "Nem"}
- Remote: ${body.is_remote ? "Igen" : "Nem"}
- Leírás: ${strippedDescription}
- Juttatások: ${body.benefits?.join(", ") || "N/A"}

Szabályok:
- Minden poszt MAGYAR nyelvű
- LinkedIn: profi hangnem, 1-2 bekezdés, releváns hashtagek (#gyakornok #diákmunka stb.), CTA: "Jelentkezz itt: ${linkedinUrl}"
- Facebook: lazább, barátságos hangnem, emojik használata, rövid hook az elején, link a végén: ${facebookUrl}
- Instagram: NEM tartalmazhat kattintható linket a poszt szövegében, ehelyett "A linket a bio-ban találod!" vagy "Linket kommentben hagyjuk!" CTA. Releváns hashtagek.

Válasz formátum (kizárólag ez, semmi más):
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
      messages: [{ role: "user", content: prompt }],
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
