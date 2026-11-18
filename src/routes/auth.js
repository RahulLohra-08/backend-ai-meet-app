import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import User from '../models/User.js';
import { env } from '../config/env.js';
import { requireAuth, signAccessToken } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { authLimiter } from '../middleware/rateLimits.js';
import { asyncHandler, conflict, unauthorized, badRequest } from '../utils/httpError.js';
import { isSupportedLanguage } from '../config/languages.js';
import { startSession, rotateSession, revokeCurrent, revokeAllForUser, clearRefreshCookie, publicUser, sha256 } from '../services/sessions.js';
import { sendPasswordReset } from '../services/mailer.js';

const router = Router();
const password = z.string().min(8, 'Password must be at least 8 characters.').max(128);
const email = z.string().trim().toLowerCase().email().max(254);
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10); // compared when the user does not exist, to keep timing similar

router.post('/register', authLimiter, validate(z.object({ name: z.string().trim().min(2).max(100), email, password, remember: z.boolean().optional() })),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    console.log("Body: ", b);
    if (await User.exists({ email: b.email })) throw conflict('Email is already registered.', 'EMAIL_TAKEN');
    const user = await User.create({ name: b.name, email: b.email, passwordHash: await bcrypt.hash(b.password, 12) });
    res.status(201).json(await startSession(req, res, user, b.remember ?? true));
  }));

router.post('/login', authLimiter, validate(z.object({ email, password: z.string().min(1).max(128), remember: z.boolean().optional() })),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    console.log("Body: ", b);
    const user = await User.findOne({ email: b.email }).select('+passwordHash');
    const ok = await bcrypt.compare(b.password, user?.passwordHash || DUMMY_HASH);
    if (!user || !ok) throw unauthorized('Email or password is incorrect.', 'INVALID_CREDENTIALS');
    res.json(await startSession(req, res, user, b.remember ?? false));
  }));

// Uses only the httpOnly refresh cookie; rotates it on every call.
router.post('/refresh', asyncHandler(async (req, res) => {
  const session = await rotateSession(req, res, User);
  if (!session) { clearRefreshCookie(req, res); throw unauthorized('Session expired. Please sign in again.', 'REFRESH_INVALID'); }
  res.json(session);
}));

// Logout never requires a valid access token (it may have just expired).
router.post('/logout', asyncHandler(async (req, res) => {
  await revokeCurrent(req);
  clearRefreshCookie(req, res);
  res.json({ message: 'Logged out.' });
}));

router.post('/logout-all', requireAuth, asyncHandler(async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } }); // invalidates all access tokens
  await revokeAllForUser(req.user._id);
  clearRefreshCookie(req, res);
  res.json({ message: 'Signed out on all devices.' });
}));

router.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

router.patch('/me', requireAuth, validate(z.object({
  name: z.string().trim().min(2).max(100).optional(),
  preferredLanguage: z.string().refine(isSupportedLanguage, 'Unsupported language.').optional()
})), asyncHandler(async (req, res) => {
  Object.assign(req.user, req.valid.body);
  await req.user.save();
  res.json({ user: publicUser(req.user) });
}));

router.post('/change-password', authLimiter, requireAuth, validate(z.object({ currentPassword: z.string().min(1).max(128), newPassword: password })),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.valid.body;
    const user = await User.findById(req.user._id).select('+passwordHash');
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) throw unauthorized('Current password is incorrect.', 'INVALID_CREDENTIALS');
    if (currentPassword === newPassword) throw badRequest('Choose a password different from the current one.', 'PASSWORD_UNCHANGED');
    user.passwordHash = await bcrypt.hash(newPassword, 12);
    user.passwordChangedAt = new Date();
    user.tokenVersion += 1; // every other session's access token stops working
    await user.save();
    await revokeAllForUser(user._id);
    res.json(await startSession(req, res, user, true)); // keep this device signed in
  }));

// Always answers 200 so the endpoint cannot be used to discover which e-mails are registered.
router.post('/forgot-password', authLimiter, validate(z.object({ email })), asyncHandler(async (req, res) => {
  const user = await User.findOne({ email: req.valid.body.email });
  const body = { message: 'If that email is registered, a reset link has been sent.' };
  if (user) {
    const token = randomBytes(32).toString('hex');
    user.resetTokenHash = sha256(token);
    user.resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000);
    await user.save();
    const link = `${env.frontendOrigins[0]}/forgot-password?token=${token}`;
    await sendPasswordReset(user.email, link);
    if (env.DEV_EXPOSE_RESET_LINK) body.devResetLink = link; // development convenience only
  }
  res.json(body);
}));

router.post('/reset-password', authLimiter, validate(z.object({ token: z.string().min(20).max(200), newPassword: password })),
  asyncHandler(async (req, res) => {
    const { token, newPassword } = req.valid.body;
    const user = await User.findOne({ resetTokenHash: sha256(token), resetTokenExpires: { $gt: new Date() } }).select('+resetTokenHash +resetTokenExpires');
    if (!user) throw badRequest('This reset link is invalid or has expired.', 'RESET_TOKEN_INVALID');
    user.passwordHash = await bcrypt.hash(newPassword, 12);
    user.passwordChangedAt = new Date();
    user.tokenVersion += 1;
    user.resetTokenHash = undefined;
    user.resetTokenExpires = undefined;
    await user.save();
    await revokeAllForUser(user._id);
    res.json({ message: 'Password updated. You can now sign in.' });
  }));

export default router;
