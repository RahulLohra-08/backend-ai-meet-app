import Meeting from '../models/Meeting.js';
import { deleteMeetingCascade } from '../services/meeting/cascade.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/** Delete completed meetings older than their retention period (per-meeting override, else RETENTION_DAYS). */
export async function runRetentionOnce(now = new Date()) {
  const candidates = await Meeting.find({ status: 'completed', endedAt: { $ne: null } }).select('_id endedAt retentionDays').lean();
  let deleted = 0;
  for (const m of candidates) {
    const days = m.retentionDays || env.RETENTION_DAYS;
    if (!days) continue;
    if (now.getTime() - new Date(m.endedAt).getTime() > days * 86400000) { await deleteMeetingCascade(m._id); deleted++; }
  }
  if (deleted) logger.info('retention: deleted expired meetings', { deleted });
  return deleted;
}

export function startRetentionJob() {
  const timer = setInterval(() => runRetentionOnce().catch(err => logger.error('retention failed', err)), 60 * 60 * 1000);
  timer.unref?.();
  return timer;
}
