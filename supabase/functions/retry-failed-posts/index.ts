import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Called by pg_cron every minute — retries failed posts with scheduled retry time

Deno.serve(async (req) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret || req.headers.get("x-cron-secret") !== cronSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  // T2.7: Reap stuck posting rows (timed out with no confirmation)
  await supabase
    .from("social_posts")
    .update({
      status: "failed",
      error_message: "Publishing timed out, no confirmation from platform",
      next_retry_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    })
    .eq("status", "posting")
    .lt("updated_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());

  // Find posts due for retry
  const { data: posts, error } = await supabase
    .from("social_posts")
    .select("id, platform, retry_count")
    .eq("status", "failed")
    .lt("retry_count", 3)
    .not("next_retry_at", "is", null)
    .lte("next_retry_at", new Date().toISOString())
    .limit(5);

  if (error || !posts || posts.length === 0) {
    return new Response(
      JSON.stringify({ status: "ok", retried: 0 }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  const results: { id: string; platform: string; result: string }[] = [];

  for (const post of posts) {
    try {
      // Set status to approved to allow post-to-social to process it
      await supabase
        .from("social_posts")
        .update({ status: "approved", next_retry_at: null })
        .eq("id", post.id);

      // Call post-to-social
      const res = await fetch(
        `${supabaseUrl}/functions/v1/post-to-social`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({ social_post_id: post.id }),
        },
      );

      const data = await res.json();
      results.push({
        id: post.id,
        platform: post.platform,
        result: data.status || "unknown",
      });
    } catch (err) {
      // T2.6: Restore failed status so the post isn't stranded at "approved"
      await supabase
        .from("social_posts")
        .update({
          status: "failed",
          error_message: err instanceof Error ? err.message : "Retry fetch failed",
          next_retry_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        })
        .eq("id", post.id);

      const msg = err instanceof Error ? err.message : "unknown";
      results.push({ id: post.id, platform: post.platform, result: `error: ${msg}` });
    }
  }

  console.log(`Retried ${results.length} posts:`, results);

  return new Response(
    JSON.stringify({ status: "ok", retried: results.length, results }),
    { headers: { "Content-Type": "application/json" } },
  );
});
