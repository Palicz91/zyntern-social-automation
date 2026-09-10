# Implementation Pipeline Progress

## Decisions (Phase 2)
- Scope: All 5 sprints
- Alerting: Telegram
- Manual steps: Phase 8 post-deploy checklist
- Supabase project: deleted (code-only, no CLI/DB actions)

## Current Phase: Phase 7 — COMMITTED (eec6143), verification fixes applied

## Sprint Status
- Sprint 1 (Security): GATE PASSED
- Sprint 2 (Silent failures): GATE PASSED
- Sprint 3 (Hardening): GATE PASSED
- Sprint 4 (Publishing queue): GATE PASSED
- Sprint 5 (Analytics): GATE PASSED

## Phase 6: Integration Verify — PASSED
- tsc --noEmit: clean
- vite build: success (466KB JS, 19KB CSS)
- Secret scan: clean (no leaked credentials)
- Cross-sprint API contracts: verified (all RPCs consistent, no direct DB mutations from dashboard)
- Migration ordering: 007→008→010→011, all CREATE OR REPLACE for evolved functions

## Verification Fixes (FIXES.md) — ALL APPLIED
- F1: DROP FUNCTION before return-type change in migration 010
- F2: Day-bounded daily cap queries (migration 010 RPC + schedule-queue edge fn)
- F3: Cron URL convention fixed (no double /functions/v1)
- F4: health-alert cron.schedule added to migration 011
- F5: schedule-queue try/catch — restore queued on post failure
- F6: NULLIF(p_text, original_text) restored for edit-rate tracking
- F7: coalesce(auth.jwt() ->> 'email', 'dashboard') restored for approved_by
- F8: Old oauth/ function directory deleted
- Post-fix gates: tsc clean, vite build success, secret scan clean

## Verification Fixes Round 2 (FIXES-2.md) — ALL APPLIED
- N1: Scheduler cap check counts only posted + in-flight (not queued) — was blocking all publishing
- N2: Day-walk 14-day guard now marks post as skipped instead of placing beyond cap
- N3: Weekend posting — product decision, kept as-is (no active_days column)
- Added scripts/test-migrations.sh for local Postgres validation
- Post-fix gates: tsc clean, vite build success

## Pre-test-ride fixes (FIX-FOR-CLAUDE-CODE.md) — ALL APPLIED
- Fix 1: Facebook OAuth scopes — added pages_show_list, read_insights, instagram_basic, instagram_manage_comments, instagram_manage_insights (callback's /me/accounts and instagram_business_account lookups were returning nothing)
- Fix 2: LINKEDIN_ORG_MODE env switch — org scopes only when "true"; oauth-callback calls organizationAcls (q=roleAssignee&role=ADMINISTRATOR&state=APPROVED) only in org mode and throws if no administered org is found. No silent fallback to personal posting.
- Fix 3: FACEBOOK_PAGE_ID env — explicit page selection from /me/accounts instead of blindly taking data[0]; throws if the named page is not in the list
- Fix 4: ALLOWED_IMAGE_HOSTS derived from SUPABASE_URL in post-to-social and services/image-generator (old project host was hardcoded); image-generator also honours EXTRA_IMAGE_HOSTS, warns on dropped logo_url/cover_image_url, and logs the allowed hosts at startup
- Fix 5: smoke-test.sh logo_url now https://logo.clearbit.com/zyntern.hu (was the deleted project's storage URL)
- Fix 6: .env.example — LINKEDIN_ORG_MODE, FACEBOOK_PAGE_ID, EXTRA_IMAGE_HOSTS documented
- Migrations untouched (DB deleted; migrations + rollbacks run when the client resumes)
- Post-fix gates: tsc clean; vite build success; deno lint clean (deno check: 14 pre-existing esm.sh generic-inference errors, identical count/codes/files before and after these fixes); no references to the deleted project ref remain; node --check clean

## Pipeline gates run on the pre-test-ride fixes (2026-09-10)
Gates were run retroactively after the fixes were applied, per implementation-pipeline.

5h COVERAGE (fresh-context subagent, sonnet): Fix 1-6 all DONE with file:line evidence, 0 SCOPE EXCEEDED.
  Gate 3 initially NOT MET — the phrase documenting the gate in this file contained the old
  project ref literal, so the gate's own grep matched it. Reworded; gate re-run clean.

5d BUG SEARCH (3 fresh-context subagents, opus, rounds run in parallel: functional / edge-case /
security). Findings, merged and deduplicated:

FIXED — defects introduced by these fixes:
- [HIGH] scripts/smoke-test.sh:35 — logo.clearbit.com does not resolve (Clearbit Logo API retired;
  verified: no A/AAAA record, curl HTTP 000). Fix 5 swapped a dead project URL for a dead host, and
  the smoke test would still print PASSED via the letter fallback — FIXED: now
  https://zyntern.com/favicons/apple-icon-152x152.png (verified HTTP 200, image/png, 6524 bytes).
  Note zyntern.hu only 301s to a shortener, so the .env.example example host was wrong too — corrected.
- [MED] oauth-start:52, oauth-callback:92 — LINKEDIN_ORG_MODE used a case-sensitive, untrimmed
  === "true", so "True"/"TRUE"/"true\r" silently meant personal posting, re-creating the silent
  fallback Fix 2 exists to remove — FIXED: trimmed + lowercased comparison.
- [MED] services/image-generator/server.js:24 — EXTRA_IMAGE_HOSTS entries were never lowercased
  while URL.hostname always is, so "Zyntern.hu" could never match and failed silently — FIXED.
- [MED] oauth-callback:186 — FACEBOOK_PAGE_ID compared raw, so a trailing space or CR from an env
  file threw a misleading "page not found" — FIXED: trimmed.
- [MED] server.js:101,106 — new console.warn interpolated an unbounded, externally supplied URL into
  the journal (newlines forge records, 5MB body floods disk) — FIXED: safeLogValue() strips newlines
  and caps at 200 chars.
- [HIGH] oauth-callback:185 — the FACEBOOK_PAGE_ID pin sat inside if (pagesRes.ok), so it could not
  fire on the most likely wrong-page path (a failed /me/accounts) — FIXED: non-ok is handled
  explicitly and throws when a page is pinned; a page-less connect now warns.
- [MED] oauth-callback:107 — a non-ok organizationAcls response was collapsed into "no organization",
  misdiagnosing the common 403 (Community Management product not approved) — FIXED: status and body
  are logged, and the thrown message says the previous connection is left unchanged.
- [MED] post-to-social:3 / server.js:18 — a missing or malformed SUPABASE_URL threw at module scope
  with an opaque TypeError (edge function: uncatchable cold-start failure; image service: 5s crash
  loop) — FIXED: both now fail closed with a named FATAL message.
- [HIGH] template.html:232 — cover_image_url was interpolated unescaped into a CSS url() sink, so an
  allowlisted URL could smuggle a second, non-allowlisted background fetch, bypassing the host
  allowlist entirely — FIXED: explicit percent-escape map. First attempt used encodeURIComponent,
  which does not escape ( ) ' * ! and was therefore ineffective; caught by testing the regex read
  back from the file, then corrected and retested.

NOT FIXED — pre-existing, architectural, awaiting a decision:
- [HIGH] oauth-start + oauth-callback + social_tokens — the connect flow is reachable with the public
  anon key (config.toml:371 verify_jwt=true is satisfied by it), oauth_states.created_by is null so
  the state is bound to no user, and both upserts use onConflict:"platform" on a single global row.
  Anyone with the anon key can connect their own Facebook account and overwrite the company's
  publishing token. Setting FACEBOOK_PAGE_ID mitigates it — the pin then rejects a foreign account.
- [HIGH] post-to-social:296 — fetch(imageUrl) follows redirects and the allowlist is only checked on
  the initial URL, so an allowlisted redirector can send the fetch anywhere and the bytes are then
  PUT to LinkedIn.
- [MED] oauth-callback:109 — LinkedIn still takes elements?.[0]; it got no equivalent of the
  FACEBOOK_PAGE_ID pin, so a member administering several orgs gets a non-deterministic target.
- [MED] A Facebook connect that resolves no page still redirects success=facebook and the dashboard
  shows connected; every later post fails "page_id not configured". Now warns, but still reports success.

DEPLOYMENT GAP (not a code defect):
- The live image service runs from /home/claude-bot/zyntern-social-automation (systemd
  zyntern-image-gen.service, MainPID cwd verified), not this checkout, so a git push does not deploy
  services/image-generator changes.
- That unit sets SUPABASE_SERVICE_KEY; this checkout's server.js reads SUPABASE_SERVICE_ROLE_KEY.
  Deploying this file onto that unit as-is leaves SUPABASE_KEY undefined, the storage client is never
  created, and the service silently drops to local mode while the new startup banner still looks healthy.
- EXTRA_IMAGE_HOSTS has no path into that unit at all (inline Environment= lines, no EnvironmentFile).

5e SKILLS AUDIT: no `any` introduced; no new state management; no new pages/components; no dead code.
5f RE-VERIFY: tsc --noEmit exit 0; vite build exit 0; deno lint clean (9 files); deno check 14 errors,
  codes and files identical to the git archive HEAD baseline (no new type errors); node --check clean;
  gate 3 and gate 4 pass; secret scan clean on tracked diff and untracked files.
  Tests: 0 -> 0. The project has no test infrastructure (no vitest, jest, or playwright anywhere),
  so behaviour changes ship untested. Flagged as an open gate, not silently accepted.

## Follow-up round (2026-09-10, after the gates)
Items 1-2 documented rather than actioned (they need a value only the owner has, or
touch a live service): docs/pre-test-ride-setup.md.

- Item 3 SSRF — FIXED two ways. post-to-social's allowlist reduced to the storage host
  only (post.image_url is only ever the image service's storage URL or null, so the three
  third-party entries were unreachable on that path and one of them was a redirector), and
  the LinkedIn image download now re-checks the host after redirects, since fetch() follows
  them and the upstream check only ever saw the initial URL.
- Item 4 false "connected" — FIXED as recommended: a facebook_page row with a null page_id
  no longer renders as connected, the status badge no longer reads Aktiv for it, and the
  card explains that no page was found. The OAuth callback was deliberately NOT made to
  hard-fail: Meta Development mode is flaky enough that a throw could block the test ride,
  and the dishonest part was the dashboard, not the connect.
- Item 5 tests — the project had no test runner. Added two, both dependency-free so they
  run offline and without an install step:
    cd services/image-generator && npm test   -> 18 tests (node:test)
    deno test supabase/functions/_shared/     -> 4 tests
  Pure logic extracted to services/image-generator/lib/image-hosts.js and
  supabase/functions/_shared/flags.ts so it can be tested; server.js and both oauth
  functions now delegate to them, which also stops oauth-start and oauth-callback drifting
  apart on how the flag is read.
  Coverage is aimed at where today's bugs actually were: host matching and case handling,
  log sanitising, the CSS url() escape, and LINKEDIN_ORG_MODE parsing.
  Mutation-checked: removing .toLowerCase() from parseExtraHosts fails 1 test, and reverting
  the CSS escape to plain encodeURIComponent (the exact ineffective first attempt) fails 3.
  Still uncovered: the OAuth callbacks and the publishing paths.

Gates after this round: tsc exit 0; vite build exit 0; deno lint clean (11 files); deno check
14 errors, identical codes/files to the HEAD baseline; node --check clean; npm test 18/18;
deno test 4/4; gate 3 and gate 4 pass; secret scan clean on tracked diff and all untracked files.
Tests: 0 -> 22.
