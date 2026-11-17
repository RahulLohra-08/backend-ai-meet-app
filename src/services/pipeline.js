import Meeting from '../models/Meeting.js';
import Transcript from '../models/Transcript.js';
import User from '../models/User.js';
import { translateTranscript } from './translation/index.js';
import { meetingRoom, languageRoom } from '../sockets/rooms.js';
import { env } from '../config/env.js';
import { backoffDelay, sleep } from '../utils/backoff.js';
import { normalizeText } from '../utils/text.js';
import { logger } from '../utils/logger.js';

/**
 * Speaker identity = the AUTHENTICATED user who owns the microphone that produced the segment
 * (the server never trusts a speaker name sent by the client). The display name is resolved from the
 * user record at read time, so it cannot drift between segments; the name stored on the segment is only a
 * fallback for deleted accounts. Separating several people talking into ONE microphone (diarization) is
 * not possible with the configured providers and is not attempted.
 */
export async function speakerNames(rows) {
  const ids = [...new Set(rows.map(r => String(r.speaker)))];
  if (!ids.length) return new Map();
  const users = await User.find({ _id: { $in: ids } }).select('name').lean();
  return new Map(users.map(u => [String(u._id), u.name]));
}

export function segmentDTO(t, translation = null, names = null) {
  const speakerId = String(t.speaker);
  return {
    id: String(t._id),
    meetingId: String(t.meeting),
    seq: t.seq,
    segmentId: t.clientSegmentId,
    speaker: { id: speakerId, name: names?.get(speakerId) || t.speakerName || 'Unknown speaker', known: Boolean(names?.get(speakerId)) },
    text: t.text,
    selectedLanguage: t.sourceLanguage,
    detectedLanguage: t.detectedLanguage,
    sourceLanguage: t.detectedLanguage || t.sourceLanguage, // language the text is really in
    provider: t.provider,
    occurredAt: t.occurredAt,
    isFinal: true,
    translation // { text, targetLanguage, provider } | null
  };
}

/**
 * Persist one finalized speech segment, broadcast it, then translate it for every caption language in the room.
 * Idempotent: the same clientSegmentId, or the same text from the same speaker within DUPLICATE_WINDOW_MS
 * (e.g. two recognizer instances hearing one utterance), returns the existing segment with duplicate:true.
 */
export async function ingestFinalSegment({ io, meeting, user, text, sourceLanguage = 'auto', detectedLanguage = null, provider = 'browser', clientSegmentId, occurredAt, audioDurationMs = null }) {
  const key = { meeting: meeting._id, speaker: user._id, clientSegmentId };
  const existing = await Transcript.findOne(key);
  if (existing) return { transcript: existing, duplicate: true };

  if (env.DUPLICATE_WINDOW_MS > 0) {
    const recent = await Transcript.find({ meeting: meeting._id, speaker: user._id, createdAt: { $gte: new Date(Date.now() - env.DUPLICATE_WINDOW_MS) } }).sort({ seq: -1 }).limit(5);
    const wanted = normalizeText(text);
    const same = recent.find(r => normalizeText(r.text) === wanted);
    if (same) return { transcript: same, duplicate: true, reason: 'near_duplicate' };
  }

  // Atomic counter => strict total order of segments inside the meeting.
  const counter = await Meeting.findOneAndUpdate({ _id: meeting._id }, { $inc: { transcriptSeq: 1 } }, { new: true, projection: { transcriptSeq: 1 } });
  let transcript;
  try {
    transcript = await Transcript.create({
      ...key, seq: counter.transcriptSeq, speakerName: user.name, text,
      sourceLanguage, detectedLanguage, provider, audioDurationMs, occurredAt: occurredAt || new Date()
    });
  } catch (e) {
    if (e?.code === 11000) { // a concurrent request stored the same segment first
      const winner = await Transcript.findOne(key);
      if (winner) return { transcript: winner, duplicate: true };
    }
    throw e;
  }

  io?.to(meetingRoom(meeting._id)).emit('caption:final', segmentDTO(transcript, null, new Map([[String(user._id), user.name]])));
  // Translation never blocks or fails transcription: original captions are already stored and delivered.
  translateForRoom(io, meeting, transcript).catch(err => logger.warn('translateForRoom failed', err));
  return { transcript, duplicate: false };
}

export async function translateForRoom(io, meeting, transcript) {
  const room = meetingRoom(meeting._id);
  const sockets = io ? await io.in(room).fetchSockets() : [];
  const languages = new Set(sockets.map(s => s.data?.captionLanguage).filter(Boolean));
  if (meeting.targetLanguage) languages.add(meeting.targetLanguage); // always keep the meeting default in history
  await Promise.all([...languages].map(language => translateOne(io, meeting._id, transcript, language)));
}

/**
 * Translate one segment into one language. Temporary provider problems (rate limit, timeout, 5xx) are retried in the
 * background with exponential backoff + jitter that respects Retry-After; the UI is told via status 'retrying'.
 * Permanent problems (not configured, quota exhausted, unsupported pair) fail immediately with a clear code.
 */
export async function translateOne(io, meetingId, transcript, language, { maxRetries = env.TRANSLATION_AUTO_RETRIES } = {}) {
  const base = { meetingId: String(meetingId), segmentId: String(transcript._id), seq: transcript.seq, language };
  const out = payload => io?.to(languageRoom(meetingId, language)).emit('caption:translation', { ...base, ...payload });
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await translateTranscript(transcript, language);
      out(r.status === 'same_language' ? { status: 'same_language' } : { status: 'translated', text: r.text, provider: r.provider });
      return;
    } catch (err) {
      const canRetry = Boolean(err?.retryable) && attempt < maxRetries;
      if (!canRetry) {
        out({ status: 'failed', code: err?.code || 'PROVIDER_ERROR', retryable: Boolean(err?.retryable), message: err?.expose ? err.message : 'Translation failed.' });
        return;
      }
      const wait = backoffDelay(attempt, { baseMs: 1500, capMs: 30000, minMs: err.retryAfterMs || 0 });
      out({ status: 'retrying', code: err.code, retryInMs: wait, attempt: attempt + 1, message: err.message });
      await sleep(wait);
    }
  }
}
