#!/usr/bin/env bash
# Builds the WHOLE ATS on Floci in one go (safe to run again: it updates what exists).
#   bash infra/setup-floci.sh            -> everything
#   bash infra/services/20-candidates.sh -> just one member's service (after the first full run)
# Needs: Docker Desktop running. Starts Floci + the local Postgres stand-in if needed.
cd "$(dirname "$0")/.." || exit 1
source infra/lib.sh

if [ "$TARGET" = "floci" ]; then
  step "Floci"
  if [ ! -f "$SECRETS_FILE" ]; then bash infra/services/00-secrets.sh >/dev/null 2>&1 || true; fi
  (cd infra/floci && docker compose --env-file ../.secrets.local up -d) || { echo "Start Docker Desktop first."; exit 1; }
  for i in $(seq 1 60); do curl -s -o /dev/null http://localhost:4566/_floci/health && break; sleep 2; done
  for i in $(seq 1 30); do docker exec ats-postgres pg_isready -U ats_app -d ats_jobs >/dev/null 2>&1 && break; sleep 2; done
  echo "  Floci and Postgres are up. Console: http://localhost:4566/_floci/ui"
fi

for s in 00-secrets 10-jobs 20-candidates 30-pipeline 40-notifier 50-api-gateway 60-frontend 70-monitoring; do
  bash "infra/services/$s.sh" || { echo "FAILED in $s"; exit 1; }
done

step "Done"
echo "API:      $(api_url)"
if [ "$TARGET" = "aws" ]; then echo "Website:  $WEB_ORIGIN"; else echo "Website:  http://localhost:4566/$WEB_BUCKET/index.html"; fi
echo "Next:     node scripts/seed.js        (demo accounts + data)"
echo "Tests:    node --test --test-concurrency=1 'tests/*.test.mjs'"
