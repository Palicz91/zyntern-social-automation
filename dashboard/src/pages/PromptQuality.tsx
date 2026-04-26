import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

interface EditedPost {
  id: string;
  platform: string;
  original_text: string;
  modified_text: string;
  approved_at: string;
  job_title: string;
  company_name: string;
}

interface Stats {
  total: number;
  unedited: number;
  edited: number;
}

const PLATFORM_LABELS: Record<string, string> = {
  linkedin: "LinkedIn",
  facebook_page: "Facebook",
  instagram: "Instagram",
};

function wordDiff(
  original: string,
  modified: string
): { removed: string[]; added: string[]; common: string[] } {
  const a = original.split(/\s+/);
  const b = modified.split(/\s+/);

  // Simple LCS-based diff
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to build diff
  const result: { type: "common" | "removed" | "added"; word: string }[] = [];
  let i = m,
    j = n;
  const stack: typeof result = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      stack.push({ type: "common", word: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: "added", word: b[j - 1] });
      j--;
    } else {
      stack.push({ type: "removed", word: a[i - 1] });
      i--;
    }
  }

  stack.reverse();
  return {
    removed: stack.filter((s) => s.type === "removed").map((s) => s.word),
    added: stack.filter((s) => s.type === "added").map((s) => s.word),
    common: stack.filter((s) => s.type === "common").map((s) => s.word),
  };
}

function DiffView({
  original,
  modified,
}: {
  original: string;
  modified: string;
}) {
  const a = original.split(/\s+/);
  const b = modified.split(/\s+/);

  // LCS dp table
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack
  const diff: { type: "same" | "removed" | "added"; word: string }[] = [];
  let i = m,
    j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      diff.push({ type: "same", word: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.push({ type: "added", word: b[j - 1] });
      j--;
    } else {
      diff.push({ type: "removed", word: a[i - 1] });
      i--;
    }
  }
  diff.reverse();

  // Build left (original) and right (modified) spans
  const left = diff
    .filter((d) => d.type !== "added")
    .map((d, idx) => (
      <span
        key={idx}
        className={
          d.type === "removed"
            ? "bg-red-100 text-red-700 line-through"
            : ""
        }
      >
        {d.word}{" "}
      </span>
    ));

  const right = diff
    .filter((d) => d.type !== "removed")
    .map((d, idx) => (
      <span
        key={idx}
        className={d.type === "added" ? "bg-green-100 text-green-700" : ""}
      >
        {d.word}{" "}
      </span>
    ));

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
      <div>
        <p className="text-xs font-semibold text-gray-500 mb-1">
          AI generált
        </p>
        <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm leading-relaxed whitespace-pre-wrap">
          {left}
        </div>
      </div>
      <div>
        <p className="text-xs font-semibold text-gray-500 mb-1">Végleges</p>
        <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm leading-relaxed whitespace-pre-wrap">
          {right}
        </div>
      </div>
    </div>
  );
}

export default function PromptQuality() {
  const [stats, setStats] = useState<Stats>({ total: 0, unedited: 0, edited: 0 });
  const [posts, setPosts] = useState<EditedPost[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    // Stats
    const { data: allPosts } = await supabase
      .from("social_posts")
      .select("modified_text, status")
      .in("status", ["approved", "posted"]);

    if (allPosts) {
      const total = allPosts.length;
      const edited = allPosts.filter((p) => p.modified_text !== null).length;
      setStats({ total, unedited: total - edited, edited });
    }

    // Edited posts with job info
    const { data: editedPosts } = await supabase
      .from("social_posts")
      .select("id, platform, original_text, modified_text, approved_at, jobs(job_title, company_name)")
      .not("modified_text", "is", null)
      .in("status", ["approved", "posted"])
      .order("approved_at", { ascending: false });

    if (editedPosts) {
      setPosts(
        editedPosts.map((p: any) => ({
          id: p.id,
          platform: p.platform,
          original_text: p.original_text,
          modified_text: p.modified_text,
          approved_at: p.approved_at,
          job_title: p.jobs?.job_title || "",
          company_name: p.jobs?.company_name || "",
        }))
      );
    }

    setLoading(false);
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-zyntern-purple" />
      </div>
    );
  }

  const acceptanceRate =
    stats.total > 0 ? Math.round((stats.unedited / stats.total) * 100) : 0;

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">
        Prompt minőség
      </h1>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-sm text-gray-500">Jóváhagyott posztok</p>
          <p className="text-3xl font-bold text-gray-900 mt-1">
            {stats.total}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-sm text-gray-500">Szerkesztés nélkül</p>
          <p className="text-3xl font-bold text-green-600 mt-1">
            {stats.unedited}
          </p>
          <p className="text-sm text-green-600 mt-1">
            {acceptanceRate}% first-try
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-sm text-gray-500">Szerkesztve</p>
          <p className="text-3xl font-bold text-zyntern-purple mt-1">
            {stats.edited}
          </p>
          <p className="text-sm text-gray-400 mt-1">
            {stats.total > 0
              ? `${100 - acceptanceRate}% szerkesztett`
              : "—"}
          </p>
        </div>
      </div>

      {/* Edited posts list */}
      <h2 className="text-lg font-semibold text-gray-900 mb-3">
        Szerkesztett posztok
      </h2>

      {posts.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p>Még nincs szerkesztett poszt</p>
          <p className="text-sm mt-1">
            A prompt-ot nem kellett módosítani — ez jó jel
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {posts.map((post) => {
            const isExpanded = expanded === post.id;
            const diff = wordDiff(post.original_text, post.modified_text);
            const changeCount = diff.removed.length + diff.added.length;

            return (
              <div
                key={post.id}
                className="bg-white rounded-xl border border-gray-200 overflow-hidden"
              >
                <button
                  onClick={() =>
                    setExpanded(isExpanded ? null : post.id)
                  }
                  className="w-full p-4 flex items-center gap-3 text-left hover:bg-gray-50 transition"
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900 truncate">
                      {post.company_name} — {post.job_title}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-zyntern-purple/10 text-zyntern-purple">
                        {PLATFORM_LABELS[post.platform] || post.platform}
                      </span>
                      <span className="text-xs text-gray-400">
                        {new Date(post.approved_at).toLocaleDateString(
                          "hu-HU"
                        )}
                      </span>
                      <span className="text-xs text-orange-500">
                        {changeCount} szó módosítva
                      </span>
                    </div>
                  </div>
                  <span className="text-gray-400 text-lg">
                    {isExpanded ? "▲" : "▼"}
                  </span>
                </button>

                {isExpanded && (
                  <div className="px-4 pb-4 border-t border-gray-100">
                    <DiffView
                      original={post.original_text}
                      modified={post.modified_text}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
