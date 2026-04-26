import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "../lib/supabase";

interface SocialPost {
  id: string;
  platform: string;
  original_text: string;
  modified_text: string | null;
  image_url: string | null;
  status: string;
  approved_by: string | null;
  approved_at: string | null;
  posted_at: string | null;
  error_message: string | null;
}

interface Job {
  id: string;
  job_title: string;
  company_name: string;
  category: string | null;
  location: string;
  job_url: string;
  created_at: string;
}

const PLATFORM_LABELS: Record<string, string> = {
  linkedin: "LinkedIn",
  facebook_page: "Facebook",
  instagram: "Instagram",
};

const PLATFORM_ICONS: Record<string, string> = {
  linkedin: "in",
  facebook_page: "f",
  instagram: "ig",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800 border-yellow-200",
  approved: "bg-blue-100 text-blue-800 border-blue-200",
  posting: "bg-purple-100 text-purple-800 border-purple-200",
  posted: "bg-green-100 text-green-800 border-green-200",
  failed: "bg-red-100 text-red-800 border-red-200",
};

export default function JobDetail() {
  const { jobId } = useParams<{ jobId: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [activeTab, setActiveTab] = useState("linkedin");
  const [editTexts, setEditTexts] = useState<Record<string, string>>({});
  const [showOriginal, setShowOriginal] = useState<Record<string, boolean>>({});
  const [approving, setApproving] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    if (!jobId) return;

    const [jobRes, postsRes] = await Promise.all([
      supabase.from("jobs").select("*").eq("id", jobId).single(),
      supabase
        .from("social_posts")
        .select("*")
        .eq("job_id", jobId)
        .order("platform"),
    ]);

    if (jobRes.data) setJob(jobRes.data);
    if (postsRes.data) {
      setPosts(postsRes.data);
      const texts: Record<string, string> = {};
      postsRes.data.forEach((p: SocialPost) => {
        texts[p.platform] = p.modified_text || p.original_text;
      });
      setEditTexts(texts);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchData();

    const channel = supabase
      .channel(`post_updates_${jobId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "social_posts",
          filter: `job_id=eq.${jobId}`,
        },
        (payload) => {
          setPosts((prev) =>
            prev.map((p) =>
              p.id === payload.new.id ? { ...p, ...payload.new } : p
            )
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [jobId]);

  const approvePost = async (post: SocialPost) => {
    setApproving(post.id);
    const currentText = editTexts[post.platform];
    const isModified = currentText !== post.original_text;

    // 1. Update DB status to approved
    await supabase
      .from("social_posts")
      .update({
        status: "approved",
        modified_text: isModified ? currentText : null,
        approved_by: "dashboard",
        approved_at: new Date().toISOString(),
      })
      .eq("id", post.id);

    // 2. Trigger posting via Edge Function
    try {
      await supabase.functions.invoke("post-to-social", {
        body: { social_post_id: post.id },
      });
    } catch (err) {
      console.error("Post-to-social call failed:", err);
    }

    setApproving(null);
  };

  const approveAll = async () => {
    const pendingPosts = posts.filter((p) => p.status === "pending");
    for (const post of pendingPosts) {
      await approvePost(post);
    }
  };

  const retryPost = async (post: SocialPost) => {
    setApproving(post.id);
    // Reset retry count and re-approve
    await supabase
      .from("social_posts")
      .update({
        status: "approved",
        retry_count: 0,
        error_message: null,
        next_retry_at: null,
      })
      .eq("id", post.id);

    try {
      await supabase.functions.invoke("post-to-social", {
        body: { social_post_id: post.id },
      });
    } catch (err) {
      console.error("Retry failed:", err);
    }
    setApproving(null);
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-zyntern-purple" />
      </div>
    );
  }

  if (!job) {
    return (
      <div className="text-center py-20 text-gray-400">
        <p>Job nem található</p>
        <Link to="/" className="text-zyntern-purple hover:underline mt-2 block">
          Vissza
        </Link>
      </div>
    );
  }

  const activePost = posts.find((p) => p.platform === activeTab);
  const imageUrl = posts.find((p) => p.image_url)?.image_url;
  const hasPending = posts.some((p) => p.status === "pending");

  return (
    <div>
      <Link
        to="/"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-zyntern-purple mb-4"
      >
        ← Vissza
      </Link>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {/* Header */}
        <div className="p-4 sm:p-6 border-b border-gray-100">
          <h1 className="text-xl font-bold text-gray-900">{job.job_title}</h1>
          <p className="text-gray-500">
            {job.company_name} · {job.location}
          </p>
          {job.category && (
            <span className="inline-block mt-2 text-xs font-semibold bg-zyntern-purple/10 text-zyntern-purple px-2 py-1 rounded-full uppercase">
              {job.category}
            </span>
          )}
        </div>

        <div className="flex flex-col lg:flex-row">
          {/* Left: Image */}
          <div className="lg:w-80 p-4 sm:p-6 flex-shrink-0 border-b lg:border-b-0 lg:border-r border-gray-100">
            {imageUrl ? (
              <img
                src={imageUrl}
                alt="Job card"
                className="w-full rounded-lg shadow-sm"
              />
            ) : (
              <div className="w-full aspect-square rounded-lg bg-gradient-to-br from-zyntern-deep to-zyntern-magenta flex items-center justify-center text-white text-sm">
                Kép generálás alatt...
              </div>
            )}
          </div>

          {/* Right: Tabs + editor */}
          <div className="flex-1 min-w-0">
            {/* Platform tabs */}
            <div className="flex border-b border-gray-100">
              {posts.map((p) => (
                <button
                  key={p.platform}
                  onClick={() => setActiveTab(p.platform)}
                  className={`flex-1 px-4 py-3 text-sm font-medium transition relative ${
                    activeTab === p.platform
                      ? "text-zyntern-purple"
                      : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  <span className="inline-flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-gray-100 text-xs font-bold flex items-center justify-center">
                      {PLATFORM_ICONS[p.platform]}
                    </span>
                    {PLATFORM_LABELS[p.platform]}
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded-full ${
                        STATUS_COLORS[p.status]
                      }`}
                    >
                      {p.status}
                    </span>
                  </span>
                  {activeTab === p.platform && (
                    <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-zyntern-purple" />
                  )}
                </button>
              ))}
            </div>

            {/* Editor area */}
            {activePost && (
              <div className="p-4 sm:p-6">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-gray-700">
                    Poszt szöveg
                  </label>
                  <button
                    onClick={() =>
                      setShowOriginal((prev) => ({
                        ...prev,
                        [activeTab]: !prev[activeTab],
                      }))
                    }
                    className="text-xs text-zyntern-purple hover:underline"
                  >
                    {showOriginal[activeTab]
                      ? "Szerkesztett"
                      : "Eredeti megtekintése"}
                  </button>
                </div>

                {showOriginal[activeTab] ? (
                  <div className="w-full min-h-[200px] p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-600 whitespace-pre-wrap">
                    {activePost.original_text}
                  </div>
                ) : (
                  <textarea
                    value={editTexts[activeTab] || ""}
                    onChange={(e) =>
                      setEditTexts((prev) => ({
                        ...prev,
                        [activeTab]: e.target.value,
                      }))
                    }
                    className="w-full min-h-[200px] p-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zyntern-purple focus:border-transparent resize-y"
                    disabled={activePost.status === "posted" || activePost.status === "posting"}
                  />
                )}

                {/* Preview hint */}
                <p className="text-xs text-gray-400 mt-2">
                  {activeTab === "instagram"
                    ? "Instagram: linkek nem kattinthatók a poszt szövegében"
                    : `${PLATFORM_LABELS[activeTab]}: a link automatikusan hozzáadva`}
                </p>

                {/* Error message + retry */}
                {activePost.error_message && (
                  <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded-lg">
                    <p className="text-sm text-red-600">
                      {activePost.error_message}
                    </p>
                    {activePost.status === "failed" && (
                      <button
                        onClick={() => retryPost(activePost)}
                        disabled={approving === activePost.id}
                        className="mt-2 text-sm font-medium text-red-700 hover:text-red-900 underline"
                      >
                        Újrapróbálás
                      </button>
                    )}
                  </div>
                )}

                {/* Posted info */}
                {activePost.posted_at && (
                  <p className="text-xs text-green-600 mt-2">
                    Közzétéve:{" "}
                    {new Date(activePost.posted_at).toLocaleString("hu-HU")}
                  </p>
                )}

                {/* Approve button */}
                {activePost.status === "pending" && (
                  <button
                    onClick={() => approvePost(activePost)}
                    disabled={approving === activePost.id}
                    className="mt-4 w-full sm:w-auto bg-zyntern-purple text-white px-6 py-2.5 rounded-lg font-semibold hover:bg-zyntern-deep transition disabled:opacity-50"
                  >
                    {approving === activePost.id
                      ? "Jóváhagyás..."
                      : `${PLATFORM_LABELS[activeTab]} jóváhagyása`}
                  </button>
                )}

                {activePost.status === "approved" && (
                  <p className="mt-4 text-sm text-blue-600">
                    Jóváhagyva — közzététel hamarosan
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Approve all */}
        {hasPending && (
          <div className="p-4 sm:p-6 border-t border-gray-100 bg-gray-50">
            <button
              onClick={approveAll}
              className="w-full sm:w-auto bg-zyntern-coral text-white px-8 py-3 rounded-lg font-bold hover:opacity-90 transition"
            >
              Mindet jóváhagyom
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
