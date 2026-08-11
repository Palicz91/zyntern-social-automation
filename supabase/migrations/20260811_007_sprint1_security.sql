-- Sprint 1: Make it run, make it safe
-- T1.2: Stop leaking OAuth tokens to any signed-up user
-- T1.3: Move approval behind an RPC
-- T1.5: OAuth state table for CSRF protection

-- T1.2: Fix social_tokens exposure
DROP POLICY IF EXISTS "Auth users read token status" ON social_tokens;
REVOKE ALL ON social_tokens FROM anon, authenticated;

ALTER VIEW social_token_status SET (security_invoker = false);
REVOKE ALL ON social_token_status FROM anon;
GRANT SELECT ON social_token_status TO authenticated;

-- T1.3: Move approval behind an RPC
DROP POLICY IF EXISTS "Auth users update social_posts" ON social_posts;
REVOKE UPDATE ON social_posts FROM authenticated;

CREATE OR REPLACE FUNCTION approve_social_post(p_post_id uuid, p_text text)
RETURNS social_posts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r social_posts;
BEGIN
  UPDATE social_posts SET
    status        = 'approved',
    modified_text = NULLIF(p_text, original_text),
    approved_by   = coalesce(auth.jwt() ->> 'email', 'dashboard'),
    approved_at   = now(),
    retry_count   = 0,
    error_message = NULL,
    next_retry_at = NULL
  WHERE id = p_post_id
    AND status IN ('pending', 'failed')
  RETURNING * INTO r;

  IF r.id IS NULL THEN
    RAISE EXCEPTION 'Post not found or not in an approvable state';
  END IF;

  RETURN r;
END;
$$;

GRANT EXECUTE ON FUNCTION approve_social_post(uuid, text) TO authenticated;

-- T1.2: Disconnect helper (authenticated users cannot DELETE directly — REVOKE ALL is in effect)
CREATE OR REPLACE FUNCTION delete_social_token(p_platform text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM social_tokens WHERE platform = p_platform;
END;
$$;

GRANT EXECUTE ON FUNCTION delete_social_token(text) TO authenticated;

-- T1.5: OAuth state table
CREATE TABLE oauth_states (
  state      TEXT PRIMARY KEY,
  platform   TEXT NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_oauth_states_created ON oauth_states (created_at);
