import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, until } from './helpers.js';
import { ProviderError } from '../src/utils/http.js';

let t, M;
before(async () => {
  t = await startTestServer();
  M = {
    Meeting: (await import('../src/models/Meeting.js')).default,
    Transcript: (await import('../src/models/Transcript.js')).default,
    Translation: (await import('../src/models/Translation.js')).default,
    audit: (await import('../src/services/indexAudit.js')).auditIndexes,
    setMt: (await import('../src/services/translation/index.js')).setTranslationProvider,
    setLlm: (await import('../src/services/ai/llm.js')).setLlm
  };
});
after(async () => { M.setMt(null); M.setLlm(null); await t.stop(); });

const create = (token, title) => t.call('POST', '/api/meetings', { token, body: { title, sourceLanguage: 'hi', targetLanguage: 'en' } });
const live = async (host, title = 'Live') => { const m = (await create(host.token, title)).body.meeting; await t.call('POST', `/api/meetings/${m.code}/join`, { token: host.token, body: {} }); return m; };
const say = (u, m, text, id, lang = 'en') => t.call('POST', `/api/meetings/${m._id}/transcripts`, { token: u.token, body: { text, sourceLanguage: lang, clientSegmentId: id } });

test('ISSUE 2: one account can create many meetings, sequentially and concurrently, with distinct codes', async () => {
  const u = await t.register('Creator');
  const seq = []; for (let i = 0; i < 4; i++) seq.push(await create(u.token, `Meeting ${i}`));
  const par = await Promise.all(Array.from({ length: 6 }, (_, i) => create(u.token, `Parallel ${i}`)));
  const all = [...seq, ...par];
  assert.ok(all.every(r => r.status === 201), all.map(r => r.status).join());
  assert.equal(new Set(all.map(r => r.body.meeting.code)).size, 10);
  assert.equal((await create(u.token, 'Meeting 0')).status, 201); // same title is fine
});

test('ISSUE 2 root cause reproduced: a leftover unique index from an older schema blocks the 2nd meeting; the error names it; the audit fixes it', async () => {
  const u = await t.register('Legacy');
  await M.Meeting.collection.createIndex({ legacyMeetingId: 1 }, { unique: true, name: 'legacyMeetingId_1' }); // what an old schema left behind
  assert.equal((await create(u.token, 'First')).status, 201);
  const second = await create(u.token, 'Second');
  assert.equal(second.status, 409);
  assert.deepEqual(second.body.fields, ['legacyMeetingId']);            // the response says WHICH field
  assert.match(second.body.error, /legacyMeetingId_1/);
  const report = await M.audit();                                        // dry run changes nothing
  assert.ok(report.some(f => f.name === 'legacyMeetingId_1' && f.unique && !f.dropped));
  assert.equal((await create(u.token, 'Still blocked')).status, 409);
  const fixed = await M.audit({ apply: true });                          // drops ONLY stale unique indexes
  assert.ok(fixed.some(f => f.name === 'legacyMeetingId_1' && f.dropped));
  assert.equal((await create(u.token, 'Works again')).status, 201);
  const idx = (await M.Meeting.collection.indexes()).map(i => i.name);
  assert.ok(idx.includes('code_1'), 'the real unique index on code must survive');
});

test('ISSUE 5/14: same speaker + same text inside the window is stored once; different speakers are both kept; rejoin does not duplicate', async () => {
  const a = await t.register('Alpha'); const b = await t.register('Beta');
  const m = await live(a); await t.call('POST', `/api/meetings/${m.code}/join`, { token: b.token, body: {} });
  const first = await say(a, m, 'Hello  everyone', 'seg-dup-0001');
  const dup = await say(a, m, 'hello everyone', 'seg-dup-0002');             // second recognizer instance, different client id
  assert.equal(first.status, 201); assert.equal(dup.body.duplicate, true); assert.equal(dup.body.transcript.id, first.body.transcript.id);
  assert.equal((await say(b, m, 'Hello everyone', 'seg-dup-0003')).status, 201); // another PERSON saying it is legitimate
  await t.call('POST', `/api/meetings/${m.code}/join`, { token: a.token, body: {} }); // rejoin
  await t.call('POST', `/api/meetings/${m.code}/join`, { token: a.token, body: {} });
  assert.equal(await M.Transcript.countDocuments({ meeting: m._id }), 2);
  assert.equal((await t.call('GET', `/api/meetings/${m._id}`, { token: a.token })).body.meeting.participants.length, 2);
});

test('ISSUE 6: speaker identity comes from the authenticated user and stays stable, even after a profile rename', async () => {
  const a = await t.register('Sonika'); const b = await t.register('Rahul');
  const m = await live(a); await t.call('POST', `/api/meetings/${m.code}/join`, { token: b.token, body: {} });
  const as = await t.connectSocket(b.token); await t.emitAck(as, 'meeting:join', { meetingId: m._id });
  const ev = t.waitFor(as, 'caption:final');
  await t.call('POST', `/api/meetings/${m._id}/transcripts`, { token: a.token, body: { text: 'first words', sourceLanguage: 'en', clientSegmentId: 'seg-sp-0001', speakerName: 'Mallory', speaker: b.user.id } }); // spoofing attempt is ignored
  const final = await ev;
  assert.equal(final.speaker.id, a.user.id); assert.equal(final.speaker.name, 'Sonika');
  await say(b, m, 'second words', 'seg-sp-0002'); await say(a, m, 'third words', 'seg-sp-0003');
  await t.call('PATCH', '/api/auth/me', { token: a.token, body: { name: 'Sonika Rani' } });
  const rows = (await t.call('GET', `/api/meetings/${m._id}/transcripts`, { token: b.token })).body.transcripts;
  assert.deepEqual(rows.map(r => [r.speaker.id, r.speaker.name]), [[a.user.id, 'Sonika Rani'], [b.user.id, 'Rahul'], [a.user.id, 'Sonika Rani']]);
  as.close();
});

test('ISSUE 4: temporary rate limit -> "retrying" event, then the translation arrives; transcript was never affected', async () => {
  let n = 0;
  M.setMt({ name: 'flaky-mt', isConfigured: () => true, translate: async ({ text }) => { if (++n <= 2) throw new ProviderError('RATE_LIMITED', 'slow down', 429, { retryAfterMs: 80 }); return { text: `EN(${text})` }; } });
  const host = await t.register('Host'); const m = await live(host);
  const s = await t.connectSocket(host.token); await t.emitAck(s, 'meeting:join', { meetingId: m._id, captionLanguage: 'en' });
  const events = []; s.on('caption:translation', e => events.push(e));
  const r = await say(host, m, 'नमस्ते', 'seg-rl-0001', 'hi');
  assert.equal(r.status, 201);                                            // saved immediately
  await until(() => events.some(e => e.status === 'translated'), 15000);
  assert.ok(events.some(e => e.status === 'retrying' && e.retryInMs >= 80));
  assert.equal(events.at(-1).text, 'EN(नमस्ते)');
  assert.equal(await M.Translation.countDocuments({ meeting: m._id }), 1);
  s.close();
});

test('ISSUE 4: permanent provider failure (quota) -> "failed" immediately with retryable=false; manual retry works once fixed; transcript untouched', async () => {
  M.setMt({ name: 'broke-mt', isConfigured: () => true, translate: async () => { throw new ProviderError('QUOTA_EXCEEDED', 'no credit', 402, { retryable: false }); } });
  const host = await t.register('Host'); const m = await live(host);
  const s = await t.connectSocket(host.token); await t.emitAck(s, 'meeting:join', { meetingId: m._id, captionLanguage: 'en' });
  const failed = t.waitFor(s, 'caption:translation', 8000);
  const seg = (await say(host, m, 'नमस्ते', 'seg-q-0001', 'hi')).body.transcript;
  const e = await failed;
  assert.equal(e.status, 'failed'); assert.equal(e.code, 'QUOTA_EXCEEDED'); assert.equal(e.retryable, false);
  assert.equal((await M.Transcript.findById(seg.id)).text, 'नमस्ते');
  M.setMt({ name: 'fixed-mt', isConfigured: () => true, translate: async ({ text }) => ({ text: `EN(${text})` }) });  // operator added credit
  const retry = await t.call('POST', `/api/meetings/${m._id}/translations`, { token: host.token, body: { transcriptId: seg.id, targetLanguage: 'en' } });
  assert.equal(retry.body.translation.text, 'EN(नमस्ते)');                 // no re-transcription needed
  s.close();
});

test('ISSUE 4: captions arriving together are translated in ONE provider request', async () => {
  const batches = [];
  M.setMt({ name: 'batch-mt', isConfigured: () => true, translateBatch: async ({ texts }) => { batches.push(texts.length); return texts.map(x => ({ text: `EN(${x})` })); } });
  const host = await t.register('Host'); const m = await live(host);
  for (let i = 0; i < 4; i++) await say(host, m, `वाक्य ${i}`, `seg-b-000${i}`, 'hi');
  await until(async () => (await M.Translation.countDocuments({ meeting: m._id })) === 4, 8000);
  assert.ok(batches.reduce((a, b) => a + b, 0) === 4 && batches.length < 4, `batches=${batches}`);
});

test('ISSUE 3: summary survives a rate limit (auto retry) and reports quota exhaustion honestly; manual retry works; transcripts are never altered', async () => {
  const host = await t.register('Asha'); const m = await live(host);
  await say(host, m, 'We must ship on Friday', 'seg-s-0001'); await say(host, m, 'I will send the report', 'seg-s-0002');
  await t.call('POST', `/api/meetings/${m._id}/end`, { token: host.token });
  const ok = { overview: 'o', executiveSummary: 'Ship on Friday.', keyPoints: ['k'], decisions: [], unresolvedQuestions: [], nextSteps: [], discussionTopics: [], actionItems: [] };
  const poll = async () => until(async () => { const s = (await t.call('GET', `/api/meetings/${m._id}/summary`, { token: host.token })).body.summary; return s && s.status !== 'processing' && s; }, 15000);

  let calls = 0;
  M.setLlm({ configured: true, name: 'fake-llm', model: 'm', chatJson: async () => { if (++calls === 1) throw new ProviderError('RATE_LIMITED', 'slow down', 429, { retryAfterMs: 60 }); return ok; } });
  assert.equal((await t.call('POST', `/api/meetings/${m._id}/summarize`, { token: host.token, body: {} })).status, 202);
  const done = await poll();
  assert.equal(done.status, 'completed'); assert.equal(done.provider, 'fake-llm'); assert.ok(done.attempts >= 2);

  M.setLlm({ configured: true, name: 'fake-llm', model: 'm', chatJson: async () => { throw new ProviderError('QUOTA_EXCEEDED', 'no credit', 402, { retryable: false }); } });
  await t.call('POST', `/api/meetings/${m._id}/summarize`, { token: host.token, body: {} });
  const failed = await poll();
  assert.equal(failed.status, 'failed'); assert.equal(failed.errorCode, 'QUOTA_EXCEEDED'); assert.equal(failed.retryable, false);
  assert.equal(failed.content.executiveSummary, 'Ship on Friday.');       // the previous good notes are preserved, not blanked

  M.setLlm({ configured: true, name: 'fake-llm', model: 'm', chatJson: async () => ({ ...ok, executiveSummary: 'Second run.' }) });
  await t.call('POST', `/api/meetings/${m._id}/summarize`, { token: host.token, body: {} });
  assert.equal((await poll()).content.executiveSummary, 'Second run.');
  assert.equal(await M.Transcript.countDocuments({ meeting: m._id }), 2);
});
