// /api/analytics: Hiring Analytics (owner: Marwan).
// Shows the three KPIs the project brief asks for: time-to-hire, candidates per
// stage and source of applicants, plus a stage funnel and time spent per stage.
//
//   GET  /api/analytics/overview     recruiter (all jobs) | hiring manager (own jobs only)
//   POST /api/analytics/snapshots    recruiter   save the current numbers (stored in Neon)
//   GET  /api/analytics/snapshots    recruiter   list saved snapshots to compare over time
//
// This is the most "integrated" endpoint in the system: it reads jobs from Neon,
// applications from the CANDIDATES service and stage history from the PIPELINE
// service (both via Lambda-to-Lambda calls), then calculates the metrics.
const express = require('express');
const { validate, validateQuery, requireAuth, requireRole, ROLES, forbidden, notFound, callService, expectOk } = require('@ats/shared');
const jobs = require('../repositories/jobRepo');

const router = express.Router();
const STAGES = ['applied', 'screening', 'shortlisted', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'];
const FUNNEL = ['applied', 'screening', 'shortlisted', 'interview', 'offer', 'hired'];
const DAY_MS = 86_400_000;

const round1 = (n) => Math.round(n * 10) / 10;
function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const scopeSchema = {
  jobId: { type: 'uuid' },
  departmentId: { type: 'uuid' },
  from: { type: 'date' },
  to: { type: 'date' }
};

async function buildOverview(user, scope) {
  // 1. Which jobs is this user allowed to analyse?
  const managerId = user.role === ROLES.HIRING_MANAGER ? user.userId : undefined;
  if (scope.jobId) {
    const job = await jobs.getJob(scope.jobId);
    if (!job) throw notFound('Job');
    if (managerId && job.hiringManagerId !== managerId) throw forbidden('You can only view analytics for jobs assigned to you.');
  }
  const jobList = await jobs.jobsForScope({ jobId: scope.jobId, departmentId: scope.departmentId, managerId });
  const jobIds = jobList.map((j) => j.jobId);
  const empty = { jobs: { total: 0, draft: 0, published: 0, closed: 0 }, totalApplications: 0 };
  if (!jobIds.length) return { ...empty, candidatesPerStage: Object.fromEntries(STAGES.map((s) => [s, 0])), sources: [], timeToHire: { hires: 0, averageDays: null, medianDays: null, byJob: [] }, funnel: [], stageDurations: {}, generatedAt: new Date().toISOString() };

  // 2. Ask the other two services for their data (in parallel).
  const [appsRes, pipeRes] = await Promise.all([
    callService('candidates', 'POST', '/api/internal/applications/query', { body: { jobIds, from: scope.from, to: scope.to } }),
    callService('pipeline', 'POST', '/api/internal/analytics/stages', { body: { jobIds } })
  ]);
  const applications = expectOk(appsRes).items;
  const pipeline = expectOk(pipeRes);

  // 3. Candidates per stage (current stage of every application)
  const candidatesPerStage = Object.fromEntries(STAGES.map((s) => [s, 0]));
  applications.forEach((a) => { candidatesPerStage[a.currentStage] = (candidatesPerStage[a.currentStage] || 0) + 1; });

  // 4. Source of applicants, with hires and conversion per source
  const bySource = new Map();
  applications.forEach((a) => {
    const s = bySource.get(a.source) || { source: a.source, applications: 0, hires: 0 };
    s.applications += 1;
    if (a.currentStage === 'hired') s.hires += 1;
    bySource.set(a.source, s);
  });
  const sources = [...bySource.values()]
    .map((s) => ({ ...s, share: round1((s.applications / applications.length) * 100), hireRate: round1((s.hires / s.applications) * 100) }))
    .sort((a, b) => b.applications - a.applications);

  // 5. Time-to-hire = days from application submitted to the "hired" stage
  const hired = applications.filter((a) => a.currentStage === 'hired' && a.hiredAt);
  const days = hired.map((a) => (Date.parse(a.hiredAt) - Date.parse(a.submittedAt)) / DAY_MS);
  const titleOf = Object.fromEntries(jobList.map((j) => [j.jobId, j.title]));
  const perJob = new Map();
  hired.forEach((a, i) => {
    const e = perJob.get(a.jobId) || { jobId: a.jobId, title: titleOf[a.jobId], hires: 0, totalDays: 0 };
    e.hires += 1; e.totalDays += days[i];
    perJob.set(a.jobId, e);
  });
  const timeToHire = {
    hires: hired.length,
    averageDays: days.length ? round1(days.reduce((x, y) => x + y, 0) / days.length) : null,
    medianDays: days.length ? round1(median(days)) : null,
    fastestDays: days.length ? round1(Math.min(...days)) : null,
    slowestDays: days.length ? round1(Math.max(...days)) : null,
    byJob: [...perJob.values()].map((e) => ({ jobId: e.jobId, title: e.title, hires: e.hires, averageDays: round1(e.totalDays / e.hires) }))
  };

  // 6. Funnel: how many applications ever reached each stage (from the pipeline's history)
  const reached = pipeline.reached || {};
  const funnel = FUNNEL.map((stage, i) => {
    const count = stage === 'applied' ? applications.length : (reached[stage] || 0);
    return { stage, count, conversionFromApplied: applications.length ? round1((count / applications.length) * 100) : 0, index: i };
  });

  return {
    jobs: {
      total: jobList.length,
      draft: jobList.filter((j) => j.status === 'draft').length,
      published: jobList.filter((j) => j.status === 'published').length,
      closed: jobList.filter((j) => j.status === 'closed').length
    },
    totalApplications: applications.length,
    candidatesPerStage,
    sources,
    timeToHire,
    funnel,
    stageDurations: pipeline.averageDaysInStage || {},
    generatedAt: new Date().toISOString()
  };
}

router.get('/overview', requireAuth(), requireRole(ROLES.RECRUITER, ROLES.HIRING_MANAGER), async (req, res) => {
  const scope = validateQuery(req.query, scopeSchema);
  res.json({ scope, metrics: await buildOverview(req.user, scope) });
});

router.post('/snapshots', requireAuth(), requireRole(ROLES.RECRUITER), async (req, res) => {
  const body = validate(req.body, { label: { type: 'string', required: true, min: 3, max: 80 }, ...scopeSchema });
  const { label, ...scope } = body;
  const metrics = await buildOverview(req.user, scope);
  const saved = await jobs.saveSnapshot({ label, scope, metrics, takenBy: req.user.userId });
  res.status(201).json({ snapshot: { snapshotId: Number(saved.id), label, scope, metrics, takenAt: saved.taken_at } });
});

router.get('/snapshots', requireAuth(), requireRole(ROLES.RECRUITER), async (req, res) => {
  res.json({ items: await jobs.listSnapshots() });
});

module.exports = router;
