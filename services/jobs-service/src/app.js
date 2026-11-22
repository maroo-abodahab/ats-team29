// Jobs service (owner: Marwan): Job Management + Hiring Analytics + shared Auth.
// Deployed as its own Lambda (ats-jobs-service) behind API Gateway routes
// /api/auth/*, /api/jobs/*, /api/departments/*, /api/analytics/*.
const { createApp, rateLimit } = require('@ats/shared');
const authRoutes = require('./routes/auth');
const { jobsRouter, departmentsRouter } = require('./routes/jobs');
const analyticsRoutes = require('./routes/analytics');
const internalRoutes = require('./routes/internal');

module.exports = createApp({
  serviceName: 'jobs-service',
  healthPath: '/api/health/jobs',
  mount(app) {
    app.use('/api/internal', internalRoutes);
    app.use('/api', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'jobs' }));
    app.use('/api/auth', authRoutes);
    app.use('/api/jobs', jobsRouter);
    app.use('/api/departments', departmentsRouter);
    app.use('/api/analytics', analyticsRoutes);
  }
});
