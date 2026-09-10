import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isFlagEnabled } from "../_shared/flags.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return respond(400, { error: "POST required" });
  }

  try {
    const { platform } = await req.json();

    if (!platform || !["linkedin", "facebook"].includes(platform)) {
      return respond(400, { error: "Invalid platform. Use linkedin or facebook" });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const redirectUri = Deno.env.get("OAUTH_REDIRECT_URL") ||
      `${supabaseUrl}/functions/v1/oauth-callback`;

    const state = crypto.randomUUID();

    const { error: insertErr } = await supabase.from("oauth_states").insert({
      state,
      platform,
      created_by: null,
    });

    if (insertErr) {
      console.error("Failed to persist OAuth state:", insertErr);
      return respond(500, { error: "Failed to initiate OAuth flow" });
    }

    let url: string;

    if (platform === "linkedin") {
      const clientId = Deno.env.get("LINKEDIN_CLIENT_ID");
      if (!clientId) return respond(500, { error: "LINKEDIN_CLIENT_ID not configured" });

      const orgMode = isFlagEnabled(Deno.env.get("LINKEDIN_ORG_MODE"));
      const scopes = (orgMode
        ? ["openid", "profile", "w_member_social", "w_organization_social", "r_organization_admin"]
        : ["openid", "profile", "w_member_social"]
      ).join(" ");
      const authUrl = new URL("https://www.linkedin.com/oauth/v2/authorization");
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("scope", scopes);
      url = authUrl.toString();
    } else {
      const appId = Deno.env.get("FACEBOOK_APP_ID");
      if (!appId) return respond(500, { error: "FACEBOOK_APP_ID not configured" });

      const scopes = [
        "pages_show_list",
        "pages_manage_posts",
        "pages_read_engagement",
        "read_insights",
        "instagram_basic",
        "instagram_content_publish",
        "instagram_manage_comments",
        "instagram_manage_insights",
      ].join(",");
      const authUrl = new URL("https://www.facebook.com/v25.0/dialog/oauth");
      authUrl.searchParams.set("client_id", appId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("scope", scopes);
      url = authUrl.toString();
    }

    return respond(200, { url });
  } catch (err) {
    console.error("OAuth start error:", err);
    return respond(500, { error: "Internal server error" });
  }
});

function respond(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
