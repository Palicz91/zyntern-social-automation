import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Called by pg_cron daily — refreshes tokens expiring within 7 days

Deno.serve(async (req) => {
  // Allow cron calls (no auth check for internal trigger)
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  const sevenDaysFromNow = new Date(
    Date.now() + 7 * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Find tokens expiring within 7 days
  const { data: tokens, error } = await supabase
    .from("social_tokens")
    .select("*")
    .lt("expires_at", sevenDaysFromNow)
    .gt("expires_at", new Date().toISOString());

  if (error || !tokens || tokens.length === 0) {
    return new Response(
      JSON.stringify({ status: "ok", message: "No tokens need refresh" }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  const results: { platform: string; result: string }[] = [];

  for (const token of tokens) {
    try {
      if (token.platform === "linkedin" && token.refresh_token) {
        await refreshLinkedIn(supabase, token);
        results.push({ platform: "linkedin", result: "refreshed" });
      } else if (token.platform === "facebook_page") {
        await refreshFacebook(supabase, token);
        results.push({ platform: "facebook_page", result: "refreshed" });
      } else {
        results.push({
          platform: token.platform,
          result: "skipped (no refresh method)",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.error(`Token refresh failed for ${token.platform}:`, msg);
      results.push({ platform: token.platform, result: `failed: ${msg}` });
    }
  }

  return new Response(JSON.stringify({ status: "ok", results }), {
    headers: { "Content-Type": "application/json" },
  });
});

async function refreshLinkedIn(
  supabase: ReturnType<typeof createClient>,
  token: { refresh_token: string; platform: string },
) {
  const clientId = Deno.env.get("LINKEDIN_CLIENT_ID")!;
  const clientSecret = Deno.env.get("LINKEDIN_CLIENT_SECRET")!;

  const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });

  if (!res.ok) {
    throw new Error(`LinkedIn refresh failed: ${await res.text()}`);
  }

  const data = await res.json();
  const expiresAt = new Date(
    Date.now() + (data.expires_in || 5184000) * 1000,
  ).toISOString();

  await supabase
    .from("social_tokens")
    .update({
      access_token: data.access_token,
      refresh_token: data.refresh_token || token.refresh_token,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("platform", "linkedin");
}

async function refreshFacebook(
  supabase: ReturnType<typeof createClient>,
  token: { access_token: string; platform: string },
) {
  const appId = Deno.env.get("FACEBOOK_APP_ID")!;
  const appSecret = Deno.env.get("FACEBOOK_APP_SECRET")!;

  // Facebook long-lived token refresh
  const url = new URL("https://graph.facebook.com/v25.0/oauth/access_token");
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("fb_exchange_token", token.access_token);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Facebook refresh failed: ${await res.text()}`);
  }

  const data = await res.json();
  const expiresAt = new Date(
    Date.now() + (data.expires_in || 5184000) * 1000,
  ).toISOString();

  await supabase
    .from("social_tokens")
    .update({
      access_token: data.access_token,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("platform", "facebook_page");
}
