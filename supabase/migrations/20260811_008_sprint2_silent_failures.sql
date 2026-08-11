-- Sprint 2: The silent failures

-- T2.1: Enable realtime on social_posts
ALTER PUBLICATION supabase_realtime ADD TABLE social_posts;

-- T2.2: Schedule cron jobs
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Token refresh: daily at 08:00 UTC
SELECT cron.schedule(
  'refresh-social-tokens',
  '0 8 * * *',
  $$
  SELECT net.http_post(
    url     := current_setting('app.functions_url') || '/refresh-tokens',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- Retry failed posts: every 2 minutes
SELECT cron.schedule(
  'retry-failed-posts',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url     := current_setting('app.functions_url') || '/retry-failed-posts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- T2.3: Disconnect platform RPC — already created as delete_social_token in migration 007
