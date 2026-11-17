import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, until, wavBytes } from './helpers.js';

let t, setTranslationProvider, setSpeechProvider, Translation;
before(async () => {
  t = await startTestServer();
  ({ setTranslationProvider } = await import('../src/services/translation/index.js'));
  ({ setSpeechProvider } = await import('../src/services/speech/index.js'));
  ({ default: Translation } = await import('../src/models/Translation.js'));
});
after(async () => { setTranslationProvider(null); setSpeechProvider(null); await t.stop(); });

async function liveMeeting() {
  const host = await t.register('Host');
  const m = (await t.call('POST', '/api/meetings', { token: host.token, body: { title: 'Pipeline', sourceLanguage: 'hi', targetLanguage: 'en' } })).body.meeting;
  await t.call('POST', `/api/meetings/${m.code}/join`, { token: host.token, body: {} });
  return { host, m };
}
let calls = 0;
const fakeMt = { name: 'fake-mt', isConfigured: () => true, translate: async ({ text }) => { calls++; return { text: `EN(${text})` }; } };

test('transcript is stored with order + idempotent on clientSegmentId', async () => {
  const { host, m } = await liveMeeting();
  const body = { text: 'नमस्ते', sourceLanguage: 'hi', clientSegmentId: 'segment-0001' };
  const a = await t.call('POST', `/api/meetings/${m._id}/transcripts`, { token: host.token, body });
  const b = await t.call('POST', `/api/meetings/${m._id}/transcripts`, { token: host.token, body });
  assert.equal(a.status, 201); assert.equal(b.status, 200); assert.equal(b.body.duplicate, true);
  assert.equal(a.body.transcript.id, b.body.transcript.id);
  await t.call('POST', `/api/meetings/${m._id}/transcripts`, { token: host.token, body: { ...body, clientSegmentId: 'segment-0002', text: 'दूसरा' } });
  const list = await t.call('GET', `/api/meetings/${m._id}/transcripts`, { token: host.token });
  assert.deepEqual(list.body.transcripts.map(x => x.seq), [1, 2]);
  assert.equal(list.body.total, 2);
  const after1 = await t.call('GET', `/api/meetings/${m._id}/transcripts?afterSeq=1`, { token: host.token });
  assert.equal(after1.body.transcripts.length, 1);
});

test('transcripts: non-members forbidden, bad payload 400, ended meeting 409', async () => {
  const { host, m } = await liveMeeting();
  const out = await t.register('Out');
  const body = { text: 'hi', sourceLanguage: 'en', clientSegmentId: 'segment-9999' };
  assert.equal((await t.call('POST', `/api/meetings/${m._id}/transcripts`, { token: out.token, body })).status, 403);
  assert.equal((await t.call('GET', `/api/meetings/${m._id}/transcripts`, { token: out.token })).status, 403);
  assert.equal((await t.call('POST', `/api/meetings/${m._id}/transcripts`, { token: host.token, body: { text: '', clientSegmentId: 'short' } })).status, 400);
  await t.call('POST', `/api/meetings/${m._id}/end`, { token: host.token });
  assert.equal((await t.call('POST', `/api/meetings/${m._id}/transcripts`, { token: host.token, body })).status, 409);
});

test('translation is persisted separately, cached, and attached via ?lang=', async () => {
  setTranslationProvider(fakeMt); calls = 0;
  const { host, m } = await liveMeeting();
  const seg = (await t.call('POST', `/api/meetings/${m._id}/transcripts`, { token: host.token, body: { text: 'नमस्ते', sourceLanguage: 'hi', clientSegmentId: 'segment-tr-01' } })).body.transcript;
  await until(async () => (await Translation.countDocuments({ transcript: seg.id })) === 1); // meeting default target (en) auto-translated
  const list = await t.call('GET', `/api/meetings/${m._id}/transcripts?lang=en`, { token: host.token });
  assert.equal(list.body.transcripts[0].text, 'नमस्ते');                 // original untouched
  assert.equal(list.body.transcripts[0].translation.text, 'EN(नमस्ते)');
  assert.equal((await t.call('GET', `/api/meetings/${m._id}/transcripts`, { token: host.token })).body.transcripts[0].translation, null);
  // explicit translate endpoint: same language short-circuits, new language calls provider once
  assert.equal((await t.call('POST', `/api/meetings/${m._id}/translations`, { token: host.token, body: { transcriptId: seg.id, targetLanguage: 'hi' } })).body.status, 'same_language');
  const fr = await t.call('POST', `/api/meetings/${m._id}/translations`, { token: host.token, body: { transcriptId: seg.id, targetLanguage: 'fr' } });
  assert.equal(fr.body.translation.targetLanguage, 'fr');
  await t.call('POST', `/api/meetings/${m._id}/translations`, { token: host.token, body: { transcriptId: seg.id, targetLanguage: 'fr' } });
  assert.equal(calls, 2); // en + fr only; the repeat was served from MongoDB
  const listed = await t.call('GET', `/api/meetings/${m._id}/translations?lang=fr`, { token: host.token });
  assert.equal(listed.body.total, 1);
});

test('translation provider failure is reported honestly (503) and nothing is stored', async () => {
  setTranslationProvider(null); // env has no provider configured
  const { host, m } = await liveMeeting();
  const seg = (await t.call('POST', `/api/meetings/${m._id}/transcripts`, { token: host.token, body: { text: 'नमस्ते', sourceLanguage: 'hi', clientSegmentId: 'segment-fail-1' } })).body.transcript;
  const r = await t.call('POST', `/api/meetings/${m._id}/translations`, { token: host.token, body: { transcriptId: seg.id, targetLanguage: 'en' } });
  assert.equal(r.status, 503); assert.equal(r.body.code, 'NOT_CONFIGURED');
  assert.equal(await Translation.countDocuments({ transcript: seg.id }), 0);
});

test('audio endpoint: validation, STT via adapter, detected language stored, duplicate-safe', async () => {
  const { host, m } = await liveMeeting();
  const audio = (body, h = {}) => t.call('POST', `/api/meetings/${m._id}/audio`, { token: host.token, raw: body, headers: { 'Content-Type': 'audio/wav', 'X-Segment-Id': 'audio-seg-0001', ...h } });
  assert.equal((await audio(Buffer.from('not audio at all'.repeat(100)))).status, 415);                // magic bytes
  assert.equal((await audio(wavBytes(), { 'Content-Type': 'text/plain' })).status, 415);               // mime
  assert.equal((await audio(wavBytes())).status, 503);                                                  // no provider configured
  let n = 0;
  setSpeechProvider({ name: 'fake-stt', isConfigured: () => true, transcribe: async () => { n++; return { text: 'हमें रिपोर्ट चाहिए', language: 'hi', durationMs: 3000 }; } });
  const ok = await audio(wavBytes());
  assert.equal(ok.status, 201);
  assert.equal(ok.body.transcript.detectedLanguage, 'hi'); assert.equal(ok.body.transcript.provider, 'fake-stt');
  const again = await audio(wavBytes());
  assert.equal(again.body.duplicate, true); assert.equal(n, 1);                                         // not processed twice
  setSpeechProvider({ name: 'fake-stt', isConfigured: () => true, transcribe: async () => ({ text: '', language: null }) });
  assert.equal((await audio(wavBytes(), { 'X-Segment-Id': 'audio-seg-0002' })).body.reason, 'no_speech');
  assert.equal((await audio(Buffer.alloc(10))).body.reason, 'empty_audio');
  setSpeechProvider(null);
});
