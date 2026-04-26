import { useState, useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { supabase } from "./lib/supabase";
import type { Session } from "@supabase/supabase-js";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import JobDetail from "./pages/JobDetail";
import Analytics from "./pages/Analytics";
import Accounts from "./pages/Accounts";
import Layout from "./components/Layout";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-zyntern-purple" />
      </div>
    );
  }

  if (!session) {
    return <Login />;
  }

  return (
    <Layout session={session}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/job/:jobId" element={<JobDetail />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
