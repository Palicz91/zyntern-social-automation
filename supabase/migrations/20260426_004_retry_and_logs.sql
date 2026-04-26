ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS api_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  status_code INTEGER,
  request_summary TEXT,
  response_summary TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE api_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service insert api_logs" ON api_logs FOR INSERT WITH CHECK (true);
CREATE POLICY "Auth users read api_logs" ON api_logs FOR SELECT TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_social_posts_retry
  ON social_posts (next_retry_at)
  WHERE status = 'failed' AND retry_count < 3 AND next_retry_at IS NOT NULL;
