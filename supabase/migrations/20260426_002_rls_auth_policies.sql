-- Drop overly permissive policies
DROP POLICY IF EXISTS "Service role full access" ON jobs;
DROP POLICY IF EXISTS "Service role full access" ON social_posts;
DROP POLICY IF EXISTS "Service role full access" ON social_tokens;
DROP POLICY IF EXISTS "Service role full access" ON post_analytics;

-- Authenticated user policies (dashboard)
CREATE POLICY "Auth users read jobs" ON jobs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Auth users read social_posts" ON social_posts FOR SELECT TO authenticated USING (true);
CREATE POLICY "Auth users update social_posts" ON social_posts FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Auth users read post_analytics" ON post_analytics FOR SELECT TO authenticated USING (true);

-- Service role INSERT policies (edge functions)
CREATE POLICY "Service insert jobs" ON jobs FOR INSERT WITH CHECK (true);
CREATE POLICY "Service insert social_posts" ON social_posts FOR INSERT WITH CHECK (true);
CREATE POLICY "Service all social_tokens" ON social_tokens FOR ALL USING (true);
CREATE POLICY "Service insert post_analytics" ON post_analytics FOR INSERT WITH CHECK (true);
