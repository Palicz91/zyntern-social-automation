-- jobs tábla: beérkező álláshirdetések
CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_job_id TEXT UNIQUE NOT NULL,
  job_title TEXT NOT NULL,
  company_name TEXT NOT NULL,
  category TEXT,
  skills TEXT[],
  location TEXT,
  weekly_hours INTEGER,
  is_paid BOOLEAN DEFAULT false,
  is_remote BOOLEAN DEFAULT false,
  logo_url TEXT,
  cover_image_url TEXT,
  job_url TEXT NOT NULL,
  description TEXT NOT NULL,
  benefits TEXT[],
  deadline DATE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- social_posts tábla: generált posztok platformonként
CREATE TABLE social_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('linkedin', 'facebook_page', 'facebook_group', 'instagram')),
  target_name TEXT,
  original_text TEXT NOT NULL,
  modified_text TEXT,
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'posting', 'posted', 'failed')),
  platform_post_id TEXT,
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- social_tokens tábla: OAuth tokenek
CREATE TABLE social_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT UNIQUE NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ,
  page_id TEXT,
  account_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- post_analytics tábla: poszt teljesítmény
CREATE TABLE post_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  social_post_id UUID REFERENCES social_posts(id) ON DELETE CASCADE,
  impressions INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  fetched_at TIMESTAMPTZ DEFAULT now()
);

-- Index-ek
CREATE INDEX idx_social_posts_job_id ON social_posts(job_id);
CREATE INDEX idx_social_posts_status ON social_posts(status);
CREATE INDEX idx_jobs_external_id ON jobs(external_job_id);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER social_posts_updated_at
  BEFORE UPDATE ON social_posts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS policies
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_analytics ENABLE ROW LEVEL SECURITY;

-- Service role-nak mindent engedélyezünk (edge function-ök használják)
CREATE POLICY "Service role full access" ON jobs FOR ALL USING (true);
CREATE POLICY "Service role full access" ON social_posts FOR ALL USING (true);
CREATE POLICY "Service role full access" ON social_tokens FOR ALL USING (true);
CREATE POLICY "Service role full access" ON post_analytics FOR ALL USING (true);
