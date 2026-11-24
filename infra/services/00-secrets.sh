#!/usr/bin/env bash
# [Shared, lead: Marwan] Secrets Manager: ats/auth, ats/jobs-db, ats/email
# Real values live ONLY in Secrets Manager and in infra/.secrets.local (git-ignored).
source "$(dirname "$0")/../lib.sh"
step "Secrets Manager"

if [ ! -f "$SECRETS_FILE" ]; then
  PG_PW=$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")
  {
    echo "# Local secrets for the ATS deployment. This file is git-ignored: NEVER commit it."
    echo "# Fill these in, then run: bash infra/services/00-secrets.sh"
    echo "NEON_DATABASE_URL=''"
    echo "BREVO_API_KEY=''"
    echo "BREVO_SENDER_EMAIL=''"
    echo "BREVO_SENDER_NAME=\"ATS Recruitment\""
    echo "# Generated automatically: password of the local Postgres stand-in for Neon"
    echo "LOCAL_PG_PASSWORD=$PG_PW"
  } > "$SECRETS_FILE"
  echo "  created infra/.secrets.local (git-ignored)"
fi
load_local_secrets

# ats/auth: two DIFFERENT random 256-bit keys, created once and kept (re-running does not rotate them).
if ! secret_value "$SECRET_AUTH" >/dev/null; then
  JWT=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
  SVC=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
  put_secret "$SECRET_AUTH" "{\"jwtSecret\":\"$JWT\",\"serviceSecret\":\"$SVC\"}"
  echo "  $SECRET_AUTH created (random JWT + service-token keys)"
else
  echo "  $SECRET_AUTH exists (kept)"
fi

# ats/jobs-db: Neon if configured, otherwise the local Postgres stand-in
if [ -n "${NEON_DATABASE_URL:-}" ]; then
  DB_URL="$NEON_DATABASE_URL"; DB_KIND="Neon"
else
  DB_URL="postgres://ats_app:${LOCAL_PG_PASSWORD}@ats-postgres:5432/ats_jobs"; DB_KIND="local Postgres stand-in"
fi
put_secret "$SECRET_JOBS_DB" "$(node -e 'console.log(JSON.stringify({databaseUrl: process.argv[1]}))' "$DB_URL")"
echo "  $SECRET_JOBS_DB -> $DB_KIND"

# ats/email: Brevo key (May). Placeholder until the key is added to .secrets.local
EMAIL_JSON=$(node -e 'console.log(JSON.stringify({brevoApiKey: process.argv[1] || "REPLACE_ME", senderEmail: process.argv[2] || "", senderName: process.argv[3] || "ATS Recruitment"}))' "${BREVO_API_KEY:-}" "${BREVO_SENDER_EMAIL:-}" "${BREVO_SENDER_NAME:-}")
put_secret "$SECRET_EMAIL" "$EMAIL_JSON"
if [ -n "${BREVO_API_KEY:-}" ]; then
  echo "  $SECRET_EMAIL -> Brevo key set"
else
  echo "  $SECRET_EMAIL -> placeholder (emails will be recorded as 'skipped' until a key is added)"
fi
