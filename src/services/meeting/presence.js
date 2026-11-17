import { meetingRoom } from '../../sockets/rooms.js';

/** Derive presence from the live sockets in a meeting room (stateless, works with a Socket.IO adapter too). */
export async function getPresence(io, meetingId) {
  if (!io) return [];
  const sockets = await io.in(meetingRoom(meetingId)).fetchSockets();
  const users = new Map();
  for (const s of sockets) {
    const d = s.data || {};
    if (!d.userId) continue;
    const u = users.get(d.userId) || { userId: d.userId, name: d.name, online: true, micOn: false, handRaised: false, speaking: false, captionLanguage: d.captionLanguage || 'en', connections: 0 };
    u.connections += 1;
    u.micOn = u.micOn || Boolean(d.micOn);
    u.handRaised = u.handRaised || Boolean(d.handRaised);
    u.speaking = u.speaking || Boolean(d.speaking);
    users.set(d.userId, u);
  }
  return [...users.values()];
}

export async function broadcastPresence(io, meetingId) {
  if (!io) return;
  io.to(meetingRoom(meetingId)).emit('presence:update', { meetingId: String(meetingId), presence: await getPresence(io, meetingId) });
}
