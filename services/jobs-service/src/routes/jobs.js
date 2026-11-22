// /api/jobs and /api/departments: Job Management (owner: Marwan).
//
//   GET    /api/jobs                 public*     search + filter + paginate (*visibility depends on role)
//   GET    /api/jobs/:id             public*     one job
//   POST   /api/jobs                 recruiter   create (always starts as draft)
//   PUT    /api/jobs/:id             recruiter   edit (not allowed once closed)
//   PATCH  /api/jobs/:id/status      recruiter   publish / unpublish / close (status workflow)
//   GET    /api/jobs/:id/history     recruiter   status audit trail
//   GET    /api/departments          public      list (for filters and forms)
//   POST   /api/departments          recruiter   create
//   DELETE /api/departments/:id      recruiter   delete (only if it has no jobs)
//
// Visibility rule: anonymous users and candidates see PUBLISHED jobs only.
// Recruiters see everything. Hiring managers see published jobs + jobs assigned to them.
const express = require('express');
const {
  validate, validateQuery, requireUuid, requireAuth, optionalAuth, requireRole, log, ROLES,
  badRequest, notFound, conflict, callService, expectOk
} = require('@ats/shared');
const jobs = require('../repositories/jobRepo');
const users = require('../repositories/userRepo');

const jobsRouter = express.Router();
const departmentsRouter = express.Router();

const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'internship'];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const jobSchema = (required) => ({
  title: { type: 'string', required, min: 3, max: 120 },
  description: { type: 'string', required, min: 20, max: 5000 },
  requirements: { type: 'string', max: 3000 },
  location: { type: 'string', required, min: 2, max: 80 },
  employmentType: { type: 'string', required, enum: EMPLOYMENT_TYPES },
  departmentId: { type: 'uuid', required },
  hiringManagerId: { type: 'uuid' },
  openings: { type: 'integer', min: 1, max: 50 },
  salaryMin: { type: 'integer', min: 0, max: 10_000_000 },
  salaryMax: { type: 'integer', min: 0, max: 10_000_000 },
  closingDate: { type: 'string', pattern: DATE_ONLY, patternMessage: 'must be a date like 2026-12-31' }
});

function visibilityFor(user) {
  if (user?.role === ROLES.RECRUITER) return { mode: 'all' };
  if (user?.role === ROLES.HIRING_MANAGER) return { mode: 'manager', userId: user.userId };
  return { mode: 'public' };
}

function canSee(job, user) {
  const v = visibilityFor(user);
  if (v.mode === 'all') return true;
  if (job.status === 'published') return true;
  return v.mode === 'manager' && job.hiringManagerId === user.userId;
}

// Business rules shared by create and edit
async function checkJobRules(job) {
  if (job.salaryMin !== undefined && job.salaryMax !== undefined && job.salaryMin > job.salaryMax) {
    throw badRequest('Salary range is invalid.', [{ field: 'salaryMax', message: 'must be greater than or equal to salaryMin' }]);
  }
  if (job.closingDate && job.closingDate < new Date().toISOString().slice(0, 10)) {
    throw badRequest('Closing date is in the past.', [{ field: 'closingDate', message: 'must be today or later' }]);
  }
  if (job.departmentId && !(await jobs.getDepartment(job.departmentId))) {
    throw badRequest('Department does not exist.', [{ field: 'departmentId', message: 'unknown department' }]);
  }
  if (job.hiringManagerId) {
    const manager = await users.getById(job.hiringManagerId);
    if (!manager || manager.role !== ROLES.HIRING_MANAGER || manager.active === false) {
      throw badRequest('Hiring manager is not valid.', [{ field: 'hiringManagerId', message: 'must be an active hiring manager' }]);
    }
  }
}

jobsRouter.get('/', optionalAuth(), async (req, res) => {
  const query = validateQuery(req.query, {
    q: { type: 'string', max: 100 },
    departmentId: { type: 'uuid' },
    status: { type: 'string', enum: ['draft', 'published', 'closed'] },
    location: { type: 'string', max: 80 },
    employmentType: { type: 'string', enum: EMPLOYMENT_TYPES },
    page: { type: 'integer', min: 1, max: 1000, default: 1 },
    limit: { type: 'integer', min: 1, max: 50, default: 10 }
  });
  const result = await jobs.searchJobs(query, visibilityFor(req.user));
  res.json(result);
});

jobsRouter.get('/:id', optionalAuth(), async (req, res) => {
  const job = await jobs.getJob(requireUuid(req.params.id));
  if (!job || !canSee(job, req.user)) throw notFound('Job'); // hidden drafts look like "not found"
  res.json({ job });
});

jobsRouter.post('/', requireAuth(), requireRole(ROLES.RECRUITER), async (req, res) => {
  const body = validate(req.body, jobSchema(true));
  await checkJobRules(body);
  const job = await jobs.createJob(body, req.user.userId);
  log.info('JOB_CREATED', { jobId: job.jobId, by: req.user.userId });
  res.status(201).location(`/api/jobs/${job.jobId}`).json({ job });
});

jobsRouter.put('/:id', requireAuth(), requireRole(ROLES.RECRUITER), async (req, res) => {
  const id = requireUuid(req.params.id);
  const body = validate(req.body, jobSchema(false));
  const current = await jobs.getJob(id);
  if (!current) throw notFound('Job');
  if (current.status === 'closed') throw conflict('A closed job cannot be edited.', 'JOB_CLOSED');
  const merged = { ...current, ...body };
  await checkJobRules({ ...body, salaryMin: merged.salaryMin ?? undefined, salaryMax: merged.salaryMax ?? undefined });
  if (body.openings !== undefined && body.openings < current.hiredCount) {
    throw conflict(`Openings cannot be lower than the ${current.hiredCount} people already hired.`, 'OPENINGS_TOO_LOW');
  }
  const job = await jobs.updateJob(id, body);
  log.info('JOB_UPDATED', { jobId: id, by: req.user.userId, fields: Object.keys(body) });
  res.json({ job });
});

// Status workflow:  draft -> published -> closed,  published -> draft (unpublish),  draft -> closed
const TRANSITIONS = { draft: ['published', 'closed'], published: ['draft', 'closed'], closed: [] };

jobsRouter.patch('/:id/status', requireAuth(), requireRole(ROLES.RECRUITER), async (req, res) => {
  const id = requireUuid(req.params.id);
  const { status, reason } = validate(req.body, {
    status: { type: 'string', required: true, enum: ['draft', 'published', 'closed'] },
    reason: { type: 'string', min: 3, max: 200 }
  });
  const job = await jobs.getJob(id);
  if (!job) throw notFound('Job');
  if (job.status === status) throw conflict(`Job is already ${status}.`, 'NO_CHANGE');
  if (!TRANSITIONS[job.status].includes(status)) {
    throw conflict(`A ${job.status} job cannot be moved to ${status}.`, 'ILLEGAL_TRANSITION');
  }

  if (status === 'published') {
    const problems = [];
    if (!job.hiringManagerId) problems.push({ field: 'hiringManagerId', message: 'assign a hiring manager before publishing' });
    if (job.description.length < 50) problems.push({ field: 'description', message: 'must be at least 50 characters to publish' });
    if (job.closingDate && job.closingDate < new Date().toISOString().slice(0, 10)) problems.push({ field: 'closingDate', message: 'is in the past' });
    if (problems.length) throw conflict('The job is not ready to publish: ' + problems.map((p) => `${p.field} ${p.message}`).join('; '), 'NOT_READY');
  }
  if (status === 'draft') {
    // Cross-service rule: cannot unpublish once people have applied (asks the candidates service).
    const { count } = expectOk(await callService('candidates', 'GET', `/api/internal/jobs/${id}/application-count`));
    if (count > 0) throw conflict(`This job already has ${count} application(s); close it instead of unpublishing.`, 'HAS_APPLICATIONS');
  }
  if (status === 'closed' && !reason) throw badRequest('A reason is required to close a job.', [{ field: 'reason', message: 'is required when closing' }]);

  const changed = await jobs.changeStatus(id, job.status, status, reason, req.user.userId);
  if (!changed) throw conflict('The job was changed by someone else. Reload and try again.', 'STALE');
  log.info('JOB_STATUS_CHANGED', { jobId: id, from: job.status, to: status, by: req.user.userId });
  res.json({ job: await jobs.getJob(id) });
});

jobsRouter.get('/:id/history', requireAuth(), requireRole(ROLES.RECRUITER), async (req, res) => {
  const id = requireUuid(req.params.id);
  if (!(await jobs.getJob(id))) throw notFound('Job');
  res.json({ items: await jobs.jobHistory(id) });
});

// ---- Departments ----------------------------------------------------------
departmentsRouter.get('/', async (req, res) => {
  res.json({ items: await jobs.listDepartments() });
});

departmentsRouter.post('/', requireAuth(), requireRole(ROLES.RECRUITER), async (req, res) => {
  const body = validate(req.body, { name: { type: 'string', required: true, min: 2, max: 80 }, description: { type: 'string', max: 300 } });
  try {
    const department = await jobs.createDepartment({ ...body, createdBy: req.user.userId });
    res.status(201).json({ department });
  } catch (err) {
    if (err.code === '23505') throw conflict('A department with this name already exists.', 'DEPARTMENT_EXISTS');
    throw err;
  }
});

departmentsRouter.delete('/:id', requireAuth(), requireRole(ROLES.RECRUITER), async (req, res) => {
  const id = requireUuid(req.params.id);
  try {
    if (!(await jobs.deleteDepartment(id))) throw notFound('Department');
  } catch (err) {
    if (err.code === '23503') throw conflict('This department still has jobs.', 'DEPARTMENT_IN_USE');
    throw err;
  }
  log.info('DEPARTMENT_DELETED', { departmentId: id, by: req.user.userId });
  res.status(204).end();
});

module.exports = { jobsRouter, departmentsRouter };
