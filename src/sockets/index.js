import { Server } from 'socket.io';
import { z } from 'zod';
import Meeting from '../models/Meeting.js';
import { env } from '../config/env.js';
import { authenticateToken } from '../middleware/auth.js';
import { isSupportedLanguage } from '../config/languages.js';
import { findMeeting, isMember, toMeetingDTO, isValidId } from '../services/meeting/access.js';
import { getPresence, broadcastPresence } from '../services/meeting/presence.js';
import { meetingRoom, languageRoom } from './rooms.js';
import { logger } from '../utils/logger.js';

/**
 * Event contract (see docs/ARCHITECTURE.md):
 *  client -> server (all take an ack callback => { ok, ... } | { ok:false, code, error })
 *    meeting:join        { meetingId, captionLanguage? }
 *    meeting:leave       {}
 *    caption:setLanguage { language }
 *    transcript:partial  { segmentId, text, sourceLanguage }      (not persisted, not translated)
 *    presence:update     { micOn?, handRaised?, speaking? }
 *    chat:send           { text }                                  (ephemeral, not persisted)
 *  server -> client
 *    caption:partial / caption:final / caption:translation / presence:update
 *    participant:joined / participant:left / meeting:ended / summary:status / chat:message / auth:expired
 */
const joinSchema = z.object({ meetingId: z.string().min(1).max(64), captionLanguage: z.string().refine(isSupportedLanguage).optional() });
const partialSchema = z.object({ segmentId: z.string().min(8).max(150), text: z.string().max(1000), sourceLanguage: z.string().max(10).default('auto') });
const presenceSchema = z.object({ micOn: z.boolean().optional(), handRaised: z.boolean().optional(), speaking: z.boolean().optional() });
const chatSchema = z.object({ text: z.string().trim().min(1).max(500) });

const fail = (ack, code, error) => typeof ack === 'function' && ack({ ok: false, code, error });
const ok = (ack, data = {}) => typeof ack === 'function' && ack({ ok: true, ...data });

/** Simple per-socket token bucket so one client cannot flood a meeting. */
function allow(socket, bucket, perSecond, burst) {
  const now = Date.now();
  const b = (socket.data.buckets ||= {})[bucket] ||= { tokens: burst, at: now };
  b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSecond);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

export function attachSockets(httpServer, app) {
  const io = new Server(httpServer, {
    cors: { origin: env.frontendOrigins, credentials: true },
    maxHttpBufferSize: 16 * 1024, // events carry text only; audio goes through the HTTP upload endpoint
    pingInterval: 20000, pingTimeout: 20000
  });

  // 1) Authenticate every connection with the short-lived access token.
  io.use(async (socket, next) => {
    try {
      const { user, exp } = await authenticateToken(socket.handshake.auth?.token);
      socket.data = { userId: String(user._id), name: user.name, role: user.role, exp, captionLanguage: user.preferredLanguage || 'en', micOn: false, handRaised: false, speaking: false };
      next();
    } catch (err) { next(new Error(err?.code === 'TOKEN_EXPIRED' ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED')); }
  });

  io.on('connection', socket => {
    // Access tokens are short-lived: tell the client when ours expires so it can refresh and reconnect.
    const ttl = socket.data.exp * 1000 - Date.now();
    const expiryTimer = setTimeout(() => { socket.emit('auth:expired'); socket.disconnect(true); }, Math.max(ttl, 0));
    expiryTimer.unref?.();

    // 2) Join a meeting room ONLY after checking membership in MongoDB.
    socket.on('meeting:join', async (payload, ack) => {
      try {
        const parsed = joinSchema.safeParse(payload);
        if (!parsed.success) return fail(ack, 'VALIDATION_ERROR', 'meetingId is required.');
        const meeting = await findMeeting(parsed.data.meetingId).catch(() => null);
        if (!meeting) return fail(ack, 'MEETING_NOT_FOUND', 'Meeting not found.');
        const user = { _id: socket.data.userId, role: socket.data.role };
        if (!isMember(meeting, user)) return fail(ack, 'NOT_A_PARTICIPANT', 'Join the meeting first.');
        if (meeting.status === 'completed') return fail(ack, 'MEETING_ENDED', 'This meeting has ended.');

        if (socket.data.meetingId && socket.data.meetingId !== String(meeting._id)) await leaveCurrent(socket);
        const mine = meeting.participants.find(p => String(p.user._id) === socket.data.userId);
        socket.data.meetingId = String(meeting._id);
        socket.data.captionLanguage = parsed.data.captionLanguage || mine?.captionLanguage || socket.data.captionLanguage;
        await socket.join([meetingRoom(meeting._id), languageRoom(meeting._id, socket.data.captionLanguage)]);

        const presence = await getPresence(io, meeting._id);
        ok(ack, { meeting: toMeetingDTO(meeting, user), presence, captionLanguage: socket.data.captionLanguage, lastSeq: meeting.transcriptSeq });
        broadcastPresence(io, meeting._id).catch(() => {});
      } catch (err) { logger.warn('meeting:join failed', err); fail(ack, 'INTERNAL_ERROR', 'Could not join the meeting room.'); }
    });

    socket.on('meeting:leave', async (_p, ack) => { await leaveCurrent(socket); ok(ack); });

    socket.on('caption:setLanguage', async (payload, ack) => {
      const language = payload?.language;
      if (!socket.data.meetingId) return fail(ack, 'NOT_IN_MEETING', 'Join a meeting first.');
      if (!isSupportedLanguage(language)) return fail(ack, 'VALIDATION_ERROR', 'Unsupported language.');
      const id = socket.data.meetingId;
      await socket.leave(languageRoom(id, socket.data.captionLanguage));
      socket.data.captionLanguage = language;
      await socket.join(languageRoom(id, language));
      if (isValidId(id)) await Meeting.updateOne({ _id: id, 'participants.user': socket.data.userId }, { $set: { 'participants.$.captionLanguage': language } }).catch(() => {});
      ok(ack, { captionLanguage: language });
      broadcastPresence(io, id).catch(() => {});
    });

    // Interim speech from the browser engine: shown live to others, never stored, never translated.
    socket.on('transcript:partial', (payload, ack) => {
      const id = socket.data.meetingId;
      if (!id) return fail(ack, 'NOT_IN_MEETING', 'Join a meeting first.');
      if (!allow(socket, 'partial', 6, 12)) return fail(ack, 'RATE_LIMITED', 'Too many partial updates.');
      const parsed = partialSchema.safeParse(payload);
      if (!parsed.success) return fail(ack, 'VALIDATION_ERROR', 'Invalid partial payload.');
      socket.to(meetingRoom(id)).emit('caption:partial', {
        meetingId: id, segmentId: parsed.data.segmentId, speaker: { id: socket.data.userId, name: socket.data.name },
        text: parsed.data.text, sourceLanguage: parsed.data.sourceLanguage, isFinal: false, at: Date.now()
      });
      ok(ack);
    });

    socket.on('presence:update', (payload, ack) => {
      const id = socket.data.meetingId;
      if (!id) return fail(ack, 'NOT_IN_MEETING', 'Join a meeting first.');
      if (!allow(socket, 'presence', 4, 8)) return fail(ack, 'RATE_LIMITED', 'Too many updates.');
      const parsed = presenceSchema.safeParse(payload);
      if (!parsed.success) return fail(ack, 'VALIDATION_ERROR', 'Invalid presence payload.');
      Object.assign(socket.data, parsed.data);
      ok(ack);
      broadcastPresence(io, id).catch(() => {});
    });

    socket.on('chat:send', (payload, ack) => {
      const id = socket.data.meetingId;
      if (!id) return fail(ack, 'NOT_IN_MEETING', 'Join a meeting first.');
      if (!allow(socket, 'chat', 2, 5)) return fail(ack, 'RATE_LIMITED', 'You are sending messages too quickly.');
      const parsed = chatSchema.safeParse(payload);
      if (!parsed.success) return fail(ack, 'VALIDATION_ERROR', 'Message must be 1-500 characters.');
      const message = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, meetingId: id, from: { id: socket.data.userId, name: socket.data.name }, text: parsed.data.text, at: Date.now() };
      io.to(meetingRoom(id)).emit('chat:message', message);
      ok(ack, { message });
    });

    // A dropped connection is NOT "leaving": presence simply flips to offline and the client reconnects.
    socket.on('disconnect', () => {
      clearTimeout(expiryTimer);
      const id = socket.data.meetingId;
      if (id) broadcastPresence(io, id).catch(() => {});
    });
  });

  async function leaveCurrent(socket) {
    const id = socket.data.meetingId;
    if (!id) return;
    await socket.leave(meetingRoom(id));
    await socket.leave(languageRoom(id, socket.data.captionLanguage));
    socket.data.meetingId = undefined;
    socket.data.micOn = false; socket.data.speaking = false; socket.data.handRaised = false;
    broadcastPresence(io, id).catch(() => {});
  }

  app?.set('io', io);
  return io;
}
