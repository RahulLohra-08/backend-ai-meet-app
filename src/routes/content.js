import express, { Router } from 'express';
import { z } from 'zod';
import Transcript from '../models/Transcript.js';
import Translation from '../models/Translation.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { audioLimiter } from '../middleware/rateLimits.js';
import { asyncHandler, badRequest, conflict, notFound, HttpError } from '../utils/httpError.js';
import { isSupportedLanguage } from '../config/languages.js';
import { loadMeetingForMember, isValidId } from '../services/meeting/access.js';
import { ingestFinalSegment, segmentDTO, speakerNames } from '../services/pipeline.js';
import { getSpeechProvider } from '../services/speech/index.js';
import { translateTranscript } from '../services/translation/index.js';
import { ProviderError } from '../utils/http.js';

const router = Router();
router.use(requireAuth);

const lang = z.string().refine(isSupportedLanguage, 'Unsupported language code.');
const langOrAuto = z.union([z.literal('auto'), lang]);

async function requireLive(req) {
  const meeting = await loadMeetingForMember(req.params.id, req.user);
  if (meeting.status === 'completed') throw conflict('This meeting has ended.', 'MEETING_ENDED');
  return meeting;
}
const providerStatus = err => (err instanceof ProviderError ? err.status : 500);
const rethrowProvider = err => {
  if (err instanceof ProviderError) { const e = new HttpError(providerStatus(err), err.message, err.code, { retryable: err.retryable, retryAfterMs: err.retryAfterMs }); throw e; }
  throw err;
};

// ---------- Final transcript segment from the browser speech engine (idempotent by segmentId) ----------
const ingestSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  sourceLanguage: langOrAuto.default('auto'),
  clientSegmentId: z.string().trim().min(8).max(150),
  occurredAt: z.coerce.date().optional()
});
router.post('/:id/transcripts', validate(ingestSchema), asyncHandler(async (req, res) => {
  const meeting = await requireLive(req);
  const b = req.valid.body;
  const { transcript, duplicate } = await ingestFinalSegment({
    io: req.app.get('io'), meeting, user: req.user, text: b.text, sourceLanguage: b.sourceLanguage,
    provider: 'browser', clientSegmentId: b.clientSegmentId, occurredAt: b.occurredAt && b.occurredAt <= new Date(Date.now() + 60_000) ? b.occurredAt : undefined
  });
  res.status(duplicate ? 200 : 201).json({ transcript: segmentDTO(transcript), duplicate });
}));

// ---------- Audio chunk -> real speech-to-text provider ----------
// The client sends self-contained audio files (3-10 s) as the raw request body, NOT through Socket.IO.
const audioBody = express.raw({ type: req => /^(audio|video)\//i.test(req.headers['content-type'] || ''), limit: '8mb' });
const ALLOWED_MIME = /^(audio|video)\/(webm|ogg|wav|x-wav|wave|mp4|mpeg|mp3|x-m4a|m4a)(;|$)/i;
const hasAudioMagic = b =>
  b.length > 12 && (
    (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) ||             // WebM / Matroska
    b.subarray(0, 4).toString('latin1') === 'OggS' ||                                  // Ogg
    (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE') || // WAV
    b.subarray(4, 8).toString('latin1') === 'ftyp' ||                                  // MP4 / M4A
    b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)  // MP3
  );
const inFlightAudio = new Set();

router.post('/:id/audio', audioLimiter, audioBody, asyncHandler(async (req, res) => {
  const meeting = await requireLive(req);
  const contentType = req.headers['content-type'] || '';
  if (!ALLOWED_MIME.test(contentType)) throw new HttpError(415, 'Unsupported audio type. Use webm, ogg, wav, mp4 or mp3.', 'UNSUPPORTED_MEDIA_TYPE');
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (body.length < 1024) return res.status(200).json({ transcript: null, reason: 'empty_audio' });
  if (!hasAudioMagic(body)) throw new HttpError(415, 'The uploaded data does not look like an audio file.', 'INVALID_AUDIO');

  const segmentId = String(req.headers['x-segment-id'] || '').trim();
  if (segmentId.length < 8 || segmentId.length > 150) throw badRequest('X-Segment-Id header (8-150 chars) is required.', 'VALIDATION_ERROR');
  const selected = String(req.headers['x-source-language'] || 'auto');
  if (selected !== 'auto' && !isSupportedLanguage(selected)) throw badRequest('Unsupported X-Source-Language.', 'VALIDATION_ERROR');

  const dup = await Transcript.findOne({ meeting: meeting._id, speaker: req.user._id, clientSegmentId: segmentId });
  if (dup) return res.json({ transcript: segmentDTO(dup), duplicate: true });
  const lock = `${meeting._id}:${req.user._id}:${segmentId}`;
  if (inFlightAudio.has(lock)) throw conflict('This audio segment is already being processed.', 'SEGMENT_IN_PROGRESS');
  inFlightAudio.add(lock);
  try {
    const provider = getSpeechProvider();
    if (!provider || !provider.isConfigured()) throw new HttpError(503, 'Speech-to-text is not configured on the server. Set STT_API_KEY (see README) or use the browser speech engine.', 'STT_NOT_CONFIGURED');
    let result;
    try { result = await provider.transcribe({ buffer: body, mimeType: contentType, language: selected }); }
    catch (err) { rethrowProvider(err); }
    if (!result.text) return res.json({ transcript: null, reason: 'no_speech' });
    const { transcript, duplicate } = await ingestFinalSegment({
      io: req.app.get('io'), meeting, user: req.user, text: result.text.slice(0, 4000),
      sourceLanguage: selected, detectedLanguage: result.language, provider: provider.name,
      clientSegmentId: segmentId, audioDurationMs: result.durationMs
    });
    res.status(duplicate ? 200 : 201).json({ transcript: segmentDTO(transcript), duplicate });
  } finally { inFlightAudio.delete(lock); }
}));

// ---------- Reading transcripts (paged) ----------
const listSchema = z.object({
  page: z.coerce.number().int().min(1).catch(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).catch(50).default(50),
  afterSeq: z.coerce.number().int().min(0).optional().catch(undefined), // catch-up after a reconnect
  lang: lang.optional().catch(undefined)                                  // attach stored translations in this language
});
router.get('/:id/transcripts', validate(listSchema, 'query'), asyncHandler(async (req, res) => {
  const meeting = await loadMeetingForMember(req.params.id, req.user);
  const { page, limit, afterSeq, lang: target } = req.valid.query;
  const filter = { meeting: meeting._id, ...(afterSeq !== undefined ? { seq: { $gt: afterSeq } } : {}) };
  const [rows, total] = await Promise.all([
    Transcript.find(filter).sort({ seq: 1 }).skip(afterSeq !== undefined ? 0 : (page - 1) * limit).limit(limit),
    Transcript.countDocuments({ meeting: meeting._id })
  ]);
  const byTranscript = new Map();
  if (target && rows.length) {
    const found = await Translation.find({ transcript: { $in: rows.map(r => r._id) }, targetLanguage: target });
    found.forEach(t => byTranscript.set(String(t.transcript), { text: t.text, targetLanguage: t.targetLanguage, provider: t.provider }));
  }
  const names = await speakerNames(rows);
  res.json({ transcripts: rows.map(r => segmentDTO(r, byTranscript.get(String(r._id)) || null, names)), page, limit, total, lastSeq: meeting.transcriptSeq });
}));

// ---------- Translations ----------
router.get('/:id/translations', validate(listSchema.extend({ lang: lang }), 'query'), asyncHandler(async (req, res) => {
  const meeting = await loadMeetingForMember(req.params.id, req.user);
  const { page, limit, lang: target } = req.valid.query;
  const filter = { meeting: meeting._id, targetLanguage: target };
  const [rows, total] = await Promise.all([
    Translation.find(filter).sort({ createdAt: 1 }).skip((page - 1) * limit).limit(limit).populate('transcript', 'seq text speakerName'),
    Translation.countDocuments(filter)
  ]);
  res.json({
    translations: rows.map(t => ({ id: String(t._id), transcriptId: String(t.transcript?._id), seq: t.transcript?.seq, original: t.transcript?.text, speakerName: t.transcript?.speakerName, targetLanguage: t.targetLanguage, text: t.text, provider: t.provider })),
    page, limit, total
  });
}));

// Translate (or re-translate after a failure) one stored transcript into a target language and persist it.
router.post('/:id/translations', validate(z.object({ transcriptId: z.string().refine(isValidId, 'Invalid transcript id.'), targetLanguage: lang })), asyncHandler(async (req, res) => {
  const meeting = await loadMeetingForMember(req.params.id, req.user);
  const { transcriptId, targetLanguage } = req.valid.body;
  const transcript = await Transcript.findOne({ _id: transcriptId, meeting: meeting._id });
  if (!transcript) throw notFound('Transcript segment not found.', 'TRANSCRIPT_NOT_FOUND');
  try {
    const r = await translateTranscript(transcript, targetLanguage, { immediate: true }); // explicit retry: no batching delay
    res.json(r.status === 'same_language'
      ? { status: 'same_language', targetLanguage }
      : { status: 'translated', translation: { text: r.text, targetLanguage, provider: r.provider }, segmentId: String(transcript._id) });
  } catch (err) { rethrowProvider(err); }
}));

export default router;
