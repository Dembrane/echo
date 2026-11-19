#!/usr/bin/env bash
# Creates a verified account on the run, through the same API calls the register and
# verification pages make, for features whose recipe starts signed in. Not for proving sign-up
# itself: features/auth.md drives that through the browser.
#   seed-user.sh                 a verified account that has not done onboarding
#   seed-user.sh --org "<name>"  also completes onboarding with that organisation name
# Prints EMAIL= and PASSWORD= lines, then the onboarding response when --org is given.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
pick_run
ORG=
[ "${1:-}" = --org ] && ORG=${2:?usage: seed-user.sh [--org <name>]}

EMAIL=verify-$(date +%s)-$RANDOM@example.com
PASSWORD='Abcdefgh1!xyz'
JAR=$STATE/seed-user-$RANDOM.cookies
# Through the dashboard's /api proxy with its Origin, exactly as the page sends it.
api() { curl -fsS -H "Origin: $DASHBOARD_URL" -H 'Content-Type: application/json' -b "$JAR" -c "$JAR" "$@"; }

api -X POST "$DASHBOARD_URL/api/v2/auth/register" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"first_name\":\"Verify\",\"verification_url\":\"$DASHBOARD_URL/verify-email\"}" >/dev/null
LINK=$(bun "$SCRIPTS/verify-link.ts" "$EMAIL" "$DASHBOARD_URL")
api "$DASHBOARD_URL/api/auth/verify-email?token=${LINK#*token=}" -o /dev/null

echo "EMAIL=$EMAIL"
echo "PASSWORD=$PASSWORD"
if [ -n "$ORG" ]; then
  api -X POST "$DASHBOARD_URL/api/auth/sign-in/email" -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null
  api -X POST "$DASHBOARD_URL/api/v2/onboarding/complete" -d "{\"org_name\":\"$ORG\"}"
  echo
  # Skips the "About you" question as its Skip button does; without an answer, every login
  # sends the account back to that step. The version is read from the page so it stays in step.
  VERSION=$(sed -n 's/.*version: "\([^"]*\)".*/\1/p' "$FRONTEND/src/routes/onboarding/OnboardingRoute.tsx" | head -1)
  [ -n "$VERSION" ] || { echo "no questionnaire version found in OnboardingRoute.tsx" >&2; exit 1; }
  api -X POST "$DASHBOARD_URL/api/v2/onboarding/answers" -d "{\"data\":[],\"skipped\":true,\"version\":\"$VERSION\"}" >/dev/null
fi
rm -f "$JAR"
