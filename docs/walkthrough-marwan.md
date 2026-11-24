# Marwan: Job Management + Hiring Analytics (+ shared auth). Study guide

## Your files
| Layer | Files |
|---|---|
| Frontend | `frontend/js/jobs.js`, `frontend/js/analytics.js`, `frontend/js/auth.js` |
| Backend | `services/jobs-service/src/app.js`, `routes/auth.js`, `routes/jobs.js`, `routes/analytics.js`, `routes/internal.js` |
| Data | `repositories/db.js` (Neon pool), `repositories/jobRepo.js` (SQL), `repositories/userRepo.js` (DynamoDB), `db/schema.sql` |
| Shared (you lead) | `services/shared/src/auth.js`, `validate.js`, `createApp.js`, `logger.js`, `rateLimit.js` |
| Cloud | `infra/services/10-jobs.sh`, `00-secrets.sh`, `50-api-gateway.sh`, `70-monitoring.sh`, `infra/iam/jobs-policy.json` |
| AWS services | Lambda, API Gateway, DynamoDB (AtsUsers), Secrets Manager, CloudWatch (+ Neon Postgres) |

## Request flow to explain: "Publish a job"
1. `jobs.js` `statusButtons()` → `api('PATCH', /api/jobs/{id}/status, {status:'published'})` with the JWT.
2. API Gateway route `ANY /api/jobs/{proxy+}` → Lambda `ats-jobs-service` → `lambda.js` (serverless-http) → Express.
3. `createApp.js`: request id, helmet headers, CORS allow-list, JSON parsing, rate limiter.
4. `requireAuth()` verifies the JWT (HS256, issuer `ats-auth`, audience `ats-web`, expiry) with the key from Secrets Manager → 401 if bad.
5. `requireRole('recruiter')` → 403 + `ACCESS_DENIED` log.
6. `validate()`: status must be draft/published/closed, reason 3–200 → 400 with details.
7. Business rules: `TRANSITIONS` table (closed → nothing); publish needs a hiring manager, a 50+ character description and a future closing date → 409 NOT_READY.
   Unpublish asks the **candidates service** (`callService('candidates', ...)`) for the application count → 409 HAS_APPLICATIONS.
8. `jobRepo.changeStatus()`: one Postgres transaction: `UPDATE jobs ... WHERE id=$2 AND status=$from` (stops races) + `INSERT job_events`.
9. Returns 200 with the job; the page reloads and shows a toast.

## Login flow (shared auth)
`POST /api/auth/login` → validate → `userRepo.getByEmail` (GSI `email-index`) → locked? 423 → bcrypt
compare (dummy hash when the e-mail is unknown, so timing is the same) → wrong: `recordFailedLogin`
(5th failure sets `lockedUntil` +15 min), log `LOGIN_FAILED`, generic 401 → right: reset the counter,
`signUserToken` (role comes from the DB, not the request) → 200 `{token, user}`.

## Analytics flow
`GET /api/analytics/overview` → HM restricted to `hiring_manager_id = me` (403 for other jobs) → jobs from
Neon → **in parallel** calls candidates `POST /api/internal/applications/query` and pipeline
`POST /api/internal/analytics/stages` (Lambda Invoke + service token) → calculates candidates per stage,
sources with share and hire rate, time-to-hire (submittedAt → hiredAt; average, median, fastest,
slowest, per job), funnel and average days per stage.

## Likely questions
- *Why two databases?* Jobs are relational (departments, joins, text search, aggregates) → Postgres/Neon. Users are key lookups → DynamoDB.
- *How do services talk?* Lambda-to-Lambda invoke on `/api/internal/*`: not in API Gateway, IAM `lambda:InvokeFunction` only for specific roles, plus a 60-second service token signed with a different key and audience.
- *Why can't a candidate become a recruiter?* Registration schema rejects `role`; the role comes from the DB at login; staff accounts only via `POST /api/auth/staff` (recruiter only). Test SEC-11.
- *What if the JWT secret leaks?* Put a new value in Secrets Manager → all tokens become invalid within 5 minutes (cache TTL) → everyone logs in again.
- *Why 404 not 403 for a hidden draft job?* To avoid revealing that the draft exists.
- *What does the alarm show?* `ats-brute-force-suspected` = FailedLogins ≥ 5 in 5 min (metric filter on `"LOGIN_FAILED"`).
- *Least privilege for your Lambda?* Only AtsUsers, its two secrets, invoking candidates/pipeline, its own log group.

## Demo checklist
Create a draft → blocked publish → publish → search → close with a reason → history; departments; staff
create/deactivate; analytics + snapshot; 5 wrong passwords → 423; monitoring report.
