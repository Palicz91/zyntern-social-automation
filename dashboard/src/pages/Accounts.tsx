import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";

interface TokenStatus {
  id: string;
  platform: string;
  expires_at: string | null;
  page_id: string | null;
  account_id: string | null;
  status: string;
}

const PLATFORMS = [
  {
    key: "linkedin",
    label: "LinkedIn",
    icon: "in",
    color: "bg-blue-600",
    oauthParam: "linkedin",
  },
  {
    key: "facebook_page",
    label: "Facebook Page",
    icon: "f",
    color: "bg-blue-500",
    oauthParam: "facebook",
  },
  {
    key: "instagram",
    label: "Instagram",
    icon: "ig",
    color: "bg-gradient-to-r from-purple-500 to-pink-500",
    note: "A Facebook fiókkal együtt csatlakozik",
  },
];

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

export default function Accounts() {
  const [tokens, setTokens] = useState<TokenStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchParams] = useSearchParams();

  const successPlatform = searchParams.get("success");
  const errorMsg = searchParams.get("error");

  useEffect(() => {
    fetchTokens();
  }, []);

  const fetchTokens = async () => {
    const { data, error } = await supabase
      .from("social_token_status")
      .select("*");

    if (!error && data) {
      setTokens(data);
    }
    setLoading(false);
  };

  const getTokenForPlatform = (platformKey: string): TokenStatus | undefined => {
    if (platformKey === "instagram") {
      // Instagram uses the facebook_page token
      const fbToken = tokens.find((t) => t.platform === "facebook_page");
      if (fbToken && fbToken.account_id) {
        return { ...fbToken, platform: "instagram" };
      }
      return undefined;
    }
    return tokens.find((t) => t.platform === platformKey);
  };

  const connectUrl = (oauthParam: string) =>
    `${SUPABASE_URL}/functions/v1/oauth?platform=${oauthParam}`;

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-zyntern-purple" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Fiókok</h1>

      {/* Success/error banners */}
      {successPlatform && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-800 text-sm">
          {successPlatform} fiók sikeresen bekötve!
        </div>
      )}
      {errorMsg && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm">
          Hiba: {errorMsg}
        </div>
      )}

      {/* Expiring soon warning */}
      {tokens.some((t) => t.status === "expiring_soon") && (
        <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-800 text-sm">
          Figyelem: egy vagy több token 7 napon belül lejár. Az automatikus frissítés naponta fut.
        </div>
      )}

      <div className="grid gap-4">
        {PLATFORMS.map((p) => {
          const token = getTokenForPlatform(p.key);
          const isConnected = !!token;
          const status = token?.status || "not_connected";

          return (
            <div
              key={p.key}
              className="bg-white rounded-xl border border-gray-200 p-5 flex items-center gap-4"
            >
              {/* Platform icon */}
              <div
                className={`w-12 h-12 rounded-xl ${p.color} flex items-center justify-center text-white font-bold text-lg flex-shrink-0`}
              >
                {p.icon}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-gray-900">{p.label}</h3>
                {isConnected ? (
                  <div className="text-sm text-gray-500">
                    {token.page_id && (
                      <span>Page ID: {token.page_id} · </span>
                    )}
                    {p.key === "instagram" && token.account_id && (
                      <span>IG ID: {token.account_id} · </span>
                    )}
                    {token.expires_at && (
                      <span>
                        Lejárat:{" "}
                        {new Date(token.expires_at).toLocaleDateString("hu-HU")}
                      </span>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">
                    {p.note || "Nincs bekötve"}
                  </p>
                )}
              </div>

              {/* Status badge */}
              <div className="flex items-center gap-3 flex-shrink-0">
                <span
                  className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
                    status === "connected"
                      ? "bg-green-100 text-green-800"
                      : status === "expiring_soon"
                      ? "bg-yellow-100 text-yellow-800"
                      : status === "expired"
                      ? "bg-red-100 text-red-800"
                      : "bg-gray-100 text-gray-500"
                  }`}
                >
                  {status === "connected"
                    ? "Aktív"
                    : status === "expiring_soon"
                    ? "Lejár hamarosan"
                    : status === "expired"
                    ? "Lejárt"
                    : "Nincs bekötve"}
                </span>

                {/* Connect/reconnect button */}
                {p.oauthParam && (
                  <a
                    href={connectUrl(p.oauthParam)}
                    className={`text-sm font-medium px-4 py-2 rounded-lg transition ${
                      isConnected
                        ? "bg-gray-100 text-gray-700 hover:bg-gray-200"
                        : "bg-zyntern-purple text-white hover:bg-zyntern-deep"
                    }`}
                  >
                    {isConnected ? "Újrakapcsolás" : "Bekötés"}
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
