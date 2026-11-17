import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import Meeting from '../models/Meeting.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { joinLimiter } from '../middleware/rateLimits.js';
import { asyncHandler, forbidden, conflict } from '../utils/httpError.js';
import { isSupportedLanguage } from '../config/languages.js';
import { findMeeting, loadMeetingForMember, canManage, isMember, toMeetingDTO } from '../services/meeting/access.js';
import { deleteMeetingCascade } from '../services/meeting/cascade.js';
import { getPresence } from '../services/meeting/presence.js';
import { autoSummarizeOnEnd } from '../services/summaryJob.js';
import { meetingRoom } from '../sockets/rooms.js';
import { env } from '../config/env.js';

const router = Router();
router.use(requireAuth);

const lang = z.string().refine(isSupportedLanguage, 'Unsupported language code.');
const langOrAuto = z.union([z.literal('auto'), lang]);
const emails = z.array(z.string().trim().toLowerCase().email()).max(200);

const createSchema = z.object({
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().max(2000).optional(),
  sourceLanguage: langOrAuto.default('auto'),
  targetLanguage: lang.default('en'),
  requireInvite: z.boolean().default(false),
  invitedEmails: emails.default([]),
  retentionDays: z.number().int().min(1).max(3650).nullable().optional()
});
const updateSchema = createSchema.partial();
const joinSchema = z.object({ captionLanguage: lang.optional() });
const listSchema = z.object({
  page: z.coerce.number().int().min(1).catch(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).catch(20).default(20),
  status: z.enum(['scheduled', 'live', 'completed']).optional().catch(undefined),
  q: z.string().trim().max(100).optional().catch(undefined)
});

// Join codes are random (32 bits). On the astronomically rare collision of the `code` index we simply draw a new code;
// a duplicate on ANY OTHER unique index is a data/schema problem and is reported, never retried blindly.
const isCodeCollision = e => e?.code === 11000 && (Boolean(e.keyPattern?.code) || /index:\s*code_1/.test(String(e.message)));
async function createWithUniqueCode(data) {
  for (let i = 0; i < 8; i++) {
    try { return await Meeting.create({ ...data, code: randomBytes(4).toString('hex').toUpperCase() }); }
    catch (e) { if (!isCodeCollision(e)) throw e; }
  }
  throw new Error('Could not allocate a unique meeting code.');
}
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.post('/', validate(createSchema), asyncHandler(async (req, res) => {
  const b = req.valid.body;
  const meeting = await createWithUniqueCode({
    ...b, host: req.user._id, status: 'scheduled',
    supportedLanguages: [...new Set([b.targetLanguage, ...(b.sourceLanguage !== 'auto' ? [b.sourceLanguage] : [])])],
    participants: [{ user: req.user._id, role: 'host', joinedAt: new Date(), lastJoinedAt: new Date(), captionLanguage: b.targetLanguage }]
  });
  res.status(201).json({ meeting: toMeetingDTO(await findMeeting(String(meeting._id)), req.user) });
}));

router.get('/', validate(listSchema, 'query'), asyncHandler(async (req, res) => {
  const { page, limit, status, q } = req.valid.query;
  const filter = { $or: [{ host: req.user._id }, { 'participants.user': req.user._id }] };
  if (status) filter.status = status;
  if (q) filter.title = { $regex: escapeRegex(q), $options: 'i' };
  const [items, total] = await Promise.all([
    Meeting.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).populate('host', 'name').populate('participants.user', 'name'),
    Meeting.countDocuments(filter)
  ]);
  res.json({ meetings: items.map(m => toMeetingDTO(m, req.user)), page, limit, total });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  res.json({ meeting: toMeetingDTO(await loadMeetingForMember(req.params.id, req.user), req.user) });
}));

router.patch('/:id', validate(updateSchema), asyncHandler(async (req, res) => {
  const meeting = await loadMeetingForMember(req.params.id, req.user);
  if (!canManage(meeting, req.user)) throw forbidden('Only the host can update meeting details.', 'HOST_ONLY');
  if (meeting.status === 'completed') throw conflict('A completed meeting cannot be edited.', 'MEETING_ENDED');
  Object.assign(meeting, req.valid.body);
  await meeting.save();
  res.json({ meeting: toMeetingDTO(await findMeeting(String(meeting._id)), req.user) });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const meeting = await loadMeetingForMember(req.params.id, req.user);
  if (!canManage(meeting, req.user)) throw forbidden('Only the host can delete a meeting.', 'HOST_ONLY');
  req.app.get('io')?.to(meetingRoom(meeting._id)).emit('meeting:ended', { meetingId: String(meeting._id), deleted: true });
  await deleteMeetingCascade(meeting._id);
  res.json({ message: 'Meeting and all of its data were deleted.' });
}));

// Joining by id or code. Anyone with the code can join unless the host restricted the meeting to invited e-mails.
router.post('/:id/join', joinLimiter, validate(joinSchema), asyncHandler(async (req, res) => {
  const meeting = await findMeeting(req.params.id);
  if (meeting.status === 'completed') throw conflict('This meeting has ended.', 'MEETING_ENDED');
  const already = isMember(meeting, req.user);
  if (!already && meeting.requireInvite && !meeting.invitedEmails.includes(req.user.email)) {
    throw forbidden('This meeting is invite-only and your e-mail address is not on the list.', 'NOT_INVITED');
  }
  const now = new Date();
  const captionLanguage = req.valid.body.captionLanguage || req.user.preferredLanguage || 'en';
  // Atomic: add the participant only if missing (two simultaneous joins can't create duplicates)…
  await Meeting.updateOne({ _id: meeting._id, 'participants.user': { $ne: req.user._id } },
    { $push: { participants: { user: req.user._id, role: 'participant', joinedAt: now, captionLanguage } } });
  // …then mark (re)join: clear leftAt so reconnecting users are shown as present again.
  await Meeting.updateOne({ _id: meeting._id, 'participants.user': req.user._id },
    { $set: { 'participants.$.lastJoinedAt': now, 'participants.$.captionLanguage': captionLanguage }, $unset: { 'participants.$.leftAt': '' } });
  await Meeting.updateOne({ _id: meeting._id, status: 'scheduled' }, { $set: { status: 'live', startedAt: now } });

  const fresh = await findMeeting(String(meeting._id));
  req.app.get('io')?.to(meetingRoom(meeting._id)).emit('participant:joined', { meetingId: String(meeting._id), userId: String(req.user._id), name: req.user.name });
  res.json({ meeting: toMeetingDTO(fresh, req.user) });
}));

router.post('/:id/leave', asyncHandler(async (req, res) => {
  const meeting = await loadMeetingForMember(req.params.id, req.user);
  await Meeting.updateOne({ _id: meeting._id, 'participants.user': req.user._id }, { $set: { 'participants.$.leftAt': new Date() } });
  req.app.get('io')?.to(meetingRoom(meeting._id)).emit('participant:left', { meetingId: String(meeting._id), userId: String(req.user._id) });
  res.json({ message: 'Left meeting.' });
}));

router.post('/:id/end', asyncHandler(async (req, res) => {
  const meeting = await loadMeetingForMember(req.params.id, req.user);
  if (!canManage(meeting, req.user)) throw forbidden('Only the host can end this meeting.', 'HOST_ONLY');
  const io = req.app.get('io');
  if (meeting.status !== 'completed') {
    const now = new Date();
    meeting.status = 'completed';
    meeting.endedAt = now;
    meeting.participants.forEach(p => { if (!p.leftAt) p.leftAt = now; });
    await meeting.save();
    io?.to(meetingRoom(meeting._id)).emit('meeting:ended', { meetingId: String(meeting._id) });
    if (env.SUMMARY_AUTO_ON_END) await autoSummarizeOnEnd({ io, meeting, userId: req.user._id });
  }
  res.json({ meeting: toMeetingDTO(await findMeeting(String(meeting._id)), req.user) });
}));

router.get('/:id/participants', asyncHandler(async (req, res) => {
  const meeting = await loadMeetingForMember(req.params.id, req.user);
  const online = new Map((await getPresence(req.app.get('io'), meeting._id)).map(p => [p.userId, p]));
  const dto = toMeetingDTO(meeting, req.user);
  res.json({ participants: dto.participants.map(p => ({ ...p, online: online.has(p.userId), micOn: online.get(p.userId)?.micOn || false, handRaised: online.get(p.userId)?.handRaised || false })) });
}));

export default router;
