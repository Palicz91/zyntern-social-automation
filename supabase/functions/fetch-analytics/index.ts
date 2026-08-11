import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret || req.headers.get("x-cron-secret") !== cronSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  const today = new Date().toISOString().split("T")[0];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Get all posts published in the last 30 days
  const { data: posts, error: postsErr } = await supabase
    .from("social_posts")
    .select("id, platform, platform_post_id, job_id")
    .eq("status", "posted")
    .gte("posted_at", thirtyDaysAgo)
    .not("platform_post_id", "is", null);

  if (postsErr) {
    console.error("Failed to fetch posts:", postsErr);
    return new Response(
      JSON.stringify({ status: "error", message: postsErr.message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!posts?.length) {
    console.log("No posted posts in last 30 days");
    return new Response(
      JSON.stringify({ status: "ok", fetched: 0 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // Get tokens for API access
  const { data: tokens, error: tokensErr } = await supabase
    .from("social_tokens")
    .select("platform, access_token, page_id, account_id");

  if (tokensErr) {
    console.error("Failed to fetch tokens:", tokensErr);
  }

  const tokenMap = new Map(
    (tokens || []).map((t: { platform: string; access_token: string; page_id: string | null; account_id: string | null }) => [t.platform, t]),
  );

  let fetched = 0;
  let errors = 0;

  for (const post of posts) {
    try {
      let analytics: {
        impressions: number;
        reach: number;
        clicks: number;
        likes: number;
        comments: number;
        shares: number;
      } | null = null;

      const tokenKey = post.platform === "instagram" ? "facebook_page" : post.platform;
      const token = tokenMap.get(tokenKey) as { access_token: string; page_id: string | null; account_id: string | null } | undefined;

      if (!token) {
        continue;
      }

      switch (post.platform) {
        case "facebook_page":
          analytics = await fetchFacebookInsights(
            token.access_token,
            post.platform_post_id,
          );
          break;
        case "instagram":
          analytics = await fetchInstagramInsights(
            token.access_token,
            post.platform_post_id,
          );
          break;
        case "linkedin":
          // LinkedIn analytics requires additional OAuth scopes (r_organization_social)
          // Deferred to Track A — log for visibility
          console.log(`LinkedIn analytics deferred: ${post.platform_post_id}`);
          continue;
      }

      if (analytics) {
        const { error: upsertErr } = await supabase
          .from("post_analytics")
          .upsert(
            {
              social_post_id: post.id,
              fetched_date: today,
              fetched_at: new Date().toISOString(),
              ...analytics,
            },
            { onConflict: "social_post_id,fetched_date" },
          );

        if (upsertErr) {
          console.error(`Analytics upsert failed for ${post.id}:`, upsertErr);
          errors++;
        } else {
          fetched++;
        }
      }
    } catch (err) {
      console.error(`Failed to fetch analytics for ${post.id}:`, err);
      errors++;
    }
  }

  console.log(`Analytics fetch done: ${fetched} updated, ${errors} errors`);

  return new Response(
    JSON.stringify({ status: "ok", fetched, errors, total: posts.length }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});

async function fetchFacebookInsights(
  accessToken: string,
  postId: string,
): Promise<{
  impressions: number;
  reach: number;
  clicks: number;
  likes: number;
  comments: number;
  shares: number;
} | null> {
  const apiVersion = "v25.0";

  // Get basic post metrics
  const metricsRes = await fetch(
    `https://graph.facebook.com/${apiVersion}/${postId}?fields=insights.metric(post_impressions,post_reach,post_clicks,post_reactions_by_type_total),comments.summary(true),shares&access_token=${accessToken}`,
  );

  if (!metricsRes.ok) {
    console.warn(`Facebook insights ${metricsRes.status} for ${postId}`);
    return null;
  }

  const data = await metricsRes.json();

  // deno-lint-ignore no-explicit-any
  const insightsMap = new Map<string, any>();
  if (data.insights?.data) {
    for (const metric of data.insights.data) {
      insightsMap.set(metric.name, metric.values?.[0]?.value ?? 0);
    }
  }

  const reactions = insightsMap.get("post_reactions_by_type_total");
  let totalLikes = 0;
  if (reactions && typeof reactions === "object") {
    totalLikes = Object.values(reactions as Record<string, number>).reduce(
      (a: number, b: number) => a + b,
      0,
    );
  } else if (typeof reactions === "number") {
    totalLikes = reactions;
  }

  return {
    impressions: Number(insightsMap.get("post_impressions")) || 0,
    reach: Number(insightsMap.get("post_reach")) || 0,
    clicks: Number(insightsMap.get("post_clicks")) || 0,
    likes: totalLikes,
    comments: data.comments?.summary?.total_count || 0,
    shares: data.shares?.count || 0,
  };
}

async function fetchInstagramInsights(
  accessToken: string,
  mediaId: string,
): Promise<{
  impressions: number;
  reach: number;
  clicks: number;
  likes: number;
  comments: number;
  shares: number;
} | null> {
  const apiVersion = "v25.0";

  const insightsRes = await fetch(
    `https://graph.facebook.com/${apiVersion}/${mediaId}/insights?metric=impressions,reach,saved&access_token=${accessToken}`,
  );

  if (!insightsRes.ok) {
    console.warn(`Instagram insights ${insightsRes.status} for ${mediaId}`);
    return null;
  }

  const insightsData = await insightsRes.json();
  const insightsMap = new Map<string, number>();
  if (insightsData.data) {
    for (const metric of insightsData.data) {
      insightsMap.set(metric.name, metric.values?.[0]?.value ?? 0);
    }
  }

  // Get likes and comments from media endpoint
  const mediaRes = await fetch(
    `https://graph.facebook.com/${apiVersion}/${mediaId}?fields=like_count,comments_count&access_token=${accessToken}`,
  );

  let likes = 0;
  let comments = 0;
  if (mediaRes.ok) {
    const mediaData = await mediaRes.json();
    likes = mediaData.like_count || 0;
    comments = mediaData.comments_count || 0;
  }

  return {
    impressions: insightsMap.get("impressions") || 0,
    reach: insightsMap.get("reach") || 0,
    clicks: 0, // Instagram doesn't provide link clicks for feed posts
    likes,
    comments,
    shares: Number(insightsMap.get("saved")) || 0, // Instagram has no shares API; using saves as closest proxy
  };
}
