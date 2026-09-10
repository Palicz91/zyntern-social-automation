-- Sprint 4: Publishing Queue
-- T4.1: Add scheduling columns to social_posts, create posting_rules table

-- Add scheduling columns
ALTER TABLE social_posts
  ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0;

-- Update status check constraint to include 'queued' and 'skipped'
ALTER TABLE social_posts DROP CONSTRAINT IF EXISTS social_posts_status_check;
ALTER TABLE social_posts ADD CONSTRAINT social_posts_status_check
  CHECK (status IN ('pending', 'approved', 'posting', 'posted', 'failed', 'queued', 'skipped'));

-- Index for queue processing: find oldest queued posts per platform efficiently
CREATE INDEX IF NOT EXISTS idx_social_posts_queued
  ON social_posts (platform, priority DESC, scheduled_at ASC)
  WHERE status = 'queued';

-- Posting rules table: per-platform scheduling constraints
CREATE TABLE IF NOT EXISTS posting_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL UNIQUE,
  daily_cap INTEGER NOT NULL DEFAULT 5,
  window_start TIME NOT NULL DEFAULT '09:00',
  window_end TIME NOT NULL DEFAULT '21:00',
  min_gap_minutes INTEGER NOT NULL DEFAULT 60,
  timezone TEXT NOT NULL DEFAULT 'Europe/Budapest',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: only authenticated users can read posting rules
ALTER TABLE posting_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read posting_rules"
  ON posting_rules FOR SELECT TO authenticated
  USING (true);

-- Seed default rules
INSERT INTO posting_rules (platform, daily_cap, min_gap_minutes)
VALUES
  ('linkedin', 3, 120),
  ('facebook_page', 5, 60),
  ('instagram', 3, 90)
ON CONFLICT (platform) DO NOTHING;

-- T4.4: Modify approve_social_post to set status='queued' and compute scheduled_at
-- Must DROP first: return type changed from social_posts to VOID
DROP FUNCTION IF EXISTS approve_social_post(uuid, text);

CREATE OR REPLACE FUNCTION approve_social_post(p_post_id UUID, p_text TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_platform TEXT;
  v_job_id UUID;
  v_deadline DATE;
  v_rule RECORD;
  v_today_count INTEGER;
  v_last_time TIMESTAMPTZ;
  v_next_slot TIMESTAMPTZ;
  v_now TIMESTAMPTZ := now();
  v_today_start TIMESTAMPTZ;
  v_window_start TIMESTAMPTZ;
  v_window_end TIMESTAMPTZ;
BEGIN
  -- Verify post exists and is in approvable status
  IF NOT EXISTS (
    SELECT 1 FROM social_posts
    WHERE id = p_post_id AND status IN ('pending', 'failed')
  ) THEN
    RAISE EXCEPTION 'Post not found or not in pending/failed status';
  END IF;

  -- Get platform and job info
  SELECT sp.platform, sp.job_id INTO v_platform, v_job_id
  FROM social_posts sp
  WHERE sp.id = p_post_id;

  -- Get posting rules for this platform
  SELECT * INTO v_rule
  FROM posting_rules
  WHERE platform = v_platform AND enabled = true;

  IF v_rule IS NULL THEN
    -- No rules: approve directly (legacy behavior)
    UPDATE social_posts
    SET status = 'approved',
        modified_text = NULLIF(p_text, original_text),
        approved_by = coalesce(auth.jwt() ->> 'email', 'dashboard'),
        approved_at = now(),
        retry_count = 0,
        next_retry_at = NULL
    WHERE id = p_post_id;
    RETURN;
  END IF;

  -- All timestamps stay as TIMESTAMPTZ (UTC). We compute today's midnight
  -- and window boundaries in the rule's timezone, then convert to UTC.
  v_today_start := date_trunc('day', v_now AT TIME ZONE v_rule.timezone) AT TIME ZONE v_rule.timezone;
  v_window_start := (date_trunc('day', v_now AT TIME ZONE v_rule.timezone) + v_rule.window_start) AT TIME ZONE v_rule.timezone;
  v_window_end := (date_trunc('day', v_now AT TIME ZONE v_rule.timezone) + v_rule.window_end) AT TIME ZONE v_rule.timezone;

  -- Walk forward day by day until we find a day under cap
  LOOP
    -- Count this day's posted + queued for this platform (day-bounded)
    SELECT COUNT(*) INTO v_today_count
    FROM social_posts
    WHERE platform = v_platform
      AND status IN ('posted', 'queued', 'approved', 'posting')
      AND (
        (posted_at    >= v_today_start AND posted_at    < v_today_start + INTERVAL '1 day') OR
        (scheduled_at >= v_today_start AND scheduled_at < v_today_start + INTERVAL '1 day')
      );

    EXIT WHEN v_today_count < v_rule.daily_cap;

    -- This day is full, advance to next day
    v_today_start := v_today_start + INTERVAL '1 day';
    v_window_start := v_window_start + INTERVAL '1 day';
    v_window_end := v_window_end + INTERVAL '1 day';

    -- Safety: don't walk more than 14 days ahead
    IF v_today_start > v_now + INTERVAL '14 days' THEN
      UPDATE social_posts
      SET status = 'skipped',
          modified_text = NULLIF(p_text, original_text),
          approved_by = coalesce(auth.jwt() ->> 'email', 'dashboard'),
          approved_at = now(),
          error_message = 'Queue depth exceeded: all days within 14-day window are at cap',
          retry_count = 0,
          next_retry_at = NULL
      WHERE id = p_post_id;
      RETURN;
    END IF;
  END LOOP;

  -- Find last posted/scheduled time for this platform on the target day
  SELECT GREATEST(
    COALESCE(MAX(posted_at), '1970-01-01'::TIMESTAMPTZ),
    COALESCE(MAX(scheduled_at), '1970-01-01'::TIMESTAMPTZ)
  ) INTO v_last_time
  FROM social_posts
  WHERE platform = v_platform
    AND status IN ('posted', 'queued', 'approved', 'posting')
    AND (
      (posted_at    >= v_today_start AND posted_at    < v_today_start + INTERVAL '1 day') OR
      (scheduled_at >= v_today_start AND scheduled_at < v_today_start + INTERVAL '1 day')
    );

  -- Next slot = last + gap, but not before window start, not before now
  v_next_slot := GREATEST(
    v_last_time + (v_rule.min_gap_minutes || ' minutes')::INTERVAL,
    v_window_start,
    v_now
  );

  -- If past window end, move to next day's window start
  IF v_next_slot > v_window_end THEN
    v_next_slot := v_window_start + INTERVAL '1 day';
  END IF;

  -- T4.6: Check deadline overflow
  SELECT j.deadline INTO v_deadline
  FROM jobs j
  WHERE j.id = v_job_id;

  IF v_deadline IS NOT NULL AND (v_next_slot AT TIME ZONE v_rule.timezone)::DATE > v_deadline THEN
    UPDATE social_posts
    SET status = 'skipped',
        modified_text = NULLIF(p_text, original_text),
        approved_by = coalesce(auth.jwt() ->> 'email', 'dashboard'),
        approved_at = now(),
        error_message = 'Scheduled time would exceed job deadline (' || v_deadline || ')',
        retry_count = 0,
        next_retry_at = NULL
    WHERE id = p_post_id;
    RETURN;
  END IF;

  -- Queue the post (reset retry state for re-approvals)
  UPDATE social_posts
  SET status = 'queued',
      modified_text = NULLIF(p_text, original_text),
      approved_by = coalesce(auth.jwt() ->> 'email', 'dashboard'),
      approved_at = now(),
      scheduled_at = v_next_slot,
      error_message = NULL,
      retry_count = 0,
      next_retry_at = NULL
  WHERE id = p_post_id;
END;
$$;

GRANT EXECUTE ON FUNCTION approve_social_post(UUID, TEXT) TO authenticated;

-- RPC for "publish now" — force a queued post to approved status
CREATE OR REPLACE FUNCTION publish_now(p_post_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE social_posts
  SET status = 'approved',
      scheduled_at = NULL
  WHERE id = p_post_id
    AND status = 'queued';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Post not found or not queued';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION publish_now(UUID) TO authenticated;

-- RPC for priority reordering
CREATE OR REPLACE FUNCTION update_post_priority(p_post_id UUID, p_priority INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE social_posts
  SET priority = p_priority
  WHERE id = p_post_id
    AND status = 'queued';
END;
$$;

GRANT EXECUTE ON FUNCTION update_post_priority(UUID, INTEGER) TO authenticated;

-- T4.3: Schedule queue processor every 5 minutes
SELECT cron.schedule(
  'schedule-queue',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.functions_url') || '/schedule-queue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
