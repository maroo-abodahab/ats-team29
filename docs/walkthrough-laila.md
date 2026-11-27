# Laila: Candidates & Applications. Study guide

## Your files
| Layer | Files |
|---|---|
| Frontend | `frontend/js/candidates.js` (profile, CV, apply form, my applications, applicants, candidate view) |
| Backend | `services/candidates-service/src/app.js`, `routes/candidates.js`, `routes/applications.js`, `routes/internal.js`, `access.js` |
| Data | `repositories/candidateRepo.js`, `applicationRepo.js` (DynamoDB), `cvStorage.js` (S3), `events.js` (SQS) |
| Cloud | `infra/services/20-candidates.sh`, `60-frontend.sh` (you lead deployment), `infra/iam/candidates-policy.json` |
| AWS services | Lambda, DynamoDB (AtsCandidates, AtsApplications + 2 GSIs), S3 (private CV bucket), SQS (+ DLQ) |

## Request flow to explain: "Apply for a job"
1. `renderApplyForm(job)` → `api('POST', '/api/applications', {jobId, source, coverLetter})` with the JWT.
2. API Gateway `ANY /api/applications` → Lambda `ats-candidates-service` → Express.
3. `requireAuth()` (401) → `requireRole('candidate')` (403).
4. `validate()`: jobId UUID, source in the enum, referral needs `sourceDetail`, unknown fields rejected → 400.
5. Rules: profile exists and has a CV → 409 PROFILE_REQUIRED / CV_REQUIRED.
6. **Cross-service:** `callService('jobs', 'GET', /api/internal/jobs/{id})` → 404 if missing; `acceptingApplications` false (draft, closed, past closing date) → 409 JOB_NOT_OPEN.
7. `listByCandidate` (GSI `candidate-index`): already applied → 409; 5 active → 409 TOO_MANY_ACTIVE.
8. `applicationRepo.create()`: `PutItem` with stage `applied`; `candidateId` comes from the **token**, never the body.
9. `events.publish('APPLICATION_SUBMITTED')` → SQS → May's notifier e-mails the candidate (the request does not wait for it).
10. 201 + `Location` header → frontend goes to *My applications*.

## CV upload flow
`PUT /api/candidates/me/cv {fileName, contentType, contentBase64}` → name pattern (.pdf/.docx) → decode →
`cvStorage.inspect()`: extension allowed, content type matches, **magic bytes** (`%PDF-`, or ZIP `PK..`
containing `word/document.xml`), ≤ 2 MB → 415/413 + `CV_REJECTED` log → `PutObject` with a
server-generated key `cvs/<userId>/<uuid>.pdf` and `ServerSideEncryption: AES256` → profile updated → old file deleted.
Download: access check first, then a pre-signed GET URL valid for **300 s**.

## Ownership (the most important security control)
- Candidate data is keyed by `req.user.userId` from the JWT: there is no "whose profile" field to tamper with.
- `access.js` `assertCanSeeApplication`: candidate = own only; recruiter = all; HM = their job (asked from the jobs service) **and** shortlisted or later. 404 if missing, 403 if not yours (+ `OWNERSHIP_DENIED` log). Tests SEC-07, SEC-08, SEC-09.

## Likely questions
- *Why check magic bytes?* A file name and content type are chosen by the client; renaming `virus.exe` to `cv.pdf` is trivial. Test SEC-12.
- *Why is the bucket private if the link works?* The link is pre-signed (signature + 5-minute expiry), handed out only after the access check. Block Public Access is on (Floci does not enforce it; real AWS does).
- *Why SQS?* Applying never fails or slows down because of e-mail; retries and a dead-letter queue keep failed messages.
- *How is withdraw integrated?* Conditional update (`currentStage = old`), then the pipeline service records history and cancels upcoming interviews (INT-20).
- *Least privilege?* Only your two tables (no Scan/Delete), only `cvs/*` objects (no ListBucket), only SendMessage to your queue.
- *Recovery?* S3 versioning (old CVs 30 days), DynamoDB point-in-time recovery.

## Demo checklist
Register → profile (try an invalid phone → 400) → upload CV (try `.exe` as `.pdf` → 415) → apply (try again → 409) → my applications tracker → withdraw; as staff: applicants filter by source, candidate profile, CV download; as candidate B try A's application URL → 403.
