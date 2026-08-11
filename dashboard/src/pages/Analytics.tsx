import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

interface PostAnalytics {
  id: string;
  impressions: number;
  reach: number;
  clicks: number;
  likes: number;
  comments: number;
  shares: number;
  fetched_date: string;
  social_posts: {
    id: string;
    platform: string;
    original_text: string;
    modified_text: string | null;
    posted_at: string;
    jobs: {
      job_title: string;
      company_name: string;
    };
  };
}

interface PlatformTotals {
  impressions: number;
  reach: number;
  clicks: number;
  likes: number;
  comments: number;
  shares: number;
  postCount: number;
}

const PLATFORM_LABELS: Record<string, string> = {
  linkedin: "LinkedIn",
  facebook_page: "Facebook",
  instagram: "Instagram",
};

export default function Analytics() {
  const [analytics, setAnalytics] = useState<PostAnalytics[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetch() {
      const { data, error } = await supabase
        .from("post_analytics")
        .select(
          "id, impressions, reach, clicks, likes, comments, shares, fetched_date, social_posts(id, platform, original_text, modified_text, posted_at, jobs(job_title, company_name))",
        )
        .order("fetched_date", { ascending: false });

      if (!error && data) {
        setAnalytics(data as unknown as PostAnalytics[]);
      }
      setLoading(false);
    }
    fetch();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-zyntern-purple" />
      </div>
    );
  }

  if (analytics.length === 0) {
    return (
      <div className="text-center py-20 text-gray-400">
        <p className="text-lg">Nincs analytics adat</p>
        <p className="text-sm mt-1">
          Az adatok automatikusan frissülnek a posztolás után
        </p>
      </div>
    );
  }

  // Get latest snapshot per post (most recent fetched_date)
  const latestByPost = new Map<string, PostAnalytics>();
  for (const a of analytics) {
    const postId = a.social_posts?.id;
    if (!postId) continue;
    const existing = latestByPost.get(postId);
    if (!existing || a.fetched_date > existing.fetched_date) {
      latestByPost.set(postId, a);
    }
  }

  const latestAnalytics = Array.from(latestByPost.values());

  // Platform totals
  const platformTotals = new Map<string, PlatformTotals>();
  for (const a of latestAnalytics) {
    const platform = a.social_posts?.platform;
    if (!platform) continue;
    const t = platformTotals.get(platform) || {
      impressions: 0,
      reach: 0,
      clicks: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      postCount: 0,
    };
    t.impressions += a.impressions;
    t.reach += a.reach;
    t.clicks += a.clicks;
    t.likes += a.likes;
    t.comments += a.comments;
    t.shares += a.shares;
    t.postCount++;
    platformTotals.set(platform, t);
  }

  // Edited vs unedited comparison
  const edited = latestAnalytics.filter(
    (a) => a.social_posts?.modified_text && a.social_posts.modified_text !== a.social_posts.original_text,
  );
  const unedited = latestAnalytics.filter(
    (a) => !a.social_posts?.modified_text || a.social_posts.modified_text === a.social_posts.original_text,
  );

  const avgMetric = (list: PostAnalytics[], key: keyof PostAnalytics) =>
    list.length > 0
      ? Math.round(
          list.reduce((s, a) => s + ((a[key] as number) || 0), 0) / list.length,
        )
      : 0;

  // Sort by clicks desc for table
  const sortedPosts = [...latestAnalytics]
    .filter((a) => a.social_posts)
    .sort((a, b) => b.clicks - a.clicks);

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Analytics</h1>

      {/* Platform summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        {["linkedin", "facebook_page", "instagram"].map((platform) => {
          const t = platformTotals.get(platform);
          if (!t) return null;

          return (
            <div
              key={platform}
              className="bg-white rounded-xl border border-gray-200 p-5"
            >
              <h3 className="font-semibold text-gray-900 mb-3">
                {PLATFORM_LABELS[platform]}
              </h3>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-gray-500">Elérés</p>
                  <p className="text-xl font-bold text-gray-900">
                    {t.reach.toLocaleString("hu-HU")}
                  </p>
                </div>
                <div>
                  <p className="text-gray-500">Kattintás</p>
                  <p className="text-xl font-bold text-zyntern-purple">
                    {t.clicks.toLocaleString("hu-HU")}
                  </p>
                </div>
                <div>
                  <p className="text-gray-500">Like</p>
                  <p className="font-semibold">{t.likes.toLocaleString("hu-HU")}</p>
                </div>
                <div>
                  <p className="text-gray-500">Komment</p>
                  <p className="font-semibold">
                    {t.comments.toLocaleString("hu-HU")}
                  </p>
                </div>
              </div>
              <p className="text-xs text-gray-400 mt-3">
                {t.postCount} poszt
              </p>
            </div>
          );
        })}
      </div>

      {/* Edited vs Unedited comparison */}
      {edited.length > 0 && unedited.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 mb-8">
          <h3 className="font-semibold text-gray-900 mb-3">
            Szerkesztett vs. eredeti szöveg
          </h3>
          <div className="grid grid-cols-2 gap-6">
            <div>
              <p className="text-sm text-gray-500 mb-2">
                Szerkesztett ({edited.length} poszt)
              </p>
              <div className="space-y-1 text-sm">
                <p>
                  Avg elérés: <strong>{avgMetric(edited, "reach")}</strong>
                </p>
                <p>
                  Avg kattintás:{" "}
                  <strong>{avgMetric(edited, "clicks")}</strong>
                </p>
                <p>
                  Avg like: <strong>{avgMetric(edited, "likes")}</strong>
                </p>
              </div>
            </div>
            <div>
              <p className="text-sm text-gray-500 mb-2">
                Eredeti ({unedited.length} poszt)
              </p>
              <div className="space-y-1 text-sm">
                <p>
                  Avg elérés: <strong>{avgMetric(unedited, "reach")}</strong>
                </p>
                <p>
                  Avg kattintás:{" "}
                  <strong>{avgMetric(unedited, "clicks")}</strong>
                </p>
                <p>
                  Avg like: <strong>{avgMetric(unedited, "likes")}</strong>
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Per-post table sorted by clicks */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="p-5 border-b border-gray-100">
          <h3 className="font-semibold text-gray-900">
            Top posztok kattintás szerint
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Poszt</th>
                <th className="text-left px-4 py-2 font-medium">Platform</th>
                <th className="text-right px-4 py-2 font-medium">Elérés</th>
                <th className="text-right px-4 py-2 font-medium">Kattintás</th>
                <th className="text-right px-4 py-2 font-medium">Like</th>
                <th className="text-right px-4 py-2 font-medium">Komment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sortedPosts.slice(0, 20).map((a) => (
                <tr key={a.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 max-w-[200px]">
                    <p className="font-medium text-gray-900 truncate">
                      {a.social_posts.jobs?.job_title || "—"}
                    </p>
                    <p className="text-xs text-gray-400 truncate">
                      {a.social_posts.jobs?.company_name || "—"}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {PLATFORM_LABELS[a.social_posts.platform] ||
                      a.social_posts.platform}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-900">
                    {a.reach.toLocaleString("hu-HU")}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-zyntern-purple">
                    {a.clicks.toLocaleString("hu-HU")}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-900">
                    {a.likes.toLocaleString("hu-HU")}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-900">
                    {a.comments.toLocaleString("hu-HU")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
