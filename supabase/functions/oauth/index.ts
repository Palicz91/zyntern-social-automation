import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const DASHBOARD_URL = "https://zyntern-social-dashboard.netlify.app";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace("/oauth", "").replace(/^\/+/, "");

  if (path === "callback") {
    return handleCallback(url);
  }

  // Initiate OAuth flow
  return handleInitiate(url);
});

// --- Initiate OAuth ---

function handleInitiate(url: URL): Response {
  const platform = url.searchParams.get("platform");

  if (!platform || !["linkedin", "facebook"].includes(platform)) {
    return new Response("Invalid platform. Use ?platform=linkedin or ?platform=facebook", {
      status: 400,
      headers: corsHeaders,
    });
  }

  const redirectUri = Deno.env.get("OAUTH_REDIRECT_URL") ||
    `${Deno.env.get("SUPABASE_URL")}/functions/v1/oauth/callback`;

  // CSRF: state = platform + random nonce (validated on callback)
  const nonce = crypto.randomUUID().substring(0, 8);
  const state = `${platform}_${nonce}`;

  if (platform === "linkedin") {
    const clientId = Deno.env.get("LINKEDIN_CLIENT_ID") || "PLACEHOLDER";
    // w_member_social: available to all apps (post as member)
    // w_organization_social + r_organization_social: requires LinkedIn partner review (Phase 2)
    const scopes = ["openid", "profile", "w_member_social"].join(" ");

    const authUrl = new URL("https://www.linkedin.com/oauth/v2/authorization");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("scope", scopes);

    return Response.redirect(authUrl.toString(), 302);
  }

  // Facebook
  const appId = Deno.env.get("FACEBOOK_APP_ID") || "PLACEHOLDER";
  const scopes = [
    "pages_manage_posts",
    "pages_read_engagement",
    "instagram_content_publish",
  ].join(",");

  const authUrl = new URL("https://www.facebook.com/v25.0/dialog/oauth");
  authUrl.searchParams.set("client_id", appId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", scopes);

  return Response.redirect(authUrl.toString(), 302);
}

// --- OAuth Callback ---

async function handleCallback(url: URL): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return redirectToDashboard(`error=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    return redirectToDashboard("error=missing_code_or_state");
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  const redirectUri = Deno.env.get("OAUTH_REDIRECT_URL") ||
    `${supabaseUrl}/functions/v1/oauth/callback`;

  // Parse platform from state (format: "platform_nonce")
  const platform = state.split("_")[0];

  try {
    if (platform === "linkedin") {
      await handleLinkedInCallback(supabase, code, redirectUri);
    } else if (platform === "facebook") {
      await handleFacebookCallback(supabase, code, redirectUri);
    } else {
      return redirectToDashboard("error=invalid_state");
    }

    return redirectToDashboard(`success=${platform}`);
  } catch (err) {
    console.error(`OAuth callback error (${state}):`, err);
    const msg = err instanceof Error ? err.message : "unknown";
    return redirectToDashboard(`error=${encodeURIComponent(msg)}`);
  }
}

// --- LinkedIn ---

async function handleLinkedInCallback(
  supabase: ReturnType<typeof createClient>,
  code: string,
  redirectUri: string,
) {
  const clientId = Deno.env.get("LINKEDIN_CLIENT_ID")!;
  const clientSecret = Deno.env.get("LINKEDIN_CLIENT_SECRET")!;

  // Exchange code for access token
  const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`LinkedIn token exchange failed: ${errText}`);
  }

  const tokenData = await tokenRes.json();
  // LinkedIn access tokens are valid for 60 days, refresh tokens for 365 days
  const expiresAt = new Date(
    Date.now() + (tokenData.expires_in || 5184000) * 1000,
  ).toISOString();

  // Get organization info if available
  let pageId: string | null = null;
  try {
    const orgRes = await fetch(
      "https://api.linkedin.com/rest/organizationAcls?q=roleAssignee",
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          "Linkedin-Version": "202604",
          "X-Restli-Protocol-Version": "2.0.0",
        },
      },
    );
    if (orgRes.ok) {
      const orgData = await orgRes.json();
      const firstOrg = orgData.elements?.[0];
      if (firstOrg?.organization) {
        // Extract org ID from URN like "urn:li:organization:12345"
        pageId = firstOrg.organization.replace("urn:li:organization:", "");
      }
    }
  } catch (e) {
    console.warn("Could not fetch LinkedIn organizations:", e);
  }

  await supabase.from("social_tokens").upsert(
    {
      platform: "linkedin",
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || null,
      expires_at: expiresAt,
      page_id: pageId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "platform" },
  );
}

// --- Facebook ---

async function handleFacebookCallback(
  supabase: ReturnType<typeof createClient>,
  code: string,
  redirectUri: string,
) {
  const appId = Deno.env.get("FACEBOOK_APP_ID")!;
  const appSecret = Deno.env.get("FACEBOOK_APP_SECRET")!;

  // Step 1: Exchange code for short-lived token
  const tokenUrl = new URL("https://graph.facebook.com/v25.0/oauth/access_token");
  tokenUrl.searchParams.set("client_id", appId);
  tokenUrl.searchParams.set("client_secret", appSecret);
  tokenUrl.searchParams.set("redirect_uri", redirectUri);
  tokenUrl.searchParams.set("code", code);

  const tokenRes = await fetch(tokenUrl.toString());
  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Facebook token exchange failed: ${errText}`);
  }

  const { access_token: shortToken } = await tokenRes.json();

  // Step 2: Exchange for long-lived token (60 days)
  const longUrl = new URL("https://graph.facebook.com/v25.0/oauth/access_token");
  longUrl.searchParams.set("grant_type", "fb_exchange_token");
  longUrl.searchParams.set("client_id", appId);
  longUrl.searchParams.set("client_secret", appSecret);
  longUrl.searchParams.set("fb_exchange_token", shortToken);

  const longRes = await fetch(longUrl.toString());
  if (!longRes.ok) {
    const errText = await longRes.text();
    throw new Error(`Facebook long-lived token exchange failed: ${errText}`);
  }

  const longData = await longRes.json();
  const userToken = longData.access_token;
  const expiresAt = new Date(
    Date.now() + (longData.expires_in || 5184000) * 1000,
  ).toISOString();

  // Step 3: Get page access token (never expires if user token is long-lived)
  const pagesRes = await fetch(
    "https://graph.facebook.com/v25.0/me/accounts",
    { headers: { Authorization: `Bearer ${userToken}` } },
  );

  let pageId: string | null = null;
  let pageToken = userToken;

  if (pagesRes.ok) {
    const pagesData = await pagesRes.json();
    const firstPage = pagesData.data?.[0];
    if (firstPage) {
      pageId = firstPage.id;
      pageToken = firstPage.access_token; // Page token (long-lived, non-expiring)
    }
  }

  // Step 4: Get Instagram Business Account ID
  let igAccountId: string | null = null;
  if (pageId) {
    try {
      const igRes = await fetch(
        `https://graph.facebook.com/v25.0/${pageId}?fields=instagram_business_account`,
        { headers: { Authorization: `Bearer ${pageToken}` } },
      );
      if (igRes.ok) {
        const igData = await igRes.json();
        igAccountId = igData.instagram_business_account?.id || null;
      }
    } catch (e) {
      console.warn("Could not fetch Instagram account:", e);
    }
  }

  // Save Facebook page token
  await supabase.from("social_tokens").upsert(
    {
      platform: "facebook_page",
      access_token: pageToken,
      refresh_token: null, // Page tokens don't expire when derived from long-lived user token
      expires_at: expiresAt,
      page_id: pageId,
      account_id: igAccountId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "platform" },
  );
}

// --- Helpers ---

function redirectToDashboard(query: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${DASHBOARD_URL}/accounts?${query}`,
      ...corsHeaders,
    },
  });
}
