import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * No SMTP provider is wired in. In development the reset link is printed to the server console
 * (and optionally returned by the API when DEV_EXPOSE_RESET_LINK=true). Replace this function with a
 * real mailer (nodemailer, SES, Resend...) before using password reset in production.
 */
export async function sendPasswordReset(email, link) {
  if (env.NODE_ENV !== 'production') console.log(`[dev mailer] Password reset link for ${email}: ${link}`);
  else logger.warn('Password reset requested but no mailer is configured; the link was NOT delivered.');
  return { delivered: false };
}
