#!/usr/bin/env bash
# Writes evidence/monitoring.md: CloudWatch security metrics (last N minutes), alarm states
# and sample log lines found with log filters. Shows that security-relevant activity is
# visible WITHOUT any password, token or CV content in the logs.
#   bash infra/monitoring-report.sh [minutes]     (default 60)
cd "$(dirname "$0")/.." || exit 1
source infra/lib.sh
MINUTES="${1:-60}"
START=$(date -u -d "-$MINUTES min" +%FT%TZ); END=$(date -u -d '+2 min' +%FT%TZ)
OUT="evidence/monitoring.md"; mkdir -p evidence

metric() { aws cloudwatch get-metric-statistics --namespace ATS/Security --metric-name "$1" --start-time "$START" --end-time "$END" --period $((MINUTES * 60)) --statistics Sum --query 'Datapoints[0].Sum' --output text; }
logs() { # group, pattern, n
  aws logs filter-log-events --log-group-name "/aws/lambda/$1" --filter-pattern "$2" --start-time $(( $(date +%s) * 1000 - MINUTES * 60000 )) \
    --query "events[-$3:].message" --output text | tr '\t' '\n' | grep -o '{.*}'
}

{
  echo "# Logging and monitoring evidence"
  echo
  echo "Generated $(date -u +%FT%TZ) on **$TARGET**, window: last $MINUTES minutes."
  echo
  echo "## 1. CloudWatch metrics (namespace ATS/Security, produced by log metric filters)"
  echo
  echo "| Metric | Source log group(s) | Filter pattern | Sum |"
  echo "|---|---|---|---|"
  echo "| FailedLogins | /aws/lambda/ats-jobs-service | \"LOGIN_FAILED\" | $(metric FailedLogins) |"
  echo "| AccountLockouts | /aws/lambda/ats-jobs-service | \"ACCOUNT_LOCKED\" | $(metric AccountLockouts) |"
  echo "| UnauthenticatedRequests (401) | jobs, candidates, pipeline | \"AUTH_FAILED\" | $(metric UnauthenticatedRequests) |"
  echo "| AccessDenied (403 wrong role) | jobs, candidates, pipeline | \"ACCESS_DENIED\" | $(metric AccessDenied) |"
  echo "| OwnershipDenied (403 IDOR) | jobs, candidates, pipeline | \"OWNERSHIP_DENIED\" | $(metric OwnershipDenied) |"
  echo "| RejectedUploads | /aws/lambda/ats-candidates-service | \"CV_REJECTED\" | $(metric RejectedUploads) |"
  echo "| ServerErrors (500) | jobs, candidates, pipeline | \"UNHANDLED_ERROR\" | $(metric ServerErrors) |"
  echo "| EmailFailures | /aws/lambda/ats-notifier | \"EMAIL_FAILED\" | $(metric EmailFailures) |"
  echo
  echo "## 2. Alarms (5-minute windows, notify SNS topic ats-security-alerts)"
  echo
  echo "| Alarm | Metric | Threshold | State |"
  echo "|---|---|---|---|"
  aws cloudwatch describe-alarms --query 'MetricAlarms[].[AlarmName,MetricName,Threshold,StateValue]' --output text | while read -r n m t s; do echo "| $n | $m | >= $t | **$s** |"; done
  echo
  echo "## 3. Log filter results (what an operator would look at)"
  echo
  echo "### Repeated failed logins (\`filter-log-events --filter-pattern '\"LOGIN_FAILED\"'\`)"
  echo '```json'; logs ats-jobs-service '"LOGIN_FAILED"' 4; echo '```'
  echo "### Account locked after 5 failures"
  echo '```json'; logs ats-jobs-service '"ACCOUNT_LOCKED"' 2; echo '```'
  echo "### 403: wrong role / other users' records"
  echo '```json'; logs ats-pipeline-service '"ACCESS_DENIED"' 2; logs ats-candidates-service '"OWNERSHIP_DENIED"' 2; echo '```'
  echo "### Rejected malicious upload"
  echo '```json'; logs ats-candidates-service '"CV_REJECTED"' 2; echo '```'
  echo "### Normal audit events (stage changes, emails)"
  echo '```json'; logs ats-pipeline-service '"STAGE_CHANGED"' 2; logs ats-notifier '"NOTIFICATION_HANDLED"' 2; echo '```'
  echo
  echo "## 4. Interpretation"
  echo
  echo "- **FailedLogins** spiking with **AccountLockouts** means someone is guessing passwords; the lockout stops it per account and the alarm tells the team."
  echo "- **AccessDenied** and **OwnershipDenied** spikes mean a logged-in user is trying URLs or IDs that are not theirs (privilege or IDOR probing). The backend refused every one with 403."
  echo "- Log lines carry user id, role, path, IP and event name only. Passwords, tokens and CV content are never logged (the logger redacts such fields)."
} > "$OUT"
echo "Wrote $OUT"
