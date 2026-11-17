import { createHash, randomBytes, randomUUID } from 'node:crypto';
import RefreshToken from '../models/RefreshToken.js';
import { env } from '../config/env.js';
import { signAccessToken } from '../middleware/auth.js';
import { parseCookies } from '../utils/cookies.js';

export const REFRESH_COOKIE = 'lm_refresh';
const GRACE_MS = 10_000; // tolerate two browser tabs refreshing at the same moment
export const sha256 = v => createHash('sha256').update(v).digest('hex');

const cookieOptions = (req, remember) => ({
  httpOnly: true,
  sameSite: env.COOKIE_SAMESITE,
  secure: env.COOKIE_SECURE === 'auto' ? env.NODE_ENV === 'production' : env.COOKIE_SECURE === 'true',
  path: '/api/auth',
  ...(remember ? { maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400 * 1000 } : {}) // no maxAge => session cookie
});

export const publicUser = u => ({ id: String(u._id), name: u.name, email: u.email, role: u.role, preferredLanguage: u.preferredLanguage || 'en' });

async function issueRefresh(user, { family = randomUUID(), remember, userAgent }) {
  const token = randomBytes(48).toString('base64url');
  await RefreshToken.create({
    user: user._id, tokenHash: sha256(token), family, remember,
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400 * 1000),
    userAgent: (userAgent || '').slice(0, 200)
  });
  return { token, family, hash: sha256(token) };
}

/** Start a session: sets the httpOnly refresh cookie and returns the short-lived access token. */
export async function startSession(req, res, user, remember = false) {
  const r = await issueRefresh(user, { remember, userAgent: req.headers['user-agent'] });
  res.cookie(REFRESH_COOKIE, r.token, cookieOptions(req, remember));
  return { user: publicUser(user), accessToken: signAccessToken(user) };
}

export const clearRefreshCookie = (req, res) => res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(req, false), maxAge: undefined });
export const readRefreshCookie = req => parseCookies(req.headers.cookie || '')[REFRESH_COOKIE] || '';

/**
 * Rotate a refresh token. Returns { user, accessToken } or null when the token is unusable.
 * Replaying an already-rotated token (outside the grace window) revokes the whole family.
 */
export async function rotateSession(req, res, User) {
  const raw = readRefreshCookie(req);
  if (!raw) return null;
  const record = await RefreshToken.findOne({ tokenHash: sha256(raw) });
  if (!record || record.expiresAt < new Date()) return null;

  if (record.revokedAt) {
    const withinGrace = Date.now() - record.revokedAt.getTime() < GRACE_MS && record.replacedBy;
    if (!withinGrace) { await RefreshToken.updateMany({ family: record.family, revokedAt: null }, { $set: { revokedAt: new Date() } }); return null; }
    const user = await User.findById(record.user);
    return user ? { user: publicUser(user), accessToken: signAccessToken(user) } : null; // race: the other tab already rotated
  }
  const user = await User.findById(record.user);
  if (!user) return null;
  // Compare-and-set so only one concurrent request performs the rotation.
  const claimed = await RefreshToken.findOneAndUpdate({ _id: record._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  if (!claimed) return { user: publicUser(user), accessToken: signAccessToken(user) };
  const next = await issueRefresh(user, { family: record.family, remember: record.remember, userAgent: req.headers['user-agent'] });
  await RefreshToken.updateOne({ _id: record._id }, { $set: { replacedBy: next.hash } });
  res.cookie(REFRESH_COOKIE, next.token, cookieOptions(req, record.remember));
  return { user: publicUser(user), accessToken: signAccessToken(user) };
}

export async function revokeCurrent(req) {
  const raw = readRefreshCookie(req);
  if (!raw) return;
  const record = await RefreshToken.findOne({ tokenHash: sha256(raw) });
  if (record) await RefreshToken.updateMany({ family: record.family, revokedAt: null }, { $set: { revokedAt: new Date() } });
}
export const revokeAllForUser = userId => RefreshToken.updateMany({ user: userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
