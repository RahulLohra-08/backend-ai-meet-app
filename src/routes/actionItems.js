import { Router } from 'express';
import { z } from 'zod';
import ActionItem from '../models/ActionItem.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../utils/httpError.js';
import { loadMeetingForMember, findMeeting, canManage, findParticipant, idStr, isValidId, isMember } from '../services/meeting/access.js';

const router = Router();
router.use(requireAuth);

const priority = z.enum(['low', 'medium', 'high']);
const status = z.enum(['todo', 'in_progress', 'done']);
const userId = z.string().refine(isValidId, 'Invalid user id.');

const populate = q => q.populate('assignedTo', 'name email');
const dto = i => ({
  id: String(i._id), _id: String(i._id), meetingId: String(i.meeting), description: i.description,
  assignedTo: i.assignedTo ? { id: idStr(i.assignedTo), name: i.assignedTo.name || '' } : null, assigneeHint: i.assigneeHint,
  dueDate: i.dueDate, priority: i.priority, status: i.status, source: i.source, transcriptSeqs: i.transcriptSeqs,
  completedAt: i.completedAt, createdAt: i.createdAt, updatedAt: i.updatedAt
});
const assertAssignee = (meeting, id) => {
  if (id && !findParticipant(meeting, id) && idStr(meeting.host) !== String(id)) throw badRequest('Tasks can only be assigned to meeting participants.', 'ASSIGNEE_NOT_PARTICIPANT');
};
// Host/admin: everything. Others: only items they created or that are assigned to them.
const canEdit = (item, meeting, user) => canManage(meeting, user) || idStr(item.createdBy) === idStr(user._id) || (item.assignedTo && idStr(item.assignedTo) === idStr(user._id));

router.get('/meetings/:id/action-items', asyncHandler(async (req, res) => {
  const meeting = await loadMeetingForMember(req.params.id, req.user);
  const items = await populate(ActionItem.find({ meeting: meeting._id }).sort({ createdAt: -1 }));
  res.json({ actionItems: items.map(dto) });
}));

router.post('/meetings/:id/action-items', validate(z.object({
  description: z.string().trim().min(1).max(1000), assignedTo: userId.nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(), priority: priority.default('medium')
})), asyncHandler(async (req, res) => {
  const meeting = await loadMeetingForMember(req.params.id, req.user);
  const b = req.valid.body;
  assertAssignee(meeting, b.assignedTo);
  const item = await ActionItem.create({ meeting: meeting._id, description: b.description, assignedTo: b.assignedTo || null, dueDate: b.dueDate || null, priority: b.priority, source: 'manual', createdBy: req.user._id });
  res.status(201).json({ actionItem: dto(await populate(ActionItem.findById(item._id))) });
}));

// "My tasks" across meetings.
router.get('/action-items', validate(z.object({
  assignedTo: z.literal('me').default('me'), status: status.optional().catch(undefined),
  page: z.coerce.number().int().min(1).catch(1).default(1), limit: z.coerce.number().int().min(1).max(100).catch(50).default(50)
}), 'query'), asyncHandler(async (req, res) => {
  const { status: st, page, limit } = req.valid.query;
  const filter = { assignedTo: req.user._id, ...(st ? { status: st } : {}) };
  const [items, total] = await Promise.all([populate(ActionItem.find(filter).sort({ dueDate: 1, createdAt: -1 }).skip((page - 1) * limit).limit(limit)), ActionItem.countDocuments(filter)]);
  res.json({ actionItems: items.map(dto), page, limit, total });
}));

async function loadItem(req) {
  if (!isValidId(req.params.actionItemId)) throw notFound('Action item not found.', 'ACTION_ITEM_NOT_FOUND');
  const item = await ActionItem.findById(req.params.actionItemId);
  if (!item) throw notFound('Action item not found.', 'ACTION_ITEM_NOT_FOUND');
  const meeting = await findMeeting(String(item.meeting));
  if (!isMember(meeting, req.user)) throw forbidden('You are not a participant of this meeting.', 'NOT_A_PARTICIPANT');
  return { item, meeting };
}

router.patch('/action-items/:actionItemId', validate(z.object({
  description: z.string().trim().min(1).max(1000).optional(), assignedTo: userId.nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(), priority: priority.optional(), status: status.optional()
}).refine(o => Object.keys(o).length > 0, 'Provide at least one field to update.')), asyncHandler(async (req, res) => {
  const { item, meeting } = await loadItem(req);
  if (!canEdit(item, meeting, req.user)) throw forbidden('Only the host, the creator or the assignee can change this task.', 'NOT_ALLOWED');
  const b = req.valid.body;
  if (b.assignedTo !== undefined) assertAssignee(meeting, b.assignedTo);
  Object.assign(item, b);
  if (b.assignedTo !== undefined) item.assigneeHint = '';
  if (b.status) item.completedAt = b.status === 'done' ? new Date() : undefined;
  if (item.source === 'ai_suggested') item.source = 'user_confirmed'; // a person has reviewed/changed it
  await item.save();
  res.json({ actionItem: dto(await populate(ActionItem.findById(item._id))) });
}));

router.delete('/action-items/:actionItemId', asyncHandler(async (req, res) => {
  const { item, meeting } = await loadItem(req);
  if (!canEdit(item, meeting, req.user)) throw forbidden('Only the host, the creator or the assignee can delete this task.', 'NOT_ALLOWED');
  await item.deleteOne();
  res.json({ message: 'Action item deleted.' });
}));

export default router;
