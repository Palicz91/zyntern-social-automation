# Pre-test-ride setup — manual steps

Written 2026-09-10, alongside the pre-test-ride fixes. These are the steps that
cannot be done in code: they need a value only you have, or they touch a live
service. Everything else in the fix list is already applied and tested.

Work through 1 and 2 before the test ride. 3 is background you will want when
something looks wrong.

---

## 1. Set `FACEBOOK_PAGE_ID`

**Do this first. It is the highest-value single action on this list.**

### Why

Two separate problems, one setting.

**It stops the wrong page being connected.** Without it, the OAuth callback binds
whatever page Facebook happens to list first in `/me/accounts`. If the connecting
account administers more than one page, that is a coin flip.

**It blocks a takeover path.** The connect flow can be started by anyone who has
the public anon key — which ships inside the dashboard's browser bundle, so it is
not a secret. `oauth_states.created_by` is `null`, so the flow is not tied to a
logged-in user, and both token upserts use `onConflict: "platform"` against a
single global row. An outsider can therefore run the connect flow with their own
Facebook account and overwrite the company's publishing token, after which
approved job ads publish to their page instead.

With `FACEBOOK_PAGE_ID` set, the callback rejects any account that does not
administer that exact page, and the attack fails at the pin check.

This is a mitigation, not a fix. The underlying problem — an unauthenticated
connect flow writing to a global row — is listed in section 3 and still needs a
real decision.

### How

1. Open the Facebook Page → Settings → About → scroll to **Page ID**. Copy the
   numeric ID.
   Do not use the Business ID or the Instagram account ID — Meta's UI shows
   several similar-looking numbers and only the Page ID works here.
2. Set it as a Supabase secret:
   ```
   supabase secrets set FACEBOOK_PAGE_ID=<the numeric page id>
   ```
3. Reconnect Facebook from the dashboard Accounts page.

### Checking it worked

The Accounts page shows the Page ID next to Facebook. If the connect fails with
`Facebook page <id> not found in /me/accounts for this user`, the account you
connected with does not administer that page — that is the pin doing its job, not
a bug.

The value is trimmed before comparison, so a stray trailing space or newline in
the secret will not break it.

---

## 2. Fix the image service deployment

The image service on the VPS **does not run from this repository**, so pushing to
git does not update it. Three separate things are wrong; fix all three together.

### 2a. It runs from the wrong checkout

`zyntern-image-gen.service` has:

```
WorkingDirectory=/home/claude-bot/zyntern-social-automation/services/image-generator
```

That checkout is behind this one and has diverged in source, not just in commits.
Confirm with:

```
systemctl show -p MainPID --value zyntern-image-gen.service
ls -l /proc/<that pid>/cwd
```

Point the unit at the canonical checkout, or update that checkout from git —
either is fine, but pick one and make it the rule, because a second copy is what
produced the rest of this section.

### 2b. The unit and the code disagree on the Supabase key variable

| | Name used |
|---|---|
| `zyntern-image-gen.service` | `SUPABASE_SERVICE_KEY` |
| `server.js` in this repo | `SUPABASE_SERVICE_ROLE_KEY` |

Deploy this repo's `server.js` under the current unit and `SUPABASE_KEY` is
`undefined`, so the Supabase client is never constructed and the service drops to
local mode: cards render but are never uploaded to storage, and `publish-job`
gets no image URL back.

**This failure is silent, and the new startup banner makes it look healthy** — the
banner prints the allowed image hosts, which are derived from `SUPABASE_URL`, and
`SUPABASE_URL` is set. A healthy-looking log line over a dead storage client.

Fix by renaming the variable in the unit to `SUPABASE_SERVICE_ROLE_KEY` (the name
`.env.example` documents), then `systemctl daemon-reload && systemctl restart
zyntern-image-gen`.

### 2c. `EXTRA_IMAGE_HOSTS` has no way in

The active unit passes environment via inline `Environment=` lines and has no
`EnvironmentFile`, so the `EXTRA_IMAGE_HOSTS` documented in `.env.example` never
reaches the process. Add it to the unit:

```
Environment=EXTRA_IMAGE_HOSTS=zyntern.com
```

Lowercase hostnames only — no scheme, no port, no wildcard. `https://zyntern.com`,
`zyntern.com:443` and `*.zyntern.com` are all silently dead entries. (The code
lowercases what you give it, so capitals are safe; the other shapes are not.)

Note `zyntern.hu` is **not** usable — it only 301-redirects to a link shortener.
Use `zyntern.com`.

### 2d. After deploying, check the banner

The service logs its effective allowlist at startup:

```
journalctl -u zyntern-image-gen -n 20 | grep "Allowed image hosts"
```

If `zyntern.com` is missing from that line, 2c did not take. If a logo goes
missing at render time you will now also see `Dropped logo_url (host not allowed)`
in the journal — that message did not exist before and is the fastest way to tell
a blocked host from a broken image.

### 2e. The service now has a `lib/` directory

`server.js` requires `./lib/image-hosts`. Any deployment that copies `server.js`
alone will crash on startup. Copy the directory.

---

## 3. Known-open issues (not fixed, need a decision)

These were found by the security review on 2026-09-10 and are **pre-existing** —
none was introduced by the pre-test-ride fixes. They are recorded here so they are
not rediscovered from scratch.

| Issue | Impact | Interim mitigation |
|---|---|---|
| Connect flow is unauthenticated and writes a single global token row (`oauth-start` accepts the public anon key; `oauth_states.created_by` is null; both upserts use `onConflict: "platform"`) | Anyone with the anon key can overwrite the company's publishing connection | Set `FACEBOOK_PAGE_ID` (section 1) |
| LinkedIn org selection still takes `elements?.[0]` | A member administering several approved organisations gets a non-deterministic company page | Connect with an account that administers only the intended org |
| Facebook exchanges put `client_secret` and `fb_exchange_token` in the query string, and thrown errors are forwarded into the dashboard redirect URL | A fetch-layer error whose message embeds the request URL could carry secrets into browser history and proxy logs | None — avoid pasting dashboard error URLs into tickets |
| Meta consent lets a user untick individual permissions, and the callback never checks `/me/permissions` | Declining `instagram_basic` yields a "connected" Facebook row where Instagram silently never works | Check the Accounts page shows an IG ID after connecting |

---

## 4. Running the tests

The project had no test runner before 2026-09-10. There are now two, both
dependency-free:

```
cd services/image-generator && npm test      # 18 tests, Node's built-in runner
deno test supabase/functions/_shared/        # 4 tests
```

They cover the allowlist and flag-parsing rules where the 2026-09-10 bugs lived:
host matching and case handling, log sanitising, the CSS `url()` escape, and
`LINKEDIN_ORG_MODE` parsing. They do not cover the OAuth callbacks or the
publishing paths, which still have no automated coverage at all.
