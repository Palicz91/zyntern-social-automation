-- Sprint 5: Analytics
-- Add fetched_date for daily snapshots (one row per post per day)

ALTER TABLE post_analytics
  ADD COLUMN IF NOT EXISTS fetched_date DATE;

-- Backfill existing rows
UPDATE post_analytics
SET fetched_date = fetched_at::DATE
WHERE fetched_date IS NULL;

-- Set default for new rows
ALTER TABLE post_analytics
  ALTER COLUMN fetched_date SET DEFAULT CURRENT_DATE;

-- Prevent duplicate daily snapshots
CREATE UNIQUE INDEX IF NOT EXISTS idx_post_analytics_daily
  ON post_analytics (social_post_id, fetched_date);

-- RLS: authenticated users can read analytics
CREATE POLICY "Authenticated users can read post_analytics"
  ON post_analytics FOR SELECT TO authenticated
  USING (true);

-- Schedule fetch-analytics daily at 06:00
SELECT cron.schedule(
  'fetch-analytics',
  '0 6 * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.functions_url') || '/functions/v1/fetch-analytics',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
