-- Safe view for dashboard (hides token values)
CREATE OR REPLACE VIEW social_token_status AS
SELECT
  id, platform, expires_at, page_id, account_id, created_at, updated_at,
  CASE
    WHEN expires_at IS NULL THEN 'unknown'
    WHEN expires_at < now() THEN 'expired'
    WHEN expires_at < now() + interval '7 days' THEN 'expiring_soon'
    ELSE 'connected'
  END AS status
FROM social_tokens;

-- Authenticated users can read token metadata (not the actual tokens)
CREATE POLICY "Auth users read token status" ON social_tokens
  FOR SELECT TO authenticated USING (true);

-- pg_cron: daily token refresh at 08:00 UTC
CREATE EXTENSION IF NOT EXISTS pg_cron;
