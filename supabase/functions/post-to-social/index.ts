import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    return respond(405, { error: "Method not allowed" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { social_post_id } = await req.json();
    if (!social_post_id) {
      return respond(400, { error: "social_post_id required" });
    }

    // Fetch social post + job
    const { data: post, error: postErr } = await supabase
      .from("social_posts")
      .select("*, jobs(*)")
      .eq("id", social_post_id)
      .single();

    if (postErr || !post) {
      return respond(404, { error: "Post not found" });
    }

    if (post.status !== "approved") {
      return respond(400, {
        error: `Post status is '${post.status}', expected 'approved'`,
      });
    }

    // Set status to posting
    await supabase
      .from("social_posts")
      .update({ status: "posting" })
      .eq("id", social_post_id);

    const text = post.modified_text !== null ? post.modified_text : post.original_text;
    const job = post.jobs;

    // Get platform token
    const platformKey =
      post.platform === "instagram" ? "facebook_page" : post.platform;
    const { data: token } = await supabase
      .from("social_tokens")
      .select("*")
      .eq("platform", platformKey)
      .maybeSingle();

    if (!token) {
      // DRY_RUN mode — no token configured
      const dryRunLog = buildDryRunLog(post.platform, text, post.image_url, job);
      console.log(`[DRY_RUN] ${post.platform}:`, dryRunLog);

      await supabase
        .from("social_posts")
        .update({
          status: "failed",
          error_message: `Nincs bekötött ${post.platform} fiók`,
          retry_count: 3, // Skip retries for missing token
        })
        .eq("id", social_post_id);

      return respond(200, {
        status: "dry_run",
        message: `Nincs bekötött ${post.platform} fiók`,
        dry_run_payload: dryRunLog,
      });
    }

    // Attempt posting
    try {
      let platformPostId: string | null = null;

      switch (post.platform) {
        case "linkedin":
          platformPostId = await postToLinkedIn(
            token,
            text,
            post.image_url,
            job.job_url
          );
          break;
        case "facebook_page":
          platformPostId = await postToFacebookPage(
            token,
            text,
            post.image_url
          );
          break;
        case "instagram":
          platformPostId = await postToInstagram(
            token,
            text,
            post.image_url,
            job.job_url
          );
          break;
        default:
          throw new Error(`Unknown platform: ${post.platform}`);
      }

      await supabase
        .from("social_posts")
        .update({
          status: "posted",
          platform_post_id: platformPostId,
          posted_at: new Date().toISOString(),
          error_message: null,
        })
        .eq("id", social_post_id);

      return respond(200, {
        status: "posted",
        platform_post_id: platformPostId,
      });
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Unknown error";
      const newRetryCount = (post.retry_count || 0) + 1;
      const isFinal = newRetryCount >= 3;

      // Exponential backoff: 1min, 5min, 15min
      const retryDelays = [60, 300, 900]; // seconds
      const nextRetryAt = isFinal
        ? null
        : new Date(
            Date.now() + (retryDelays[newRetryCount - 1] || 900) * 1000,
          ).toISOString();

      await supabase
        .from("social_posts")
        .update({
          status: "failed",
          error_message: errorMsg,
          retry_count: newRetryCount,
          next_retry_at: nextRetryAt,
        })
        .eq("id", social_post_id);

      console.error(
        `[${post.platform}] Post failed (attempt ${newRetryCount}/3):`,
        errorMsg,
        nextRetryAt ? `Next retry at ${nextRetryAt}` : "Final failure",
      );

      return respond(isFinal ? 200 : 200, {
        status: isFinal ? "failed" : "retry_scheduled",
        error: errorMsg,
        retry_count: newRetryCount,
      });
    }
  } catch (err) {
    console.error("Unhandled error:", err);
    return respond(500, { error: "Internal server error" });
  }
});

// --- Platform implementations ---

async function postToLinkedIn(
  token: { access_token: string; page_id: string | null },
  text: string,
  imageUrl: string | null,
  _jobUrl: string
): Promise<string> {
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    "Content-Type": "application/json",
    "Linkedin-Version": "202604",
    "X-Restli-Protocol-Version": "2.0.0",
  };

  let author: string;
  if (token.page_id) {
    author = `urn:li:organization:${token.page_id}`;
  } else {
    // Fetch person URN from /me
    const meRes = await fetch("https://api.linkedin.com/rest/me", { headers });
    if (!meRes.ok) throw new Error(`LinkedIn /me failed: ${meRes.status}`);
    const meData = await meRes.json();
    author = `urn:li:person:${meData.id}`;
  }

  let imageUrn: string | undefined;

  // Upload image if available
  if (imageUrl) {
    try {
      // Step 1: Initialize upload
      const initRes = await fetch(
        "https://api.linkedin.com/rest/images?action=initializeUpload",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            initializeUploadRequest: {
              owner: author,
            },
          }),
        }
      );

      if (initRes.ok) {
        const initData = await initRes.json();
        const uploadUrl = initData.value?.uploadUrl;
        imageUrn = initData.value?.image;

        if (uploadUrl && imageUrn) {
          // Step 2: Download image
          const imgRes = await fetch(imageUrl);
          const imgBlob = await imgRes.blob();

          // Step 3: Upload to LinkedIn
          await fetch(uploadUrl, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token.access_token}`,
              "Content-Type": "image/png",
            },
            body: imgBlob,
          });
        }
      }
    } catch (e) {
      console.warn("LinkedIn image upload failed, posting without image:", e);
      imageUrn = undefined;
    }
  }

  // Create post using Posts API
  const postBody: Record<string, unknown> = {
    author,
    commentary: text,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
    },
    lifecycleState: "PUBLISHED",
  };

  if (imageUrn) {
    postBody.content = {
      media: {
        id: imageUrn,
      },
    };
  }

  const res = await fetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers,
    body: JSON.stringify(postBody),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LinkedIn API ${res.status}: ${errText}`);
  }

  // Posts API returns the post URN in the x-restli-id header
  const postUrn = res.headers.get("x-restli-id") || "unknown";
  return postUrn;
}

async function postToFacebookPage(
  token: { access_token: string; page_id: string | null },
  text: string,
  imageUrl: string | null
): Promise<string> {
  const pageId = token.page_id;
  if (!pageId) throw new Error("Facebook page_id not configured");

  const apiVersion = "v25.0";
  let endpoint: string;
  const params = new URLSearchParams({
    access_token: token.access_token,
    message: text,
  });

  if (imageUrl) {
    // Photo post (higher reach)
    endpoint = `https://graph.facebook.com/${apiVersion}/${pageId}/photos`;
    params.set("url", imageUrl);
  } else {
    // Text-only post
    endpoint = `https://graph.facebook.com/${apiVersion}/${pageId}/feed`;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(
      `Facebook API ${res.status}: ${
        errData?.error?.message || JSON.stringify(errData)
      }`
    );
  }

  const data = await res.json();
  return data.id || data.post_id || "unknown";
}

async function postToInstagram(
  token: { access_token: string; account_id: string | null },
  text: string,
  imageUrl: string | null,
  jobUrl: string
): Promise<string> {
  const igAccountId = token.account_id;
  if (!igAccountId) throw new Error("Instagram account_id not configured");
  if (!imageUrl) throw new Error("Instagram requires an image");

  const apiVersion = "v25.0";

  // Step 1: Create media container
  const containerParams = new URLSearchParams({
    access_token: token.access_token,
    image_url: imageUrl,
    caption: text,
  });

  const containerRes = await fetch(
    `https://graph.facebook.com/${apiVersion}/${igAccountId}/media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: containerParams.toString(),
    }
  );

  if (!containerRes.ok) {
    const errData = await containerRes.json().catch(() => ({}));
    throw new Error(
      `Instagram container ${containerRes.status}: ${
        errData?.error?.message || JSON.stringify(errData)
      }`
    );
  }

  const { id: containerId } = await containerRes.json();

  // Step 2: Publish
  const publishParams = new URLSearchParams({
    access_token: token.access_token,
    creation_id: containerId,
  });

  const publishRes = await fetch(
    `https://graph.facebook.com/${apiVersion}/${igAccountId}/media_publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: publishParams.toString(),
    }
  );

  if (!publishRes.ok) {
    const errData = await publishRes.json().catch(() => ({}));
    throw new Error(
      `Instagram publish ${publishRes.status}: ${
        errData?.error?.message || JSON.stringify(errData)
      }`
    );
  }

  const { id: mediaId } = await publishRes.json();

  // Step 3: Comment with job link
  try {
    const commentParams = new URLSearchParams({
      access_token: token.access_token,
      message: `Jelentkezz itt: ${jobUrl}`,
    });

    await fetch(
      `https://graph.facebook.com/${apiVersion}/${mediaId}/comments`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: commentParams.toString(),
      }
    );
  } catch (e) {
    console.warn("Instagram comment with link failed:", e);
  }

  return mediaId;
}

// --- Helpers ---

function buildDryRunLog(
  platform: string,
  text: string,
  imageUrl: string | null,
  job: { job_title: string; company_name: string; job_url: string }
) {
  switch (platform) {
    case "linkedin":
      return {
        endpoint: "POST https://api.linkedin.com/rest/posts",
        headers: { "Linkedin-Version": "202604" },
        body: {
          commentary: text.substring(0, 100) + "...",
          visibility: "PUBLIC",
          has_image: !!imageUrl,
        },
      };
    case "facebook_page":
      return {
        endpoint: imageUrl
          ? "POST https://graph.facebook.com/v25.0/{page_id}/photos"
          : "POST https://graph.facebook.com/v25.0/{page_id}/feed",
        body: {
          message: text.substring(0, 100) + "...",
          url: imageUrl || undefined,
        },
      };
    case "instagram":
      return {
        endpoint:
          "POST https://graph.facebook.com/v25.0/{ig_account_id}/media → media_publish",
        body: {
          caption: text.substring(0, 100) + "...",
          image_url: imageUrl,
          comment: `Jelentkezz itt: ${job.job_url}`,
        },
      };
    default:
      return { platform, text: text.substring(0, 100) };
  }
}

function respond(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
