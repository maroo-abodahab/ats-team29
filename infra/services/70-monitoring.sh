#!/usr/bin/env bash
# [Shared, lead: Marwan - logging & monitoring] CloudWatch metric filters + alarms.
# Every service writes structured JSON logs; security events carry an event name
# (LOGIN_FAILED, ACCESS_DENIED, ...). Metric filters turn those log lines into numbers
# in the "ATS/Security" namespace, and alarms fire on suspicious patterns.
source "$(dirname "$0")/../lib.sh"
step "Monitoring (CloudWatch)"

ok aws sns create-topic --name "$ALERT_TOPIC"

metric_filter() { # log group suffix, filter name, pattern, metric name
  local group="/aws/lambda/$1"
  ok aws logs create-log-group --log-group-name "$group"
  aws logs put-metric-filter --log-group-name "$group" --filter-name "$2" --filter-pattern "$3" \
    --metric-transformations "metricName=$4,metricNamespace=ATS/Security,metricValue=1,defaultValue=0"
  echo "  filter $2 on $group -> ATS/Security/$4"
}

metric_filter "$FN_JOBS" failed-logins '"LOGIN_FAILED"' FailedLogins
metric_filter "$FN_JOBS" account-lockouts '"ACCOUNT_LOCKED"' AccountLockouts
for fn in "$FN_JOBS" "$FN_CANDIDATES" "$FN_PIPELINE"; do
  short="${fn#ats-}"; short="${short%-service}"
  metric_filter "$fn" "access-denied-$short" '"ACCESS_DENIED"' AccessDenied
  metric_filter "$fn" "ownership-denied-$short" '"OWNERSHIP_DENIED"' OwnershipDenied
  metric_filter "$fn" "auth-failed-$short" '"AUTH_FAILED"' UnauthenticatedRequests
  metric_filter "$fn" "server-errors-$short" '"UNHANDLED_ERROR"' ServerErrors
done
metric_filter "$FN_CANDIDATES" cv-rejected '"CV_REJECTED"' RejectedUploads
metric_filter "$FN_NOTIFIER" email-failed '"EMAIL_FAILED"' EmailFailures

alarm() { # name, metric, threshold, description
  aws cloudwatch put-metric-alarm --alarm-name "$1" --namespace ATS/Security --metric-name "$2" \
    --statistic Sum --period 300 --evaluation-periods 1 --threshold "$3" \
    --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching \
    --alarm-description "$4" --alarm-actions "$ALERT_TOPIC_ARN"
  echo "  alarm $1 ($2 >= $3 in 5 min)"
}
alarm ats-brute-force-suspected FailedLogins 5 "5+ failed logins in 5 minutes: possible password guessing"
alarm ats-access-denied-spike AccessDenied 10 "10+ forbidden (403) requests in 5 minutes: possible privilege probing"
alarm ats-idor-probing OwnershipDenied 5 "5+ attempts to open other users' records in 5 minutes: possible IDOR probing"
alarm ats-server-errors ServerErrors 3 "3+ unhandled errors in 5 minutes"
alarm ats-email-failures EmailFailures 3 "3+ failed candidate emails in 5 minutes (Brevo problem?)"
