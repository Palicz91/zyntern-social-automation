import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function getLocalHourMinute(date: Date, tz: string): { hours: number; minutes: number } {
  const parts: Record<string, string> = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  })
    .formatToParts(date)
    .forEach((p) => {
      parts[p.type] = p.value;
    });
  return {
    hours: parseInt(parts.hour || "0"),
    minutes: parseInt(parts.minute || "0"),
  };
}

function getMidnightUtc(date: Date, tz: string): Date {
  const parts: Record<string, string> = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(date)
    .forEach((p) => {
      parts[p.type] = p.value;
    });

  const localNowStr = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`;
  const localNowAsUtc = new Date(localNowStr);
  const offsetMs = date.getTime() - localNowAsUtc.getTime();

  const midnightLocalStr = `${parts.year}-${parts.month}-${parts.day}T00:00:00Z`;
  const midnightLocalAsUtc = new Date(midnightLocalStr);
  return new Date(midnightLocalAsUtc.getTime() + offsetMs);
}

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

  const now = new Date();
  const results: { platform: string; processed: number; errors: string[] }[] = [];

  const { data: rules, error: rulesErr } = await supabase
    .from("posting_rules")
    .select("*")
    .eq("enabled", true);

  if (rulesErr || !rules?.length) {
    console.log("No posting rules found or error:", rulesErr);
    return new Response(
      JSON.stringify({ status: "ok", message: "No rules" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  for (const rule of rules) {
    const platformResult = {
      platform: rule.platform,
      processed: 0,
      errors: [] as string[],
    };

    // Check posting window in rule's timezone
    const local = getLocalHourMinute(now, rule.timezone);
    const currentMinutes = local.hours * 60 + local.minutes;
    const [startH, startM] = rule.window_start.split(":").map(Number);
    const [endH, endM] = rule.window_end.split(":").map(Number);
    const windowStart = startH * 60 + startM;
    const windowEnd = endH * 60 + endM;

    if (currentMinutes < windowStart || currentMinutes > windowEnd) {
      console.log(
        `${rule.platform}: outside posting window (${rule.window_start}-${rule.window_end})`,
      );
      results.push(platformResult);
      continue;
    }

    // Today's midnight in rule timezone, as UTC
    const todayStart = getMidnightUtc(now, rule.timezone);
    const tomorrowStart = new Date(todayStart.getTime() + 86400000);

    // Count today's posted + queued for this platform (day-bounded)
    const { count: postedCount } = await supabase
      .from("social_posts")
      .select("id", { count: "exact", head: true })
      .eq("platform", rule.platform)
      .in("status", ["posted", "posting", "approved"])
      .gte("posted_at", todayStart.toISOString())
      .lt("posted_at", tomorrowStart.toISOString());

    const { count: queuedCount } = await supabase
      .from("social_posts")
      .select("id", { count: "exact", head: true })
      .eq("platform", rule.platform)
      .eq("status", "queued")
      .gte("scheduled_at", todayStart.toISOString())
      .lt("scheduled_at", tomorrowStart.toISOString());

    const todayCount = (postedCount ?? 0) + (queuedCount ?? 0);

    if (todayCount >= rule.daily_cap) {
      console.log(
        `${rule.platform}: daily cap reached (${todayCount}/${rule.daily_cap})`,
      );
      results.push(platformResult);
      continue;
    }

    // Check min gap since last post
    const { data: lastPosted } = await supabase
      .from("social_posts")
      .select("posted_at")
      .eq("platform", rule.platform)
      .eq("status", "posted")
      .order("posted_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastPosted?.posted_at) {
      const gapMs = now.getTime() - new Date(lastPosted.posted_at).getTime();
      const gapMinutes = gapMs / (1000 * 60);
      if (gapMinutes < rule.min_gap_minutes) {
        console.log(
          `${rule.platform}: min gap not met (${Math.round(gapMinutes)}/${rule.min_gap_minutes} min)`,
        );
        results.push(platformResult);
        continue;
      }
    }

    // Claim the oldest queued post whose scheduled_at has passed
    const { data: nextPost, error: claimErr } = await supabase
      .from("social_posts")
      .update({ status: "approved" })
      .eq("platform", rule.platform)
      .eq("status", "queued")
      .lte("scheduled_at", now.toISOString())
      .order("priority", { ascending: false })
      .order("scheduled_at", { ascending: true })
      .limit(1)
      .select("id")
      .maybeSingle();

    if (claimErr) {
      console.error(`${rule.platform}: claim error:`, claimErr);
      platformResult.errors.push(claimErr.message);
      results.push(platformResult);
      continue;
    }

    if (!nextPost) {
      console.log(`${rule.platform}: no queued posts ready`);
      results.push(platformResult);
      continue;
    }

    // Invoke post-to-social, restore to queued on any failure
    try {
      const postRes = await fetch(
        `${supabaseUrl}/functions/v1/post-to-social`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({ social_post_id: nextPost.id }),
        },
      );

      if (!postRes.ok) {
        const errText = await postRes.text();
        console.error(
          `${rule.platform}: post-to-social failed (${postRes.status}):`,
          errText,
        );
        platformResult.errors.push(`post-to-social ${postRes.status}`);

        await supabase
          .from("social_posts")
          .update({
            status: "queued",
            scheduled_at: new Date(
              now.getTime() + rule.min_gap_minutes * 60000,
            ).toISOString(),
          })
          .eq("id", nextPost.id);
      } else {
        platformResult.processed++;
        console.log(`${rule.platform}: published ${nextPost.id}`);
      }
    } catch (err) {
      console.error(`${rule.platform}: post-to-social threw:`, err);
      platformResult.errors.push(`post-to-social network error`);

      await supabase
        .from("social_posts")
        .update({
          status: "queued",
          scheduled_at: new Date(
            now.getTime() + rule.min_gap_minutes * 60000,
          ).toISOString(),
        })
        .eq("id", nextPost.id);
    }

    results.push(platformResult);
  }

  const totalProcessed = results.reduce((n, r) => n + r.processed, 0);
  console.log(`Schedule-queue done: ${totalProcessed} post(s) processed`);

  return new Response(
    JSON.stringify({ status: "ok", processed: totalProcessed, results }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
