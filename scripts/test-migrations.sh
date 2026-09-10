#!/usr/bin/env bash
# Apply the full migration chain against a throwaway Postgres and exercise the queue.
# Catches what tsc and vite cannot: rejected DDL, broken plpgsql, wrong scheduling maths.
#
#   sudo apt-get install -y postgresql-16
#   ./scripts/test-migrations.sh
#
set -euo pipefail

PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
PGDATA=$(mktemp -d)
PORT=${PORT:-$(python3 -c "import socket;s=socket.socket();s.bind(('',0));print(s.getsockname()[1]);s.close()")}
SOCK=$(mktemp -d)
MIGRATIONS=${MIGRATIONS:-supabase/migrations}

cleanup() { "$PGBIN/pg_ctl" -D "$PGDATA" -s stop >/dev/null 2>&1 || true; rm -rf "$PGDATA" "$SOCK"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$PGDATA" -U postgres >/dev/null
"$PGBIN/pg_ctl" -D "$PGDATA" -s -l "$PGDATA/server.log" -o "-k $SOCK -p $PORT" start >/dev/null
sleep 1
psql() { command psql -h "$SOCK" -p "$PORT" -U postgres -d zt -v ON_ERROR_STOP=1 -q "$@"; }
command psql -h "$SOCK" -p "$PORT" -U postgres -q -c "CREATE DATABASE zt;" >/dev/null

# Supabase-shaped stubs. Enough surface for the migrations to run and the RPCs to execute.
psql <<'SQL' >/dev/null
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth; CREATE SCHEMA cron; CREATE SCHEMA net; CREATE SCHEMA vault; CREATE SCHEMA extensions;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{"email":"reviewer@zyntern.hu"}'::jsonb $$;
CREATE TABLE cron.job_stub(jobname text, schedule text, command text);
CREATE FUNCTION cron.schedule(jobname text, schedule text, command text) RETURNS bigint
  LANGUAGE sql AS $$ INSERT INTO cron.job_stub VALUES (jobname, schedule, command); SELECT 1::bigint $$;
CREATE FUNCTION net.http_post(url text, headers jsonb DEFAULT '{}', body jsonb DEFAULT '{}') RETURNS bigint
  LANGUAGE sql AS $$ SELECT 1::bigint $$;
CREATE VIEW vault.decrypted_secrets AS SELECT 'cron_secret'::text AS name, 'stub'::text AS decrypted_secret;
CREATE PUBLICATION supabase_realtime;
ALTER DATABASE zt SET app.functions_url = 'https://ref.supabase.co/functions/v1';
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
SQL

echo "── migration chain ──"
for f in $(ls -1 "$MIGRATIONS"/*.sql | sort); do
  # pg_cron and pg_net are not installable locally; the stubs above stand in.
  sed -E 's/^CREATE EXTENSION( IF NOT EXISTS)? (pg_cron|pg_net).*/SELECT 1;/' "$f" > "$PGDATA/m.sql"
  if psql -f "$PGDATA/m.sql" >/dev/null 2>"$PGDATA/err"; then
    echo "  ok    $(basename "$f")"
  else
    echo "  FAIL  $(basename "$f")"; grep -E "ERROR|HINT" "$PGDATA/err" | head -3; exit 1
  fi
done

echo "── cron jobs registered ──"
psql -c "SELECT jobname, schedule FROM cron.job_stub ORDER BY jobname;" -P pager=off

echo "── cron URL consistency ──"
BAD=$(psql -t -A -c "SELECT count(*) FROM cron.job_stub WHERE command LIKE '%functions/v1/functions/v1%' OR command NOT LIKE '%app.functions_url%';")
[ "$BAD" = "0" ] && echo "  ok    all cron targets well-formed" || { echo "  FAIL  $BAD malformed cron target(s)"; exit 1; }

echo "── queue distribution (cap 3/day, 120min gap) ──"
psql <<'SQL' -P pager=off
INSERT INTO jobs (id, external_job_id, job_title, company_name, job_url, description)
VALUES ('11111111-1111-1111-1111-111111111111','t1','Intern','TestCo','https://x','d');
INSERT INTO social_posts (job_id, platform, original_text, status)
SELECT '11111111-1111-1111-1111-111111111111','linkedin','p'||lpad(g::text,3,'0'),'pending'
FROM generate_series(1,12) g;
DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT id FROM social_posts ORDER BY original_text LOOP
    PERFORM approve_social_post(r.id,'text');
  END LOOP; END $$;
SELECT (scheduled_at AT TIME ZONE 'Europe/Budapest')::date AS day,
       to_char(scheduled_at AT TIME ZONE 'Europe/Budapest','Dy') AS dow,
       count(*) AS posts
FROM social_posts WHERE status='queued' GROUP BY 1,2 ORDER BY 1;
SQL

echo "── assert: no day exceeds its cap ──"
OVER=$(psql -t -A -c "
  SELECT count(*) FROM (
    SELECT (sp.scheduled_at AT TIME ZONE pr.timezone)::date AS d, count(*) AS n, pr.daily_cap
    FROM social_posts sp JOIN posting_rules pr ON pr.platform = sp.platform
    WHERE sp.status='queued' GROUP BY 1, pr.daily_cap HAVING count(*) > pr.daily_cap
  ) x;")
[ "$OVER" = "0" ] && echo "  ok    every scheduled day within cap" || { echo "  FAIL  $OVER day(s) over cap"; exit 1; }

echo "── assert: scheduler would publish something today ──"
# Mirrors schedule-queue's cap check. Queued posts must NOT count toward the cap,
# or the scheduler blocks itself on day one.
DECISION=$(psql -t -A -c "
  WITH b AS (SELECT date_trunc('day', now() AT TIME ZONE 'Europe/Budapest') AT TIME ZONE 'Europe/Budapest' AS t0)
  SELECT CASE WHEN (
    (SELECT count(*) FROM social_posts, b WHERE platform='linkedin' AND status='posted'
       AND posted_at >= b.t0 AND posted_at < b.t0 + interval '1 day')
  + (SELECT count(*) FROM social_posts, b WHERE platform='linkedin' AND status IN ('approved','posting')
       AND approved_at >= b.t0 AND approved_at < b.t0 + interval '1 day')
  ) >= (SELECT daily_cap FROM posting_rules WHERE platform='linkedin')
  THEN 'BLOCKED' ELSE 'WOULD PUBLISH' END;")
[ "$DECISION" = "WOULD PUBLISH" ] && echo "  ok    scheduler unblocked" || { echo "  FAIL  scheduler blocked on an empty day"; exit 1; }

echo
echo "all checks passed"
