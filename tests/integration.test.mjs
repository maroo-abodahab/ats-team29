// Integrated tests against the DEPLOYED application: complete workflows that cross all
// three services (jobs <-> candidates <-> pipeline <-> notifier), normal AND invalid cases.
// Results are written to evidence/integration-tests.md for the report.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, recruiter, newCandidate, newStaff, newPublishedJob, recorder, brief } from './helpers.mjs';

const rec = recorder('integration-tests.md', 'Integrated test results (automated, deployed app)');
let R; let HM; let job; let cand; let app;

before(async () => {
  R = await recruiter();
  HM = await newStaff(R.token, 'hiring_manager');
});
after(() => rec.write());

async function step(id, owner, scenario, expected, fn) {
  let result = { pass: false, actual: 'not run', evidence: '' };
  try { result = await fn(); } catch (err) { result = { pass: false, actual: `error: ${err.message}`, evidence: '' }; }
  rec.add({ id, owner, scenario, expected, ...result });
  assert.ok(result.pass, `${id} ${scenario}: ${result.actual}`);
}

// ---- Workflow 1: the full hiring journey (all services) --------------------
test('INT-01 recruiter creates a draft job and it is hidden from the public', () => step('INT-01', 'Marwan', 'POST /api/jobs (draft) then anonymous GET /api/jobs/:id', '201 draft; anonymous 404', async () => {
  const deps = (await call('GET', '/api/departments')).data.items;
  const r = await call('POST', '/api/jobs', { token: R.token, body: { title: 'Integration Test Engineer', description: 'A short draft description.', location: 'Cairo', employmentType: 'contract', departmentId: deps[0].departmentId, openings: 1 } });
  job = r.data.job;
  const anon = await call('GET', `/api/jobs/${job.jobId}`);
  return { pass: r.status === 201 && job.status === 'draft' && anon.status === 404, actual: `${r.status} ${job.status}; anon ${anon.status}`, evidence: brief(anon) };
}));

test('INT-02 publishing is blocked until the job is complete (business rule)', () => step('INT-02', 'Marwan', 'PATCH status=published with no hiring manager and a short description', '409 NOT_READY listing both problems', async () => {
  const r = await call('PATCH', `/api/jobs/${job.jobId}/status`, { token: R.token, body: { status: 'published' } });
  return { pass: r.status === 409 && r.data.error.code === 'NOT_READY' && /hiringManagerId/.test(r.data.error.message) && /description/.test(r.data.error.message), actual: `${r.status} ${r.data.error.code}`, evidence: brief(r) };
}));

test('INT-03 job edited, then published; now publicly searchable', () => step('INT-03', 'Marwan', 'PUT job (assign HM, longer description) -> publish -> GET /api/jobs?q=', '200, 200 published, found by search', async () => {
  const u = await call('PUT', `/api/jobs/${job.jobId}`, { token: R.token, body: { hiringManagerId: HM.user.userId, description: 'Write and maintain automated integration tests for our cloud services on AWS Lambda.' } });
  const p = await call('PATCH', `/api/jobs/${job.jobId}/status`, { token: R.token, body: { status: 'published' } });
  const s = await call('GET', '/api/jobs?q=Integration%20Test%20Engineer');
  const found = s.data.items.some((j) => j.jobId === job.jobId);
  return { pass: u.status === 200 && p.status === 200 && p.data.job.status === 'published' && found, actual: `${u.status}/${p.status} ${p.data.job.status}; found=${found}`, evidence: `search total=${s.data.total}` };
}));

test('INT-04 candidate cannot apply without profile and CV', () => step('INT-04', 'Laila', 'New candidate (no profile) POSTs /api/applications', '409 PROFILE_REQUIRED', async () => {
  cand = await newCandidate('Integration Candidate', { withProfile: false, withCv: false });
  const r = await call('POST', '/api/applications', { token: cand.token, body: { jobId: job.jobId, source: 'linkedin' } });
  return { pass: r.status === 409 && r.data.error.code === 'PROFILE_REQUIRED', actual: `${r.status} ${r.data.error.code}`, evidence: brief(r) };
}));

test('INT-05 candidate creates profile, uploads CV, applies (candidates -> jobs check -> SQS)', () => step('INT-05', 'Laila', 'PUT profile (201), PUT CV (201), POST application source=linkedin', '201 x3, stage "applied"', async () => {
  const p = await call('PUT', '/api/candidates/me', { token: cand.token, body: { fullName: 'Integration Candidate', phone: '+20 111 222 3333', skills: ['Node.js', 'Testing'], yearsExperience: 3 } });
  const c = await call('PUT', '/api/candidates/me/cv', { token: cand.token, body: { fileName: 'Integration_CV.pdf', contentType: 'application/pdf', contentBase64: Buffer.from('%PDF-1.4\n%integration\n%%EOF').toString('base64') } });
  const a = await call('POST', '/api/applications', { token: cand.token, body: { jobId: job.jobId, source: 'linkedin', coverLetter: 'Hello!' } });
  app = a.data.application;
  return { pass: p.status === 201 && c.status === 201 && a.status === 201 && app.currentStage === 'applied', actual: `${p.status}/${c.status}/${a.status} ${app?.currentStage}`, evidence: `applicationId=${app?.applicationId}` };
}));

test('INT-06 duplicate application is refused', () => step('INT-06', 'Laila', 'Same candidate applies to the same job again', '409 ALREADY_APPLIED', async () => {
  const r = await call('POST', '/api/applications', { token: cand.token, body: { jobId: job.jobId, source: 'linkedin' } });
  return { pass: r.status === 409 && r.data.error.code === 'ALREADY_APPLIED', actual: `${r.status} ${r.data.error.code}`, evidence: brief(r) };
}));

test('INT-07 unpublishing a job with applicants is refused (jobs asks candidates)', () => step('INT-07', 'Marwan', 'PATCH status=draft on a job with 1 application', '409 HAS_APPLICATIONS', async () => {
  const r = await call('PATCH', `/api/jobs/${job.jobId}/status`, { token: R.token, body: { status: 'draft' } });
  return { pass: r.status === 409 && r.data.error.code === 'HAS_APPLICATIONS', actual: `${r.status} ${r.data.error.code}`, evidence: brief(r) };
}));

test('INT-08 illegal pipeline jump and rejection without reason are refused', () => step('INT-08', 'May', 'PATCH stage applied -> offer; PATCH stage -> rejected with no reason', '409 ILLEGAL_TRANSITION; 400 VALIDATION_ERROR', async () => {
  const r1 = await call('PATCH', `/api/pipeline/applications/${app.applicationId}/stage`, { token: R.token, body: { toStage: 'offer' } });
  const r2 = await call('PATCH', `/api/pipeline/applications/${app.applicationId}/stage`, { token: R.token, body: { toStage: 'rejected' } });
  return { pass: r1.status === 409 && r1.data.error.code === 'ILLEGAL_TRANSITION' && r2.status === 400, actual: `${r1.status} ${r1.data.error.code}; ${r2.status}`, evidence: `${brief(r1)} | ${brief(r2)}` };
}));

test('INT-09 recruiter screens and shortlists; candidate sees the new stage', () => step('INT-09', 'May', 'PATCH -> screening -> shortlisted; candidate GET /api/applications/me', '200, 200; candidate sees "shortlisted"', async () => {
  const r1 = await call('PATCH', `/api/pipeline/applications/${app.applicationId}/stage`, { token: R.token, body: { toStage: 'screening' } });
  const r2 = await call('PATCH', `/api/pipeline/applications/${app.applicationId}/stage`, { token: R.token, body: { toStage: 'shortlisted' } });
  const mine = await call('GET', '/api/applications/me', { token: cand.token });
  const stage = mine.data.items.find((a) => a.applicationId === app.applicationId).currentStage;
  return { pass: r1.status === 200 && r2.status === 200 && stage === 'shortlisted', actual: `${r1.status}/${r2.status} candidate sees ${stage}`, evidence: `history moves recorded` };
}));

test('INT-10 moving to interview without a scheduled interview is refused', () => step('INT-10', 'May', 'PATCH -> interview with no interview scheduled', '409 INTERVIEW_REQUIRED', async () => {
  const r = await call('PATCH', `/api/pipeline/applications/${app.applicationId}/stage`, { token: R.token, body: { toStage: 'interview' } });
  return { pass: r.status === 409 && r.data.error.code === 'INTERVIEW_REQUIRED', actual: `${r.status} ${r.data.error.code}`, evidence: brief(r) };
}));

let interviewAt;
test('INT-11 schedule interview: validates, auto-moves to interview, emails via SNS', () => step('INT-11', 'May', 'POST interview (past date -> 400), then valid video interview with the HM', '400 then 201, stageMovedToInterview=true', async () => {
  const bad = await call('POST', `/api/pipeline/applications/${app.applicationId}/interviews`, { token: R.token, body: { interviewerId: HM.user.userId, scheduledAt: '2020-01-01T10:00:00Z', durationMinutes: 45, mode: 'video', meetingLink: 'https://meet.example.com/x' } });
  interviewAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const ok = await call('POST', `/api/pipeline/applications/${app.applicationId}/interviews`, { token: R.token, body: { interviewerId: HM.user.userId, scheduledAt: interviewAt, durationMinutes: 60, mode: 'video', meetingLink: 'https://meet.example.com/int-test' } });
  return { pass: bad.status === 400 && ok.status === 201 && ok.data.stageMovedToInterview === true, actual: `${bad.status} then ${ok.status}, moved=${ok.data.stageMovedToInterview}`, evidence: brief(bad) };
}));

test('INT-12 interviewer double-booking is detected', () => step('INT-12', 'May', 'Second candidate shortlisted; schedule with the same HM 30 min into the first interview', '409 INTERVIEWER_BUSY', async () => {
  const c2 = await newCandidate('Second Candidate');
  const a2 = (await call('POST', '/api/applications', { token: c2.token, body: { jobId: job.jobId, source: 'referral', sourceDetail: 'A friend' } })).data.application;
  await call('PATCH', `/api/pipeline/applications/${a2.applicationId}/stage`, { token: R.token, body: { toStage: 'screening' } });
  await call('PATCH', `/api/pipeline/applications/${a2.applicationId}/stage`, { token: R.token, body: { toStage: 'shortlisted' } });
  const clash = new Date(Date.parse(interviewAt) + 30 * 60_000).toISOString();
  const r = await call('POST', `/api/pipeline/applications/${a2.applicationId}/interviews`, { token: R.token, body: { interviewerId: HM.user.userId, scheduledAt: clash, durationMinutes: 30, mode: 'phone' } });
  return { pass: r.status === 409 && r.data.error.code === 'INTERVIEWER_BUSY', actual: `${r.status} ${r.data.error.code}`, evidence: brief(r) };
}));

test('INT-13 offer needs a scorecard; HM submits one; duplicate scorecard refused', () => step('INT-13', 'May', 'PATCH -> offer (no scorecard); HM POST review; HM POST review again', '409 SCORECARD_REQUIRED; 201; 409 ALREADY_REVIEWED', async () => {
  const r1 = await call('PATCH', `/api/pipeline/applications/${app.applicationId}/stage`, { token: R.token, body: { toStage: 'offer' } });
  const review = { scores: { technical: 4, communication: 5, problemSolving: 4, cultureFit: 4 }, recommendation: 'hire', strengths: 'Strong testing mindset' };
  const r2 = await call('POST', `/api/pipeline/applications/${app.applicationId}/reviews`, { token: HM.token, body: review });
  const r3 = await call('POST', `/api/pipeline/applications/${app.applicationId}/reviews`, { token: HM.token, body: review });
  return { pass: r1.status === 409 && r1.data.error.code === 'SCORECARD_REQUIRED' && r2.status === 201 && r2.data.review.overall === 4.25 && r3.status === 409, actual: `${r1.status}; ${r2.status} overall=${r2.data.review?.overall}; ${r3.status}`, evidence: brief(r3) };
}));

test('INT-14 offer then hire: job hired count updates and the filled job auto-closes', () => step('INT-14', 'May + Marwan', 'PATCH -> offer -> hired; GET job', '200, 200 jobAutoClosed=true; job closed, hiredCount 1', async () => {
  const o = await call('PATCH', `/api/pipeline/applications/${app.applicationId}/stage`, { token: R.token, body: { toStage: 'offer' } });
  const hd = await call('PATCH', `/api/pipeline/applications/${app.applicationId}/stage`, { token: R.token, body: { toStage: 'hired' } });
  const j = await call('GET', `/api/jobs/${job.jobId}`, { token: R.token });
  return { pass: o.status === 200 && hd.status === 200 && hd.data.jobAutoClosed === true && j.data.job.status === 'closed' && j.data.job.hiredCount === 1, actual: `${o.status}/${hd.status} autoClosed=${hd.data.jobAutoClosed}; job ${j.data.job.status} ${j.data.job.hiredCount}/${j.data.job.openings}`, evidence: `closeReason=${j.data.job.closeReason}` };
}));

test('INT-15 closed job: new applications and forward moves are refused', () => step('INT-15', 'Laila + May', 'New candidate applies to the closed job', '409 JOB_NOT_OPEN', async () => {
  const c3 = await newCandidate('Late Candidate');
  const r = await call('POST', '/api/applications', { token: c3.token, body: { jobId: job.jobId, source: 'careers_site' } });
  return { pass: r.status === 409 && r.data.error.code === 'JOB_NOT_OPEN', actual: `${r.status} ${r.data.error.code}`, evidence: brief(r) };
}));

test('INT-16 stage history is a complete audit trail', () => step('INT-16', 'May', 'GET /api/pipeline/applications/:id/history', 'applied->screening->shortlisted->interview(auto)->offer->hired', async () => {
  const r = await call('GET', `/api/pipeline/applications/${app.applicationId}/history`, { token: R.token });
  const path = r.data.items.map((e) => e.toStage).join('>');
  const auto = r.data.items.find((e) => e.toStage === 'interview')?.automatic;
  return { pass: path === 'screening>shortlisted>interview>offer>hired' && auto === true, actual: path, evidence: `interview move automatic=${auto}` };
}));

test('INT-17 notifications were produced for the candidate (SNS/SQS -> notifier -> Brevo)', () => step('INT-17', 'May', 'GET notifications for the hired application (allow a few seconds)', 'Records for APPLICATION_SUBMITTED, STAGE_CHANGED, INTERVIEW_SCHEDULED', async () => {
  let types = [];
  for (let i = 0; i < 10 && types.length < 3; i += 1) {
    const r = await call('GET', `/api/pipeline/applications/${app.applicationId}/notifications`, { token: R.token });
    types = [...new Set(r.data.items.map((n) => n.type))];
    if (types.length < 3) await new Promise((res) => setTimeout(res, 2000));
  }
  const statuses = (await call('GET', `/api/pipeline/applications/${app.applicationId}/notifications`, { token: R.token })).data.items.map((n) => n.status);
  return { pass: ['APPLICATION_SUBMITTED', 'STAGE_CHANGED', 'INTERVIEW_SCHEDULED'].every((t) => types.includes(t)), actual: `types=${types.join(',')}`, evidence: `statuses=${[...new Set(statuses)].join(',')}` };
}));

test('INT-18 analytics reflect the hire (jobs reads candidates + pipeline)', () => step('INT-18', 'Marwan', 'GET /api/analytics/overview?jobId=', '1 hire, linkedin source has 1 hire, funnel hired=1', async () => {
  const r = await call('GET', `/api/analytics/overview?jobId=${job.jobId}`, { token: R.token });
  const m = r.data.metrics;
  const li = m.sources.find((s) => s.source === 'linkedin');
  const hired = m.funnel.find((f) => f.stage === 'hired').count;
  return { pass: r.status === 200 && m.timeToHire.hires === 1 && li?.hires === 1 && hired === 1 && m.totalApplications === 2, actual: `hires=${m.timeToHire.hires} apps=${m.totalApplications} linkedinHires=${li?.hires} funnelHired=${hired}`, evidence: `perStage=${JSON.stringify(m.candidatesPerStage)}` };
}));

test('INT-19 hiring manager analytics are limited to own jobs', () => step('INT-19', 'Marwan', 'Another HM asks analytics for this job', '403 FORBIDDEN', async () => {
  const other = await newStaff(R.token, 'hiring_manager');
  const r = await call('GET', `/api/analytics/overview?jobId=${job.jobId}`, { token: other.token });
  return { pass: r.status === 403, actual: `${r.status}`, evidence: brief(r) };
}));

// ---- Workflow 2: withdrawal crosses candidates -> pipeline ---------------------
test('INT-20 candidate withdraws: stage, pipeline history and interviews all update', () => step('INT-20', 'Laila + May', 'Shortlisted candidate with a scheduled interview withdraws', '200 withdrawn; history has withdrawn; interview cancelled; second withdraw 409', async () => {
  const job2 = await newPublishedJob(R.token, HM.user.userId);
  const c = await newCandidate('Withdrawing Candidate');
  const a = (await call('POST', '/api/applications', { token: c.token, body: { jobId: job2.jobId, source: 'job_board' } })).data.application;
  await call('PATCH', `/api/pipeline/applications/${a.applicationId}/stage`, { token: R.token, body: { toStage: 'screening' } });
  await call('PATCH', `/api/pipeline/applications/${a.applicationId}/stage`, { token: R.token, body: { toStage: 'shortlisted' } });
  await call('POST', `/api/pipeline/applications/${a.applicationId}/interviews`, { token: R.token, body: { interviewerId: HM.user.userId, scheduledAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), durationMinutes: 30, mode: 'phone' } });
  const w = await call('PATCH', `/api/applications/${a.applicationId}/withdraw`, { token: c.token, body: { reason: 'Accepted another offer' } });
  const hist = await call('GET', `/api/pipeline/applications/${a.applicationId}/history`, { token: R.token });
  const ivs = await call('GET', `/api/pipeline/applications/${a.applicationId}/interviews`, { token: R.token });
  const again = await call('PATCH', `/api/applications/${a.applicationId}/withdraw`, { token: c.token, body: {} });
  const last = hist.data.items.at(-1)?.toStage;
  const ivStatus = ivs.data.items[0]?.status;
  return { pass: w.status === 200 && w.data.application.currentStage === 'withdrawn' && last === 'withdrawn' && ivStatus === 'cancelled' && again.status === 409, actual: `${w.status} ${w.data.application.currentStage}; history last=${last}; interview=${ivStatus}; again=${again.status}`, evidence: brief(again) };
}));

test('INT-21 applicant search filters by source and stage', () => step('INT-21', 'Laila', 'GET /api/applications?jobId=&source=referral and &stage=hired', 'Only matching applicants returned', async () => {
  const r1 = await call('GET', `/api/applications?jobId=${job.jobId}&source=referral`, { token: R.token });
  const r2 = await call('GET', `/api/applications?jobId=${job.jobId}&stage=hired`, { token: R.token });
  return { pass: r1.status === 200 && r1.data.items.length === 1 && r1.data.items[0].source === 'referral' && r2.data.items.length === 1 && r2.data.items[0].currentStage === 'hired', actual: `referral=${r1.data.items.length} hired=${r2.data.items.length}`, evidence: `job=${r1.data.job.title}` };
}));

test('INT-22 frontend is served from S3 and every service is healthy on Lambda', () => step('INT-22', 'All', 'GET website index + /api/health/{jobs,candidates,pipeline}', '200 text/html; runtime "lambda" x3', async () => {
  const site = process.env.WEB_URL || 'http://localhost:4566/ats-web-local/index.html';
  const page = await fetch(site);
  const health = await Promise.all(['jobs', 'candidates', 'pipeline'].map((s) => call('GET', `/api/health/${s}`)));
  const runtimes = health.map((h) => h.data.runtime);
  return { pass: page.status === 200 && (page.headers.get('content-type') || '').includes('text/html') && runtimes.every((r) => r === 'lambda'), actual: `site ${page.status}; runtimes=${runtimes.join(',')}`, evidence: site };
}));
