// Who may see which application / candidate (object-level authorization).
//   candidate       -> only their OWN applications and profile (candidateId === token user id)
//   recruiter       -> every application
//   hiring manager  -> applications for jobs ASSIGNED to them, and only once the
//                      candidate is shortlisted or later (privacy: managers do not see
//                      everyone who applied, only people HR has shortlisted)
// The job's hiring manager is asked from the JOBS service, so a re-assignment there
// takes effect here immediately.
const { ROLES, callService, expectOk, forbidden, notFound, log } = require('@ats/shared');

const MANAGER_STAGES = ['shortlisted', 'interview', 'offer', 'hired'];

async function getJob(jobId, cache = new Map()) {
  if (!cache.has(jobId)) {
    cache.set(jobId, callService('jobs', 'GET', `/api/internal/jobs/${jobId}`).then((r) => expectOk(r, 'Job not found.')));
  }
  return cache.get(jobId);
}

async function canSeeApplication(user, application, cache) {
  if (user.role === ROLES.RECRUITER) return true;
  if (user.role === ROLES.CANDIDATE) return application.candidateId === user.userId;
  if (user.role === ROLES.HIRING_MANAGER) {
    if (!MANAGER_STAGES.includes(application.currentStage)) return false;
    const { job } = await getJob(application.jobId, cache);
    return job.hiringManagerId === user.userId;
  }
  return false;
}

// Throws 404 when the record does not exist and 403 when it exists but is not yours.
async function assertCanSeeApplication(user, application, cache) {
  if (!application) throw notFound('Application');
  if (!(await canSeeApplication(user, application, cache))) {
    log.security('OWNERSHIP_DENIED', { userId: user.userId, role: user.role, applicationId: application.applicationId });
    throw forbidden('You are not allowed to access this application.');
  }
}

module.exports = { canSeeApplication, assertCanSeeApplication, getJob, MANAGER_STAGES };
