import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { env } from '../config/env.js';
import { unauthorized, forbidden, asyncHandler } from '../utils/httpError.js';

export function signAccessToken(user) {
  return jwt.sign({ role: user.role, tv: user.tokenVersion || 0 }, env.JWT_SECRET, {
    subject: String(user._id), expiresIn: env.ACCESS_TOKEN_TTL, algorithm: 'HS256'
  });
}

/** Verify a JWT and load the user; shared by HTTP and Socket.IO. Throws HttpError(401). */
export async function authenticateToken(token) {
  if (!token) throw unauthorized();
  let payload;
  try { payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }); }
  catch { throw unauthorized('Invalid or expired access token.', 'TOKEN_EXPIRED'); }
  const user = await User.findById(payload.sub);
  if (!user) throw unauthorized('User no longer exists.');
  if ((user.tokenVersion || 0) !== (payload.tv || 0)) throw unauthorized('Session was revoked. Please sign in again.', 'TOKEN_REVOKED');
  return { user, exp: payload.exp };
}

export const requireAuth = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const { user } = await authenticateToken(token);
  req.user = user;
  next();
});

export const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user?.role) ? next() : next(forbidden('Insufficient role for this action.'));
