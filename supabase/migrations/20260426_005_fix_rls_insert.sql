-- Remove overly permissive INSERT policies (service_role bypasses RLS)
DROP POLICY IF EXISTS "Service insert jobs" ON jobs;
DROP POLICY IF EXISTS "Service insert social_posts" ON social_posts;
DROP POLICY IF EXISTS "Service insert post_analytics" ON post_analytics;
-- social_tokens keeps its ALL policy since it needs upsert from edge functions
