import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";

interface QueuedPost {
  id: string;
  platform: string;
  original_text: string;
  modified_text: string | null;
  scheduled_at: string | null;
  priority: number;
  jobs: {
    id: string;
    job_title: string;
    company_name: string;
  };
}

const PLATFORM_LABELS: Record<string, string> = {
  linkedin: "LinkedIn",
  facebook_page: "Facebook",
  instagram: "Instagram",
};

export default function Queue() {
  const [posts, setPosts] = useState<QueuedPost[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchQueue = async () => {
    const { data, error } = await supabase
      .from("social_posts")
      .select("id, platform, original_text, modified_text, scheduled_at, priority, jobs(id, job_title, company_name)")
      .eq("status", "queued")
      .order("priority", { ascending: false })
      .order("scheduled_at", { ascending: true });

    if (!error && data) {
      setPosts(data as unknown as QueuedPost[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchQueue();

    const channel = supabase
      .channel("queue_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "social_posts" },
        () => fetchQueue()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const updatePriority = async (postId: string, delta: number) => {
    const post = posts.find((p) => p.id === postId);
    if (!post) return;
    const newPriority = (post.priority || 0) + delta;
    await supabase.rpc("update_post_priority", {
      p_post_id: postId,
      p_priority: newPriority,
    });
    await fetchQueue();
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-zyntern-purple" />
      </div>
    );
  }

  const platforms = ["linkedin", "facebook_page", "instagram"] as const;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Közzétételi sor</h1>
        <span className="text-sm text-gray-500">
          {posts.length} poszt a sorban
        </span>
      </div>

      {posts.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <p className="text-lg">A sor üres</p>
          <p className="text-sm mt-1">
            Jóváhagyott posztok automatikusan bekerülnek a sorba
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {platforms.map((platform) => {
            const platformPosts = posts.filter((p) => p.platform === platform && p.jobs);
            if (platformPosts.length === 0) return null;

            return (
              <div key={platform}>
                <h2 className="text-lg font-semibold text-gray-700 mb-3 flex items-center gap-2">
                  {PLATFORM_LABELS[platform]}
                  <span className="text-sm font-normal text-gray-400">
                    ({platformPosts.length})
                  </span>
                </h2>
                <div className="space-y-2">
                  {platformPosts.map((post, index) => (
                    <div
                      key={post.id}
                      className="bg-white rounded-lg border border-gray-200 p-4 flex items-center gap-4"
                    >
                      <div className="flex flex-col gap-1">
                        <button
                          onClick={() => updatePriority(post.id, 1)}
                          className="text-gray-400 hover:text-zyntern-purple text-xs"
                          title="Prioritás növelése"
                        >
                          ▲
                        </button>
                        <span className="text-xs text-gray-500 text-center">
                          {index + 1}
                        </span>
                        <button
                          onClick={() => updatePriority(post.id, -1)}
                          className="text-gray-400 hover:text-zyntern-purple text-xs"
                          title="Prioritás csökkentése"
                        >
                          ▼
                        </button>
                      </div>

                      <div className="flex-1 min-w-0">
                        <Link
                          to={`/job/${post.jobs.id}`}
                          className="font-medium text-gray-900 hover:text-zyntern-purple truncate block"
                        >
                          {post.jobs.job_title}
                        </Link>
                        <p className="text-sm text-gray-500 truncate">
                          {post.jobs.company_name}
                        </p>
                      </div>

                      <div className="text-right flex-shrink-0">
                        {post.scheduled_at ? (
                          <p className="text-sm text-indigo-600">
                            {new Date(post.scheduled_at).toLocaleString("hu-HU", {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </p>
                        ) : (
                          <p className="text-sm text-gray-400">Nincs ütemezve</p>
                        )}
                        <p className="text-xs text-gray-400">
                          Prioritás: {post.priority || 0}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
