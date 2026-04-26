-- Fix: social_tokens ALL policy was too permissive (anon could modify tokens)
DROP POLICY IF EXISTS "Service all social_tokens" ON social_tokens;
-- service_role bypasses RLS, edge functions don't need explicit policies

-- Fix: api_logs INSERT restricted to authenticated
DROP POLICY IF EXISTS "Service insert api_logs" ON api_logs;
CREATE POLICY "Auth insert api_logs" ON api_logs FOR INSERT TO authenticated WITH CHECK (true);
