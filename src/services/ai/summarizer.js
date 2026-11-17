import { z } from 'zod';
import { chatJson, llmConfigured, llmModelName, llmProviderName, llmFallbackConfigured } from './llm.js';
import { env } from '../../config/env.js';
import { languageName } from '../../config/languages.js';
import { chunkLines } from '../../utils/text.js';
import { ProviderError } from '../../utils/http.js';

// LLM output is untrusted: salvage every valid element instead of rejecting a whole list over one bad entry.
const strList = z.array(z.any()).catch([])
  .transform(a => a.filter(x => typeof x === 'string' || typeof x === 'number').map(x => String(x).trim().slice(0, 1000)).filter(Boolean).slice(0, 40));
const str = z.string().catch('').transform(s => s.trim().slice(0, 4000));
const actionItem = z.object({
  description: z.string().transform(s => s.trim().slice(0, 1000)),
  assignedTo: z.string().nullable().optional().catch(null),
  dueDate: z.string().nullable().optional().catch(null),
  priority: z.string().nullable().optional().catch(null),
  transcriptReference: z.array(z.any()).catch([]).transform(a => a.map(Number).filter(Number.isInteger))
});

export const notesSchema = z.object({
  overview: str, executiveSummary: str,
  discussionTopics: strList, keyPoints: strList, decisions: strList, unresolvedQuestions: strList, nextSteps: strList,
  actionItems: z.array(z.any()).catch([])
    .transform(a => a.map(i => actionItem.safeParse(i)).filter(r => r.success && r.data.description).map(r => r.data).slice(0, 40))
});

const SHAPE = `{
  "overview": string, "executiveSummary": string,
  "discussionTopics": string[], "keyPoints": string[], "decisions": string[], "unresolvedQuestions": string[],
  "actionItems": [{ "description": string, "assignedTo": string|null, "dueDate": "YYYY-MM-DD"|null, "priority": "low"|"medium"|"high", "transcriptReference": number[] }],
  "nextSteps": string[]
}`;

const SYSTEM = (outputLanguage, participants) =>
`You write faithful meeting notes from a transcript. Lines look like "[#12 14:03:05] Speaker (lang): text". The number after # is the segment reference.
Rules:
- Use ONLY information stated in the transcript. Never invent decisions, owners, deadlines or commitments.
- "decisions" only when the group clearly agreed something. Put unclear items in "unresolvedQuestions".
- actionItems: only tasks someone explicitly committed to or was asked to do. "assignedTo" must be one of these participant names exactly, or null if the owner is not explicit: ${participants.join(', ') || '(none)'}.
- "dueDate" only if an explicit calendar date was stated (YYYY-MM-DD); otherwise null. Never convert vague words like "soon" or "next week".
- "transcriptReference": the segment numbers that support the item or claim.
- Write the notes in ${languageName(outputLanguage)}. Keep names unchanged. The transcript may be in several languages.
- If the transcript is too short to summarise, say so in "overview" and return empty lists.
Return ONLY valid JSON with exactly this shape:
${SHAPE}`;

const fmt = s => {
  const time = new Date(s.occurredAt).toISOString().slice(11, 19);
  return `[#${s.seq} ${time}] ${s.speakerName} (${s.detectedLanguage || s.sourceLanguage}): ${s.text}`;
};

/** Labelled, deterministic stand-in used only when DEV_MOCK_PROVIDERS=true and no real LLM is configured. */
function devMockNotes(segments) {
  return {
    overview: `DEV MOCK: ${segments.length} transcript segment(s) captured. No AI model was used.`,
    executiveSummary: 'DEV MOCK summary - configure OPENAI_API_KEY to generate real notes.',
    discussionTopics: [], keyPoints: segments.slice(0, 5).map(s => `${s.speakerName}: ${s.text}`.slice(0, 200)),
    decisions: [], unresolvedQuestions: [], nextSteps: [], actionItems: []
  };
}

export const summarizerStatus = () => ({
  configured: llmConfigured() || env.DEV_MOCK_PROVIDERS,
  provider: llmConfigured() ? llmProviderName() : (env.DEV_MOCK_PROVIDERS ? 'dev-mock' : 'none'),
  model: llmModelName(),
  fallbackConfigured: llmFallbackConfigured()
});

async function oneShot(system, user, used) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) { // one extra try if the model returns malformed JSON
    try {
      const r = await chatJson({ system, user, maxTokens: 3500 });
      used.provider = r.provider; used.model = r.model;       // remember who REALLY answered (primary or fallback)
      return notesSchema.parse(r.data);
    } catch (e) { lastErr = e; if (!(e instanceof ProviderError) || e.code !== 'BAD_RESPONSE') throw e; }
  }
  throw lastErr;
}

/** segments: lean Transcript docs sorted by seq. Returns { notes, provider, model }. */
export async function generateNotes({ segments, participants, outputLanguage = 'en' }) {
  if (!llmConfigured()) {
    if (env.DEV_MOCK_PROVIDERS) return { notes: notesSchema.parse(devMockNotes(segments)), provider: 'dev-mock', model: 'none' };
    throw new ProviderError('NOT_CONFIGURED', 'AI notes are not configured. Set OPENAI_API_KEY (see README).', 503);
  }
  const system = SYSTEM(outputLanguage, participants);
  const chunks = chunkLines(segments.map(fmt), 40000);
  let notes; const used = { provider: llmProviderName(), model: llmModelName() };
  if (chunks.length === 1) {
    notes = await oneShot(system, `Meeting transcript:\n${chunks[0].join('\n')}`, used);
  } else {
    // Long meeting: summarise each chunk, then merge the partial notes into one report.
    const partials = [];
    for (let i = 0; i < chunks.length; i++) partials.push(await oneShot(system, `Part ${i + 1} of ${chunks.length} of the meeting transcript:\n${chunks[i].join('\n')}`, used));
    notes = await oneShot(
      `${system}\nYou are now MERGING partial notes of the same meeting. De-duplicate, keep transcriptReference numbers, keep only what the partial notes already state.`,
      `Partial notes (JSON array):\n${JSON.stringify(partials)}`, used);
  }
  return { notes, provider: used.provider, model: used.model };
}
