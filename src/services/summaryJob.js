import Meeting from '../models/Meeting.js';
import Transcript from '../models/Transcript.js';
import Summary from '../models/Summary.js';
import ActionItem from '../models/ActionItem.js';
import { generateNotes, summarizerStatus } from './ai/summarizer.js';
import { speakerNames } from './pipeline.js';
import { backoffDelay, sleep } from '../utils/backoff.js';
import { meetingRoom } from '../sockets/rooms.js';
import { conflict } from '../utils/httpError.js';
import { normalizeText, parseExplicitDate } from '../utils/text.js';
import { logger } from '../utils/logger.js';

const STALE_MS = 10 * 60 * 1000; // a 'processing' summary older than this is assumed dead (e.g. server restart)

/** Atomically claim the summary slot, then run generation in the background. Returns the 'processing' summary. */
export async function startSummary({ io, meeting, userId, outputLanguage = 'en' }) {
  const count = await Transcript.countDocuments({ meeting: meeting._id });
  const claim = { meeting: meeting._id, $or: [{ status: { $ne: 'processing' } }, { startedAt: { $lt: new Date(Date.now() - STALE_MS) } }] };
  let summary;
  try {
    summary = await Summary.findOneAndUpdate(claim,
      { $set: { status: 'processing', error: '', errorCode: '', retryable: true, provider: summarizerStatus().provider, model: summarizerStatus().model, outputLanguage, requestedBy: userId, startedAt: new Date(), transcriptCount: count } },
      { upsert: true, new: true, setDefaultsOnInsert: true });
  } catch (e) {
    if (e?.code === 11000) throw conflict('Notes are already being generated for this meeting.', 'SUMMARY_IN_PROGRESS');
    throw e;
  }
  io?.to(meetingRoom(meeting._id)).emit('summary:status', { meetingId: String(meeting._id), status: 'processing' });
  setImmediate(() => runSummaryJob({ io, meetingId: meeting._id, summaryId: summary._id, outputLanguage }).catch(err => logger.error('summary job crashed', err)));
  return summary;
}

const MAX_JOB_ATTEMPTS = 3;

export async function runSummaryJob({ io, meetingId, summaryId, outputLanguage }) {
  const room = meetingRoom(meetingId);
  const finish = async patch => {
    await Summary.updateOne({ _id: summaryId }, { $set: { ...patch, completedAt: new Date() } });
    io?.to(room).emit('summary:status', { meetingId: String(meetingId), status: patch.status });
  };
  try {
    const meeting = await Meeting.findById(meetingId).populate('participants.user', 'name');
    const segments = await Transcript.find({ meeting: meetingId }).sort({ seq: 1 }).limit(5000).lean(); // transcripts are only READ here
    if (!segments.length) return await finish({ status: 'failed', retryable: false, errorCode: 'NO_TRANSCRIPT', error: 'There are no transcript segments to summarise.' });
    const names = await speakerNames(segments);
    segments.forEach(s => { s.speakerName = names.get(String(s.speaker)) || s.speakerName; });

    const people = meeting.participants.map(p => ({ id: String(p.user._id), name: p.user.name }));
    let result;
    for (let attempt = 1; ; attempt++) {
      await Summary.updateOne({ _id: summaryId }, { $inc: { attempts: 1 } });
      try { result = await generateNotes({ segments, participants: people.map(p => p.name), outputLanguage }); break; }
      catch (err) {
        // The HTTP layer already retried short waits; if the provider asks for a longer pause we wait here, then try again.
        if (err?.code === 'RATE_LIMITED' && attempt < MAX_JOB_ATTEMPTS) {
          const wait = Math.min(err.retryAfterMs ?? 0, 90_000) || backoffDelay(attempt, { baseMs: 4000, capMs: 60_000 });
          io?.to(room).emit('summary:status', { meetingId: String(meetingId), status: 'processing', retryInMs: wait, attempt });
          logger.info('summary rate limited, waiting', { waitMs: wait, attempt });
          await sleep(wait);
          continue;
        }
        throw err;
      }
    }
    const { notes, provider, model } = result;

    // Action items: replace untouched AI suggestions; never touch user-confirmed or manual items.
    const validSeqs = new Set(segments.map(s => s.seq));
    const kept = await ActionItem.find({ meeting: meetingId, source: { $ne: 'ai_suggested' } }).select('description').lean();
    const seen = new Set(kept.map(k => normalizeText(k.description)));
    const docs = [];
    for (const item of notes.actionItems) {
      const key = normalizeText(item.description);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const wanted = normalizeText(item.assignedTo);
      const person = wanted ? people.find(p => normalizeText(p.name) === wanted) : null; // exact full-name match only
      docs.push({
        meeting: meetingId, description: item.description, source: 'ai_suggested',
        assignedTo: person ? person.id : null,
        assigneeHint: !person && item.assignedTo ? item.assignedTo.slice(0, 200) : '',
        dueDate: parseExplicitDate(item.dueDate),
        priority: ['low', 'medium', 'high'].includes(item.priority) ? item.priority : 'medium',
        transcriptSeqs: [...new Set(item.transcriptReference.filter(n => validSeqs.has(n)))],
        createdBy: meeting.host
      });
    }
    await ActionItem.deleteMany({ meeting: meetingId, source: 'ai_suggested' });
    if (docs.length) await ActionItem.insertMany(docs);

    const { actionItems: _omit, ...content } = notes;
    await finish({ status: 'completed', content, provider, model, error: '', errorCode: '', retryable: true });
  } catch (err) {
    logger.warn('summary generation failed', { code: err?.code, msg: err?.message });
    const st = summarizerStatus();
    await finish({ status: 'failed', provider: st.provider === 'none' ? '' : st.provider, model: st.model, retryable: err?.retryable ?? true, errorCode: err?.code || 'SUMMARY_FAILED', error: err?.expose ? err.message : 'Summary generation failed unexpectedly.' }).catch(() => {});
  }
}

/** Called when a meeting ends. Silent when nothing was transcribed. */
export async function autoSummarizeOnEnd({ io, meeting, userId }) {
  if (!(await Transcript.exists({ meeting: meeting._id }))) return null;
  try { return await startSummary({ io, meeting, userId, outputLanguage: meeting.targetLanguage || 'en' }); }
  catch (e) { logger.warn('auto summary not started', { code: e?.code }); return null; }
}
