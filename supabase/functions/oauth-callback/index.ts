import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isFlagEnabled } from "../_shared/flags.ts";

const DASHBOARD_URL = Deno.env.get("DASHBOARD_URL") || "https://zyntern-social-dashboard.netlify.app";

Deno.serve(async (req) => {
  const url = new URL(req.url);
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

  // Validate and consume the state (single-use)
  const { data: stateRow, error: stateErr } = await supabase
    .from("oauth_states")
    .delete()
    .eq("state", state)
    .select("platform, created_at")
    .maybeSingle();

  if (stateErr || !stateRow) {
    return redirectToDashboard("error=invalid_state");
  }

  // Reject if older than 10 minutes
  const stateAge = Date.now() - new Date(stateRow.created_at).getTime();
  if (stateAge > 10 * 60 * 1000) {
    return redirectToDashboard("error=state_expired");
  }

  const platform = stateRow.platform;
  const redirectUri = Deno.env.get("OAUTH_REDIRECT_URL") ||
    `${supabaseUrl}/functions/v1/oauth-callback`;

  try {
    if (platform === "linkedin") {
      await handleLinkedInCallback(supabase, code, redirectUri);
    } else if (platform === "facebook") {
      await handleFacebookCallback(supabase, code, redirectUri);
    } else {
      return redirectToDashboard("error=invalid_platform");
    }

    return redirectToDashboard(`success=${platform}`);
  } catch (err) {
    console.error(`OAuth callback error (${platform}):`, err);
    const msg = err instanceof Error ? err.message : "unknown";
    return redirectToDashboard(`error=${encodeURIComponent(msg)}`);
  }
});

async function handleLinkedInCallback(
  supabase: ReturnType<typeof createClient>,
  code: string,
  redirectUri: string,
) {
  const clientId = Deno.env.get("LINKEDIN_CLIENT_ID")!;
  const clientSecret = Deno.env.get("LINKEDIN_CLIENT_SECRET")!;

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
  const expiresAt = new Date(
    Date.now() + (tokenData.expires_in || 5184000) * 1000,
  ).toISOString();

  const orgMode = isFlagEnabled(Deno.env.get("LINKEDIN_ORG_MODE"));

  let pageId: string | null = null;
  if (orgMode) {
    try {
      const orgRes = await fetch(
        "https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED",
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
          pageId = firstOrg.organization.replace("urn:li:organization:", "");
        }
      } else {
        // A 403 here usually means the Community Management API product is not
        // approved yet — that is a different problem from "member admins no org".
        console.warn(
          `LinkedIn organizationAcls failed: ${orgRes.status} ${await orgRes.text()}`,
        );
      }
    } catch (e) {
      console.warn("Could not fetch LinkedIn organizations:", e);
    }

    if (!pageId) {
      throw new Error(
        "LinkedIn org mode is on but no administered organization was found for this member " +
          "(check the function logs for the organizationAcls status — a 403 means the Community " +
          "Management API product is not approved yet). The existing LinkedIn connection is " +
          "unchanged, so posts keep going out on the previously connected identity.",
      );
    }
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

async function handleFacebookCallback(
  supabase: ReturnType<typeof createClient>,
  code: string,
  redirectUri: string,
) {
  const appId = Deno.env.get("FACEBOOK_APP_ID")!;
  const appSecret = Deno.env.get("FACEBOOK_APP_SECRET")!;

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

  const pagesRes = await fetch(
    "https://graph.facebook.com/v25.0/me/accounts",
    { headers: { Authorization: `Bearer ${userToken}` } },
  );

  let pageId: string | null = null;
  let pageToken = userToken;

  const preferred = (Deno.env.get("FACEBOOK_PAGE_ID") ?? "").trim();

  if (!pagesRes.ok) {
    const errText = await pagesRes.text();
    // Without this the pin below is silently skipped on exactly the path it exists for.
    if (preferred) {
      throw new Error(
        `Facebook /me/accounts failed (${pagesRes.status}), so page ${preferred} could not be verified`,
      );
    }
    console.warn(`Facebook /me/accounts failed: ${pagesRes.status} ${errText}`);
  } else {
    const pagesData = await pagesRes.json();
    const pages = pagesData.data || [];
    const firstPage = preferred
      ? pages.find((p: { id: string }) => p.id === preferred)
      : pages[0];
    if (preferred && !firstPage) {
      throw new Error(
        `Facebook page ${preferred} not found in /me/accounts for this user`,
      );
    }
    if (!firstPage) {
      console.warn(
        "Facebook connected but /me/accounts returned no pages — page_id stays null and posting will fail",
      );
    }
    if (firstPage) {
      pageId = firstPage.id;
      pageToken = firstPage.access_token;
    }
  }

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

  await supabase.from("social_tokens").upsert(
    {
      platform: "facebook_page",
      access_token: pageToken,
      refresh_token: null,
      expires_at: expiresAt,
      page_id: pageId,
      account_id: igAccountId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "platform" },
  );
}

function redirectToDashboard(query: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: `${DASHBOARD_URL}/accounts?${query}` },
  });
}
