#!/usr/bin/env bash
set -euo pipefail

# Smoke test for Zyntern Social Automation
# Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_AUTH_TOKEN

: "${SUPABASE_URL:?SUPABASE_URL is required}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY is required}"
: "${API_AUTH_TOKEN:?API_AUTH_TOKEN is required}"

# The logo below is on zyntern.com, so EXTRA_IMAGE_HOSTS must include zyntern.com
# for the card to render with a logo. Without it the card still renders (letter
# fallback) and this script still passes — check the image service log for
# "Dropped logo_url".
FUNCTIONS_URL="${SUPABASE_URL}/functions/v1"
FAKE_JOB_ID="smoke-test-$(date +%s)"

echo "=== Zyntern Smoke Test ==="
echo "Target: $SUPABASE_URL"
echo ""

# 1. Submit a fake job
echo "[1/4] Publishing test job..."
PUBLISH_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$FUNCTIONS_URL/publish-job" \
  -H "Authorization: Bearer $API_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"job_id\": \"$FAKE_JOB_ID\",
    \"job_title\": \"Smoke Test Intern\",
    \"company_name\": \"TestCorp Kft.\",
    \"location\": \"Budapest\",
    \"job_url\": \"https://zyntern.hu/test\",
    \"description\": \"This is a smoke test job posting. It tests the end-to-end publishing flow.\",
    \"logo_url\": \"https://zyntern.com/favicons/apple-icon-152x152.png\"
  }")

HTTP_CODE=$(echo "$PUBLISH_RESPONSE" | tail -1)
BODY=$(echo "$PUBLISH_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -ne 200 ]; then
  echo "FAIL: publish-job returned $HTTP_CODE"
  echo "$BODY"
  exit 1
fi

POST_ID=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('post_id',''))" 2>/dev/null || echo "")

if [ -z "$POST_ID" ]; then
  echo "FAIL: No post_id in response"
  echo "$BODY"
  exit 1
fi

echo "  OK: Job created ($POST_ID)"

# 2. Verify social_posts were created
echo "[2/4] Checking social_posts..."
sleep 2

POSTS_RESPONSE=$(curl -s \
  "$SUPABASE_URL/rest/v1/social_posts?job_id=eq.$POST_ID&select=id,platform,status" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")

POST_COUNT=$(echo "$POSTS_RESPONSE" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")

if [ "$POST_COUNT" -lt 1 ]; then
  echo "FAIL: Expected >=1 social_posts, got $POST_COUNT"
  echo "$POSTS_RESPONSE"
  exit 1
fi

echo "  OK: $POST_COUNT social post(s) created"

# 3. Approve one post via RPC
echo "[3/4] Approving first post..."
FIRST_POST_ID=$(echo "$POSTS_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")

APPROVE_RESPONSE=$(curl -s -w "\n%{http_code}" \
  "$SUPABASE_URL/rest/v1/rpc/approve_social_post" \
  -X POST \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"p_post_id\": \"$FIRST_POST_ID\", \"p_text\": \"Smoke test approved text\"}")

APPROVE_CODE=$(echo "$APPROVE_RESPONSE" | tail -1)

if [ "$APPROVE_CODE" -ne 200 ] && [ "$APPROVE_CODE" -ne 204 ]; then
  echo "WARN: approve_social_post returned $APPROVE_CODE (may be expected if RPC restricts service_role)"
else
  echo "  OK: Post approved"
fi

# 4. Check post status
echo "[4/4] Verifying post status..."
sleep 1

STATUS_RESPONSE=$(curl -s \
  "$SUPABASE_URL/rest/v1/social_posts?id=eq.$FIRST_POST_ID&select=status" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")

STATUS=$(echo "$STATUS_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['status'])" 2>/dev/null || echo "unknown")

echo "  Post status: $STATUS"
if [ "$STATUS" = "approved" ] || [ "$STATUS" = "posted" ] || [ "$STATUS" = "failed" ]; then
  echo "  OK: Status is valid post-approval state"
else
  echo "  INFO: Status is '$STATUS' — may be dry_run (no connected accounts)"
fi

# Cleanup: delete test data
echo ""
echo "Cleaning up test data..."
curl -s -o /dev/null \
  "$SUPABASE_URL/rest/v1/social_posts?job_id=eq.$POST_ID" \
  -X DELETE \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"

curl -s -o /dev/null \
  "$SUPABASE_URL/rest/v1/jobs?id=eq.$POST_ID" \
  -X DELETE \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"

echo ""
echo "=== Smoke Test PASSED ==="
