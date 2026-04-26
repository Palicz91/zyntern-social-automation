import { Link, useLocation } from "react-router-dom";
import { supabase } from "../lib/supabase";
import type { Session } from "@supabase/supabase-js";

export default function Layout({
  session,
  children,
}: {
  session: Session;
  children: React.ReactNode;
}) {
  const location = useLocation();

  const nav = [
    { to: "/", label: "Dashboard" },
    { to: "/accounts", label: "Fiókok" },
    { to: "/analytics", label: "Analytics" },
  ];

  return (
    <div className="min-h-screen">
      <header className="bg-zyntern-dark text-white">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link to="/" className="text-xl font-bold tracking-tight">
              <span className="text-zyntern-yellow">Z</span>yntern Social
            </Link>
            <nav className="hidden sm:flex gap-4">
              {nav.map((n) => (
                <Link
                  key={n.to}
                  to={n.to}
                  className={`text-sm font-medium px-3 py-1 rounded-full transition ${
                    location.pathname === n.to
                      ? "bg-zyntern-purple text-white"
                      : "text-gray-300 hover:text-white"
                  }`}
                >
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-400 hidden sm:block">
              {session.user.email}
            </span>
            <button
              onClick={() => supabase.auth.signOut()}
              className="text-sm text-gray-400 hover:text-white transition"
            >
              Kijelentkezés
            </button>
          </div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
