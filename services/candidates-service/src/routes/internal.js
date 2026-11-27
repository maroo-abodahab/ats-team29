// /api/internal/*: called ONLY by other ATS services (Lambda-to-Lambda, service token).
// Not routed through API Gateway, so unreachable from the internet.
//
//   GET   /api/internal/jobs/:jobId/application-count   jobs: may this job be unpublished?
//   GET   /api/internal/applications/:id                pipeline: load an application
//   POST  /api/internal/applications/query              pipeline (board) + jobs (analytics)
//   PATCH /api/internal/applications/:id/stage          pipeline: move the current stage
const express = require('express');
const { requireService, requireUuid, validate, notFound, conflict, log } = require('@ats/shared');
const applications = require('../repositories/applicationRepo');

const router = express.Router();
router.use(requireService());

const STAGES = ['applied', 'screening', 'shortlisted', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'];

router.get('/jobs/:jobId/application-count', async (req, res) => {
  const items = await applications.listByJob(requireUuid(req.params.jobId, 'jobId'));
  res.json({ count: items.length });
});

router.get('/applications/:id', async (req, res) => {
  const application = await applications.get(requireUuid(req.params.id));
  if (!application) throw notFound('Application');
  res.json({ application });
});

router.post('/applications/query', async (req, res) => {
  const body = validate(req.body, {
    jobIds: { type: 'array', required: true, maxItems: 200, items: { type: 'uuid' } },
    stages: { type: 'array', maxItems: 8, items: { type: 'string', enum: STAGES } },
    from: { type: 'date' },
    to: { type: 'date' }
  });
  const lists = await Promise.all(body.jobIds.map((jobId) => applications.listByJob(jobId)));
  let items = lists.flat();
  if (body.stages) items = items.filter((a) => body.stages.includes(a.currentStage));
  if (body.from) items = items.filter((a) => a.submittedAt >= body.from);
  if (body.to) items = items.filter((a) => a.submittedAt <= body.to);
  res.json({ items });
});

router.patch('/applications/:id/stage', async (req, res) => {
  const id = requireUuid(req.params.id);
  const body = validate(req.body, {
    fromStage: { type: 'string', required: true, enum: STAGES },
    toStage: { type: 'string', required: true, enum: STAGES },
    rejectionReason: { type: 'string', max: 300 }
  });
  const updated = await applications.changeStage(id, body.fromStage, body.toStage, { rejectionReason: body.rejectionReason });
  if (!updated) {
    if (!(await applications.get(id))) throw notFound('Application');
    throw conflict('The application stage changed meanwhile. Reload and try again.', 'STALE');
  }
  log.info('APPLICATION_STAGE_SET', { applicationId: id, from: body.fromStage, to: body.toStage, caller: req.caller });
  res.json({ application: updated });
});

module.exports = router;
