import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";

interface Job {
  id: string;
  job_title: string;
  company_name: string;
  created_at: string;
  social_posts: {
    id: string;
    platform: string;
    status: string;
    image_url: string | null;
  }[];
}

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  approved: "bg-blue-100 text-blue-800",
  posting: "bg-purple-100 text-purple-800",
  posted: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

const PLATFORM_LABELS: Record<string, string> = {
  linkedin: "LinkedIn",
  facebook_page: "Facebook",
  instagram: "Instagram",
};

type StatusFilter = "all" | "pending" | "approved" | "posted" | "failed";

export default function Dashboard() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StatusFilter>("all");

  const fetchJobs = async () => {
    const { data, error } = await supabase
      .from("jobs")
      .select(
        "id, job_title, company_name, created_at, social_posts(id, platform, status, image_url)"
      )
      .order("created_at", { ascending: false });

    if (!error && data) {
      setJobs(data as Job[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchJobs();

    const channel = supabase
      .channel("social_posts_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "social_posts" },
        () => fetchJobs()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const filteredJobs =
    filter === "all"
      ? jobs
      : jobs.filter((j) =>
          j.social_posts.some((p) => p.status === filter)
        );

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-zyntern-purple" />
      </div>
    );
  }

  const failedCount = jobs.reduce(
    (n, j) => n + j.social_posts.filter((p) => p.status === "failed").length,
    0,
  );

  return (
    <div>
      {failedCount > 0 && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2">
          <span className="text-red-600 font-semibold text-sm">
            {failedCount} sikertelen posztolás
          </span>
          <span className="text-red-500 text-sm">
            — nyisd meg a részleteket az újrapróbáláshoz
          </span>
        </div>
      )}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Posztok</h1>
        <div className="flex gap-2 flex-wrap">
          {(["all", "pending", "approved", "posted", "failed"] as const).map(
            (s) => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                className={`px-3 py-1 rounded-full text-sm font-medium transition ${
                  filter === s
                    ? "bg-zyntern-purple text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {s === "all" ? "Mind" : s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            )
          )}
        </div>
      </div>

      {filteredJobs.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <p className="text-lg">Nincs megjeleníthető poszt</p>
          <p className="text-sm mt-1">
            Új posztok automatikusan megjelennek itt
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          {filteredJobs.map((job) => {
            const imageUrl = job.social_posts.find((p) => p.image_url)?.image_url;
            return (
              <Link
                key={job.id}
                to={`/job/${job.id}`}
                className="bg-white rounded-xl border border-gray-200 p-4 hover:shadow-md transition flex gap-4 items-center"
              >
                {imageUrl ? (
                  <img
                    src={imageUrl}
                    alt=""
                    className="w-20 h-20 rounded-lg object-cover flex-shrink-0"
                  />
                ) : (
                  <div className="w-20 h-20 rounded-lg bg-gradient-to-br from-zyntern-deep to-zyntern-magenta flex-shrink-0" />
                )}

                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-gray-900 truncate">
                    {job.job_title}
                  </h3>
                  <p className="text-sm text-gray-500">{job.company_name}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {new Date(job.created_at).toLocaleDateString("hu-HU", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>

                <div className="flex gap-2 flex-shrink-0 flex-wrap justify-end">
                  {job.social_posts.map((p) => (
                    <span
                      key={p.id}
                      className={`text-xs font-medium px-2 py-1 rounded-full ${
                        STATUS_COLORS[p.status] || "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {PLATFORM_LABELS[p.platform] || p.platform}
                    </span>
                  ))}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
