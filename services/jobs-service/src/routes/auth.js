// /api/auth: shared identity for the whole ATS (led by Marwan).
//
//   POST  /api/auth/register            public      candidate self-registration (role is ALWAYS candidate)
//   POST  /api/auth/login               public      email + password -> JWT (1 hour)
//   GET   /api/auth/me                  any user    who am I
//   POST  /api/auth/staff               recruiter   create a recruiter or hiring manager account
//   GET   /api/auth/staff               recruiter   list staff (for hiring-manager / interviewer pickers)
//   PATCH /api/auth/staff/:id/status    recruiter   activate / deactivate a staff account
const express = require('express');
const bcrypt = require('bcryptjs');
const {
  validate, requireUuid, requireAuth, requireRole, signUserToken, rateLimit, log,
  ROLES, ApiError, unauthorized, notFound, conflict
} = require('@ats/shared');
const users = require('../repositories/userRepo');

const router = express.Router();
const BCRYPT_ROUNDS = 10;
// Compared against when the email does not exist, so a wrong email and a wrong
// password take the same time (an attacker cannot discover which emails exist).
let dummyHash;
const getDummyHash = () => (dummyHash ||= bcrypt.hashSync('timing-equaliser-not-a-password', BCRYPT_ROUNDS));

const PASSWORD_RULE = {
  type: 'string', required: true, min: 8, max: 72,
  pattern: /^(?=.*[A-Za-z])(?=.*\d).+$/, patternMessage: 'must contain at least one letter and one number'
};
const NAME_RULE = { type: 'string', required: true, min: 2, max: 80 };

const authLimiter = rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'auth' });

router.post('/register', authLimiter, async (req, res) => {
  const body = validate(req.body, { name: NAME_RULE, email: { type: 'email', required: true, max: 254 }, password: PASSWORD_RULE });
  const passwordHash = await bcrypt.hash(body.password, BCRYPT_ROUNDS);
  const user = await users.create({ name: body.name, email: body.email, passwordHash, role: ROLES.CANDIDATE });
  log.security('USER_REGISTERED', { userId: user.userId, role: user.role });
  const token = await signUserToken(user);
  res.status(201).json({ token, user: users.publicUser(user) });
});

router.post('/login', authLimiter, async (req, res) => {
  const body = validate(req.body, { email: { type: 'email', required: true, max: 254 }, password: { type: 'string', required: true, max: 72 } });
  const user = await users.getByEmail(body.email);

  if (user && user.lockedUntil && Date.parse(user.lockedUntil) > Date.now()) {
    log.security('LOGIN_BLOCKED_LOCKED', { userId: user.userId, ip: req.clientIp });
    throw new ApiError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again after ${new Date(user.lockedUntil).toISOString()}.`);
  }

  const ok = await bcrypt.compare(body.password, user ? user.passwordHash : getDummyHash());
  if (!user || !ok || user.active === false) {
    if (user && !ok) {
      const { locked } = await users.recordFailedLogin(user);
      if (locked) log.security('ACCOUNT_LOCKED', { userId: user.userId, ip: req.clientIp, minutes: users.LOCK_MINUTES });
    }
    log.security('LOGIN_FAILED', { userKnown: Boolean(user), inactive: user?.active === false, ip: req.clientIp });
    throw unauthorized('Email or password is incorrect.'); // one generic message
  }

  await users.recordSuccessfulLogin(user.userId);
  log.security('LOGIN_SUCCESS', { userId: user.userId, role: user.role, ip: req.clientIp });
  const token = await signUserToken(user);
  res.json({ token, expiresIn: 3600, user: users.publicUser(user) });
});

router.get('/me', requireAuth(), async (req, res) => {
  const user = await users.getById(req.user.userId);
  if (!user) throw notFound('User');
  res.json({ user: users.publicUser(user) });
});

router.post('/staff', requireAuth(), requireRole(ROLES.RECRUITER), async (req, res) => {
  const body = validate(req.body, {
    name: NAME_RULE,
    email: { type: 'email', required: true, max: 254 },
    password: PASSWORD_RULE,
    role: { type: 'string', required: true, enum: [ROLES.RECRUITER, ROLES.HIRING_MANAGER] }
  });
  const passwordHash = await bcrypt.hash(body.password, BCRYPT_ROUNDS);
  const user = await users.create({ ...body, passwordHash, createdBy: req.user.userId });
  log.security('STAFF_CREATED', { by: req.user.userId, userId: user.userId, role: user.role });
  res.status(201).json({ user: users.publicUser(user) });
});

router.get('/staff', requireAuth(), requireRole(ROLES.RECRUITER), async (req, res) => {
  const role = req.query.role;
  if (role !== undefined && ![ROLES.RECRUITER, ROLES.HIRING_MANAGER].includes(role)) {
    validate({ role }, { role: { type: 'string', enum: [ROLES.RECRUITER, ROLES.HIRING_MANAGER] } });
  }
  const staff = await users.listStaff(role);
  res.json({ items: staff.map(users.publicUser) });
});

router.patch('/staff/:id/status', requireAuth(), requireRole(ROLES.RECRUITER), async (req, res) => {
  const id = requireUuid(req.params.id);
  const { active } = validate(req.body, { active: { type: 'boolean', required: true } });
  if (id === req.user.userId) throw conflict('You cannot deactivate your own account.');
  const target = await users.getById(id);
  if (!target || target.role === ROLES.CANDIDATE) throw notFound('Staff member');
  const updated = await users.setActive(id, active);
  log.security(active ? 'STAFF_ACTIVATED' : 'STAFF_DEACTIVATED', { by: req.user.userId, userId: id });
  res.json({ user: users.publicUser(updated) });
});

module.exports = router;
