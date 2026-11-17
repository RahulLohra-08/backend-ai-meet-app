import { Router } from 'express';
import { z } from 'zod';
import Summary from '../models/Summary.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, conflict, forbidden } from '../utils/httpError.js';
import { isSupportedLanguage } from '../config/languages.js';
import { loadMeetingForMember, canManage } from '../services/meeting/access.js';
import { startSummary } from '../services/summaryJob.js';

const router = Router();
router.use(requireAuth);

const dto = s => s && ({
  id: String(s._id), status: s.status, content: s.content, error: s.error, errorCode: s.errorCode, retryable: s.retryable !== false, attempts: s.attempts,
  provider: s.provider, model: s.model, outputLanguage: s.outputLanguage, transcriptCount: s.transcriptCount,
  startedAt: s.startedAt, completedAt: s.completedAt, attempts: s.attempts
});

// Host/admin starts (or regenerates) notes. Returns 202 immediately; poll GET /summary or listen for `summary:status`.
router.post('/:id/summarize', validate(z.object({ outputLanguage: z.string().refine(isSupportedLanguage, 'Unsupported language.').optional() })), asyncHandler(async (req, res) => {
  const meeting = await loadMeetingForMember(req.params.id, req.user);
  if (!canManage(meeting, req.user)) throw forbidden('Only the host can generate meeting notes.', 'HOST_ONLY');
  if (meeting.status !== 'completed') throw conflict('End the meeting before generating notes.', 'MEETING_NOT_ENDED');
  const summary = await startSummary({ io: req.app.get('io'), meeting, userId: req.user._id, outputLanguage: req.valid.body.outputLanguage || meeting.targetLanguage || 'en' });
  res.status(202).json({ summary: dto(summary) });
}));

router.get('/:id/summary', asyncHandler(async (req, res) => {
  const meeting = await loadMeetingForMember(req.params.id, req.user);
  const summary = await Summary.findOne({ meeting: meeting._id });
  if (summary) return res.json({ summary: dto(summary) });
  // Notes saved by the first backend iteration lived on the meeting document.
  if (meeting.notes && typeof meeting.notes === 'object') {
    return res.json({ summary: { id: 'legacy', status: 'completed', content: meeting.notes, legacy: true } });
  }
  res.json({ summary: null });
}));

export default router;
