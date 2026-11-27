// /api/applications: submitting and tracking job applications (owner: Laila).
//
//   POST  /api/applications                candidate   apply to a published job
//   GET   /api/applications/me             candidate   my applications and their current stage
//   GET   /api/applications/:id            owner / recruiter / assigned hiring manager
//   PATCH /api/applications/:id/withdraw   candidate (owner only)   withdraw my application
//   GET   /api/applications?jobId=...      recruiter / assigned hiring manager   search applicants for a job
//
// Business rules on apply:
//   - the candidate must have a profile AND a CV;
//   - the JOBS service must confirm the job is published and not past its closing date;
//   - one application per candidate per job;
//   - at most 5 active (not finished) applications at a time per candidate.
const express = require('express');
const {
  validate, validateQuery, requireUuid, requireAuth, requireRole, log, ROLES,
  conflict, forbidden, callService, expectOk
} = require('@ats/shared');
const candidates = require('../repositories/candidateRepo');
const applications = require('../repositories/applicationRepo');
const events = require('../repositories/events');
const { assertCanSeeApplication, getJob, MANAGER_STAGES } = require('../access');

const router = express.Router();
const SOURCES = ['careers_site', 'linkedin', 'referral', 'job_board', 'university', 'other'];
const STAGES = ['applied', 'screening', 'shortlisted', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'];
const MAX_ACTIVE_APPLICATIONS = 5;

// What a candidate sees about their own application (no internal reviewer data).
const forCandidate = (a) => ({
  applicationId: a.applicationId, jobId: a.jobId, jobTitle: a.jobTitle, currentStage: a.currentStage,
  source: a.source, coverLetter: a.coverLetter, submittedAt: a.submittedAt, stageUpdatedAt: a.stageUpdatedAt,
  withdrawnAt: a.withdrawnAt
});
const forStaff = (a) => ({ ...a });

router.post('/', requireAuth(), requireRole(ROLES.CANDIDATE), async (req, res) => {
  const body = validate(req.body, {
    jobId: { type: 'uuid', required: true },
    coverLetter: { type: 'string', max: 3000 },
    source: { type: 'string', required: true, enum: SOURCES },
    sourceDetail: { type: 'string', max: 120 },
    expectedSalary: { type: 'integer', min: 0, max: 10_000_000 }
  });
  if (body.source === 'referral' && !body.sourceDetail) {
    validate({}, { sourceDetail: { type: 'string', required: true } }); // referral needs the referrer's name
  }

  const profile = await candidates.get(req.user.userId);
  if (!profile) throw conflict('Complete your profile before applying.', 'PROFILE_REQUIRED');
  if (!profile.cv) throw conflict('Upload your CV before applying.', 'CV_REQUIRED');

  // Cross-service check with the JOBS service
  const { job, acceptingApplications } = expectOk(await callService('jobs', 'GET', `/api/internal/jobs/${body.jobId}`), 'Job not found.');
  if (!acceptingApplications) throw conflict('This job is not accepting applications.', 'JOB_NOT_OPEN');

  const mine = await applications.listByCandidate(req.user.userId);
  if (mine.some((a) => a.jobId === body.jobId)) throw conflict('You have already applied to this job.', 'ALREADY_APPLIED');
  const active = mine.filter((a) => !applications.FINAL_STAGES.includes(a.currentStage)).length;
  if (active >= MAX_ACTIVE_APPLICATIONS) {
    throw conflict(`You can have at most ${MAX_ACTIVE_APPLICATIONS} active applications. Withdraw one first.`, 'TOO_MANY_ACTIVE');
  }

  const application = await applications.create({
    jobId: job.jobId,
    jobTitle: job.title,
    candidateId: req.user.userId,
    candidateName: profile.fullName,
    candidateEmail: req.user.email,
    coverLetter: body.coverLetter,
    source: body.source,
    sourceDetail: body.sourceDetail,
    expectedSalary: body.expectedSalary
  });
  log.info('APPLICATION_SUBMITTED', { applicationId: application.applicationId, jobId: job.jobId, candidateId: req.user.userId, source: body.source });
  await events.publish('APPLICATION_SUBMITTED', {
    applicationId: application.applicationId, jobId: job.jobId, jobTitle: job.title,
    candidateName: profile.fullName, candidateEmail: req.user.email
  });
  res.status(201).location(`/api/applications/${application.applicationId}`).json({ application: forCandidate(application) });
});

router.get('/me', requireAuth(), requireRole(ROLES.CANDIDATE), async (req, res) => {
  const items = await applications.listByCandidate(req.user.userId);
  res.json({ items: items.map(forCandidate) });
});

router.get('/', requireAuth(), requireRole(ROLES.RECRUITER, ROLES.HIRING_MANAGER), async (req, res) => {
  const query = validateQuery(req.query, {
    jobId: { type: 'uuid', required: true },
    stage: { type: 'string', enum: STAGES },
    source: { type: 'string', enum: SOURCES },
    q: { type: 'string', max: 80 }
  });
  const { job } = await getJob(query.jobId);
  if (req.user.role === ROLES.HIRING_MANAGER && job.hiringManagerId !== req.user.userId) {
    log.security('ACCESS_DENIED', { userId: req.user.userId, role: req.user.role, jobId: query.jobId, reason: 'not_assigned_manager' });
    throw forbidden('You can only view applicants for jobs assigned to you.');
  }
  let items = await applications.listByJob(query.jobId);
  if (req.user.role === ROLES.HIRING_MANAGER) items = items.filter((a) => MANAGER_STAGES.includes(a.currentStage));
  if (query.stage) items = items.filter((a) => a.currentStage === query.stage);
  if (query.source) items = items.filter((a) => a.source === query.source);
  if (query.q) {
    const q = query.q.toLowerCase();
    items = items.filter((a) => a.candidateName.toLowerCase().includes(q) || a.candidateEmail.toLowerCase().includes(q));
  }
  items.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  res.json({ job: { jobId: job.jobId, title: job.title, status: job.status }, items: items.map(forStaff) });
});

router.get('/:id', requireAuth(), async (req, res) => {
  const application = await applications.get(requireUuid(req.params.id));
  await assertCanSeeApplication(req.user, application);
  res.json({ application: req.user.role === ROLES.CANDIDATE ? forCandidate(application) : forStaff(application) });
});

router.patch('/:id/withdraw', requireAuth(), requireRole(ROLES.CANDIDATE), async (req, res) => {
  const id = requireUuid(req.params.id);
  const { reason } = validate(req.body, { reason: { type: 'string', max: 300 } });
  const application = await applications.get(id);
  await assertCanSeeApplication(req.user, application); // owner check (403 for someone else's)
  if (applications.FINAL_STAGES.includes(application.currentStage)) {
    throw conflict(`An application that is ${application.currentStage} cannot be withdrawn.`, 'ILLEGAL_TRANSITION');
  }
  const updated = await applications.changeStage(id, application.currentStage, 'withdrawn', { withdrawReason: reason });
  if (!updated) throw conflict('The application changed meanwhile. Reload and try again.', 'STALE');

  // Tell the PIPELINE service so its stage history (audit trail) stays complete.
  await callService('pipeline', 'POST', `/api/internal/applications/${id}/history`, {
    body: { fromStage: application.currentStage, toStage: 'withdrawn', reason: reason || 'Withdrawn by candidate', changedBy: req.user.userId, jobId: application.jobId }
  }).catch(() => log.warn('HISTORY_SYNC_FAILED', { applicationId: id }));
  await events.publish('APPLICATION_WITHDRAWN', {
    applicationId: id, jobId: application.jobId, jobTitle: application.jobTitle,
    candidateName: application.candidateName, candidateEmail: application.candidateEmail
  });
  log.info('APPLICATION_WITHDRAWN', { applicationId: id, candidateId: req.user.userId, fromStage: application.currentStage });
  res.json({ application: forCandidate(updated) });
});

module.exports = router;
