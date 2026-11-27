// Candidates service (owner: Laila): candidate profiles, CV storage, applications.
// Deployed as its own Lambda (ats-candidates-service) behind API Gateway routes
// /api/candidates/* and /api/applications/*.
const { createApp, rateLimit } = require('@ats/shared');
const candidateRoutes = require('./routes/candidates');
const applicationRoutes = require('./routes/applications');
const internalRoutes = require('./routes/internal');

module.exports = createApp({
  serviceName: 'candidates-service',
  healthPath: '/api/health/candidates',
  mount(app) {
    app.use('/api/internal', internalRoutes);
    app.use('/api', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'candidates' }));
    app.use('/api/candidates', candidateRoutes);
    app.use('/api/applications', applicationRoutes);
  }
});
