// /api/internal/*: called ONLY by the other ATS services (Lambda-to-Lambda).
// These routes are NOT added to API Gateway, so they cannot be reached from the
// internet at all, and every call must also carry a valid 60-second service token.
//
//   GET  /api/internal/jobs/:id          candidates (can this job be applied to?), pipeline (who is the hiring manager?)
//   POST /api/internal/jobs/:id/hires    pipeline: a candidate was hired -> count it, auto-close when full
//   GET  /api/internal/users/:id         pipeline: check an interviewer / show a reviewer's name
const express = require('express');
const { requireService, requireUuid, notFound, log } = require('@ats/shared');
const jobs = require('../repositories/jobRepo');
const users = require('../repositories/userRepo');

const router = express.Router();
router.use(requireService());

router.get('/jobs/:id', async (req, res) => {
  const job = await jobs.getJob(requireUuid(req.params.id));
  if (!job) throw notFound('Job');
  const today = new Date().toISOString().slice(0, 10);
  res.json({ job, acceptingApplications: job.status === 'published' && (!job.closingDate || job.closingDate >= today) });
});

router.post('/jobs/:id/hires', async (req, res) => {
  const id = requireUuid(req.params.id);
  const result = await jobs.recordHire(id, `service:${req.caller}`);
  if (!result) throw notFound('Job');
  log.info('JOB_HIRE_RECORDED', { jobId: id, hiredCount: result.job.hiredCount, autoClosed: result.autoClosed, caller: req.caller });
  res.json(result);
});

router.get('/users/:id', async (req, res) => {
  const user = await users.getById(requireUuid(req.params.id));
  if (!user) throw notFound('User');
  res.json({ user: users.publicUser(user) });
});

module.exports = router;
