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

  const alerts: string[] = [];

  // 1. Tokens expiring within 7 days
  const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: expiringTokens } = await supabase
    .from("social_tokens")
    .select("platform, expires_at")
    .lt("expires_at", sevenDaysFromNow)
    .gt("expires_at", new Date().toISOString());

  if (expiringTokens?.length) {
    for (const t of expiringTokens) {
      const daysLeft = Math.ceil(
        (new Date(t.expires_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
      );
      alerts.push(`⚠️ ${t.platform} token expires in ${daysLeft}d`);
    }
  }

  // 2. Expired tokens (already past)
  const { data: expiredTokens } = await supabase
    .from("social_tokens")
    .select("platform, expires_at")
    .lt("expires_at", new Date().toISOString());

  if (expiredTokens?.length) {
    for (const t of expiredTokens) {
      alerts.push(`🔴 ${t.platform} token EXPIRED (${t.expires_at})`);
    }
  }

  // 3. Failed posts with retry_count >= 3 (gave up)
  const { data: failedPosts, error: failedErr } = await supabase
    .from("social_posts")
    .select("id, platform, error_message, updated_at")
    .eq("status", "failed")
    .gte("retry_count", 3);

  if (!failedErr && failedPosts?.length) {
    alerts.push(`🔴 ${failedPosts.length} post(s) failed after max retries`);
    for (const p of failedPosts.slice(0, 5)) {
      alerts.push(`  - ${p.platform} (${p.id.slice(0, 8)}): ${p.error_message?.slice(0, 80) || "unknown"}`);
    }
  }

  // 4. Orphaned jobs (no social_posts) — jobs created >1h ago with zero posts
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: allJobs } = await supabase
    .from("jobs")
    .select("id, social_posts(id)")
    .lt("created_at", oneHourAgo);

  const orphanedCount = allJobs?.filter((j: { social_posts: unknown[] }) => j.social_posts.length === 0).length ?? 0;
  if (orphanedCount > 0) {
    alerts.push(`⚠️ ${orphanedCount} orphaned job(s) with no social posts`);
  }

  // 5. No publishes in 48 hours
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data: recentPosts } = await supabase
    .from("social_posts")
    .select("id")
    .eq("status", "posted")
    .gte("posted_at", twoDaysAgo)
    .limit(1);

  if (!recentPosts?.length) {
    alerts.push(`⚠️ No posts published in the last 48 hours`);
  }

  if (alerts.length === 0) {
    console.log("Health check passed — no alerts");
    return new Response(JSON.stringify({ status: "ok", alerts: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Send to Telegram
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");

  if (botToken && chatId) {
    const message = `🏥 Zyntern Health Alert\n\n${alerts.join("\n")}`;
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
      }),
    });
  } else {
    console.warn("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set");
  }

  console.log(`Health alert: ${alerts.length} issue(s) found`);

  return new Response(
    JSON.stringify({ status: "alert", count: alerts.length, alerts }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
