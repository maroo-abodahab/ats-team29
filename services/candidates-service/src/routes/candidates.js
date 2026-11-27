// /api/candidates: candidate profiles and CVs (owner: Laila).
//
//   GET  /api/candidates/me          candidate   my profile
//   PUT  /api/candidates/me          candidate   create (201) or update (200) my profile
//   PUT  /api/candidates/me/cv       candidate   upload or replace my CV (PDF/DOCX, max 2 MB)
//   GET  /api/candidates/me/cv       candidate   short-lived download link for my CV
//   GET  /api/candidates/:id         staff       a candidate's profile (if allowed to see one of their applications)
//   GET  /api/candidates/:id/cv      staff       download link for a candidate's CV (same rule, every download logged)
//
// The profile key is ALWAYS the user id from the JWT. There is no request field that
// says "whose profile", so a candidate cannot read or overwrite someone else's.
const express = require('express');
const {
  validate, requireUuid, requireAuth, requireRole, log, ROLES, ApiError, notFound, forbidden, conflict
} = require('@ats/shared');
const candidates = require('../repositories/candidateRepo');
const applications = require('../repositories/applicationRepo');
const cvStorage = require('../repositories/cvStorage');
const { canSeeApplication } = require('../access');

const router = express.Router();

const profileSchema = {
  fullName: { type: 'string', required: true, min: 2, max: 80 },
  phone: { type: 'string', required: true, pattern: /^\+?[0-9 ()-]{7,20}$/, patternMessage: 'must be a valid phone number' },
  location: { type: 'string', max: 80 },
  headline: { type: 'string', max: 120 },
  summary: { type: 'string', max: 2000 },
  skills: { type: 'array', maxItems: 30, items: { type: 'string', min: 1, max: 40 } },
  yearsExperience: { type: 'integer', min: 0, max: 60 },
  linkedinUrl: { type: 'string', max: 200, pattern: /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/[\w\-/%]+$/i, patternMessage: 'must be a https://linkedin.com/... link' }
};

function publicProfile(p) {
  if (!p) return null;
  const { cv, ...rest } = p;
  return { ...rest, cv: cv ? { fileName: cv.fileName, contentType: cv.contentType, size: cv.size, uploadedAt: cv.uploadedAt } : null };
}

router.get('/me', requireAuth(), requireRole(ROLES.CANDIDATE), async (req, res) => {
  const profile = await candidates.get(req.user.userId);
  if (!profile) throw notFound('Profile');
  res.json({ profile: publicProfile(profile) });
});

router.put('/me', requireAuth(), requireRole(ROLES.CANDIDATE), async (req, res) => {
  const body = validate(req.body, profileSchema);
  const { item, created } = await candidates.upsert(req.user.userId, req.user.email, body);
  log.info(created ? 'PROFILE_CREATED' : 'PROFILE_UPDATED', { userId: req.user.userId });
  res.status(created ? 201 : 200).json({ profile: publicProfile(item) });
});

router.put('/me/cv', requireAuth(), requireRole(ROLES.CANDIDATE), async (req, res) => {
  const body = validate(req.body, {
    fileName: { type: 'string', required: true, min: 5, max: 120, pattern: /^[\w\- .()]+\.(pdf|docx)$/i, patternMessage: 'must end in .pdf or .docx and use simple characters' },
    contentType: { type: 'string', required: true, max: 100 },
    contentBase64: { type: 'string', required: true, max: 3_000_000 }
  });
  const profile = await candidates.get(req.user.userId);
  if (!profile) throw conflict('Create your profile before uploading a CV.', 'PROFILE_REQUIRED');

  const buffer = Buffer.from(body.contentBase64, 'base64');
  const result = cvStorage.inspect(body.fileName, body.contentType, buffer);
  if (result.error) {
    log.security('CV_REJECTED', { userId: req.user.userId, reason: result.error.message, size: buffer.length });
    throw new ApiError(result.error.status, result.error.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'UNSUPPORTED_FILE', result.error.message);
  }

  const key = await cvStorage.save(req.user.userId, buffer, result.ext, result.mime);
  const cv = { key, fileName: body.fileName, contentType: result.mime, size: buffer.length, uploadedAt: new Date().toISOString() };
  const previous = await candidates.setCv(req.user.userId, cv);
  if (previous?.key) await cvStorage.remove(previous.key).catch(() => {}); // replace = delete the old file
  log.info(previous ? 'CV_REPLACED' : 'CV_UPLOADED', { userId: req.user.userId, size: cv.size, type: result.ext });
  res.status(previous ? 200 : 201).json({ cv: publicProfile({ cv }).cv });
});

router.get('/me/cv', requireAuth(), requireRole(ROLES.CANDIDATE), async (req, res) => {
  const profile = await candidates.get(req.user.userId);
  if (!profile?.cv) throw notFound('CV');
  res.json({ url: await cvStorage.downloadUrl(profile.cv), expiresIn: 300, fileName: profile.cv.fileName });
});

// Staff may open a candidate only if they may see at least one of that candidate's applications.
async function assertStaffCanSeeCandidate(user, candidateId) {
  const apps = await applications.listByCandidate(candidateId);
  const cache = new Map();
  for (const app of apps) {
    if (await canSeeApplication(user, app, cache)) return apps;
  }
  log.security('OWNERSHIP_DENIED', { userId: user.userId, role: user.role, candidateId });
  throw forbidden('You are not allowed to view this candidate.');
}

router.get('/:id', requireAuth(), requireRole(ROLES.RECRUITER, ROLES.HIRING_MANAGER), async (req, res) => {
  const id = requireUuid(req.params.id);
  const profile = await candidates.get(id);
  if (!profile) throw notFound('Candidate');
  await assertStaffCanSeeCandidate(req.user, id);
  res.json({ profile: publicProfile(profile) });
});

router.get('/:id/cv', requireAuth(), requireRole(ROLES.RECRUITER, ROLES.HIRING_MANAGER), async (req, res) => {
  const id = requireUuid(req.params.id);
  const profile = await candidates.get(id);
  if (!profile?.cv) throw notFound('CV');
  await assertStaffCanSeeCandidate(req.user, id);
  log.security('CV_DOWNLOADED', { by: req.user.userId, role: req.user.role, candidateId: id });
  res.json({ url: await cvStorage.downloadUrl(profile.cv), expiresIn: 300, fileName: profile.cv.fileName });
});

module.exports = router;
