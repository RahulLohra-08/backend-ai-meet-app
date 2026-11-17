import mongoose from 'mongoose';
import Meeting from '../../models/Meeting.js';
import { forbidden, notFound } from '../../utils/httpError.js';

export const idStr = v => String(v?._id ?? v);
const OBJECT_ID = /^[a-f\d]{24}$/i;

export const findParticipant = (meeting, userId) => meeting.participants.find(p => idStr(p.user) === idStr(userId));
export const isHost = (meeting, userId) => idStr(meeting.host) === idStr(userId);
export const isAdmin = user => user?.role === 'admin';
export const isMember = (meeting, user) => isHost(meeting, user._id) || Boolean(findParticipant(meeting, user._id)) || isAdmin(user);
export const canManage = (meeting, user) => isHost(meeting, user._id) || isAdmin(user);

export const meetingQuery = idOrCode => (OBJECT_ID.test(idOrCode) ? { _id: idOrCode } : { code: String(idOrCode).toUpperCase() });

/** Load a meeting (by Mongo id or join code) with people populated. Does not check access. */
export async function findMeeting(idOrCode) {
  if (!idOrCode || typeof idOrCode !== 'string' || idOrCode.length > 64) throw notFound('Meeting not found.', 'MEETING_NOT_FOUND');
  const meeting = await Meeting.findOne(meetingQuery(idOrCode)).populate('host', 'name email').populate('participants.user', 'name email');
  if (!meeting) throw notFound('Meeting not found.', 'MEETING_NOT_FOUND');
  return meeting;
}

/** Load a meeting and require that `user` is a member (host / joined participant / admin). */
export async function loadMeetingForMember(idOrCode, user) {
  const meeting = await findMeeting(idOrCode);
  if (!isMember(meeting, user)) throw forbidden('You are not a participant of this meeting.', 'NOT_A_PARTICIPANT');
  return meeting;
}

export const isValidId = v => mongoose.isValidObjectId(v) && OBJECT_ID.test(String(v));

export function toMeetingDTO(meeting, viewer) {
  const m = meeting.toObject ? meeting.toObject() : meeting;
  const host = m.host && m.host._id ? m.host : { _id: m.host };
  return {
    _id: String(m._id),
    id: String(m._id),
    code: m.code,
    title: m.title,
    description: m.description,
    status: m.status,
    sourceLanguage: m.sourceLanguage,
    targetLanguage: m.targetLanguage,
    requireInvite: m.requireInvite,
    invitedEmails: viewer && idStr(host) === idStr(viewer._id) ? m.invitedEmails : undefined, // only the host sees invitees
    host: { id: String(host._id), name: host.name || '', email: undefined },
    isHost: viewer ? idStr(host) === idStr(viewer._id) : false,
    participants: (m.participants || []).map(p => ({
      userId: idStr(p.user), name: p.user?.name || 'Unknown', role: p.role,
      joinedAt: p.joinedAt, leftAt: p.leftAt || null, captionLanguage: p.captionLanguage
    })),
    lastSeq: m.transcriptSeq || 0,
    startedAt: m.startedAt, endedAt: m.endedAt, createdAt: m.createdAt, updatedAt: m.updatedAt
  };
}
