import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, until } from './helpers.js';

let t, setLlm;
before(async () => { t = await startTestServer(); ({ setLlm } = await import('../src/services/ai/llm.js')); });
after(async () => { setLlm(null); await t.stop(); });

async function endedMeeting() {
  const host = await t.register('Asha'); const guest = await t.register('Rahul');
  const m = (await t.call('POST', '/api/meetings', { token: host.token, body: { title: 'Planning', sourceLanguage: 'hi', targetLanguage: 'en' } })).body.meeting;
  await t.call('POST', `/api/meetings/${m.code}/join`, { token: host.token, body: {} });
  await t.call('POST', `/api/meetings/${m.code}/join`, { token: guest.token, body: {} });
  const say = (who, text, i) => t.call('POST', `/api/meetings/${m._id}/transcripts`, { token: who.token, body: { text, sourceLanguage: 'hi', clientSegmentId: `segment-sum-${i}` } });
  await say(host, 'हमें शुक्रवार तक रिपोर्ट चाहिए', 1); await say(guest, 'मैं रिपोर्ट भेज दूँगा', 2);
  return { host, guest, m };
}
const notes = (extra = {}) => ({ overview: 'o', executiveSummary: 'e', keyPoints: ['k'], decisions: [], unresolvedQuestions: [], nextSteps: [], discussionTopics: ['t'],
  actionItems: [{ description: 'Send the report', assignedTo: 'Rahul', dueDate: '2026-11-07', priority: 'high', transcriptReference: [2, 99] }, { description: 'Review design', assignedTo: 'Someone Else', dueDate: 'soon', priority: 'weird', transcriptReference: [] }], ...extra });

test('summarize requires host + ended meeting; AI not configured => honest failed status', async () => {
  setLlm({ configured: false });
  const { host, guest, m } = await endedMeeting();
  assert.equal((await t.call('POST', `/api/meetings/${m._id}/summarize`, { token: host.token, body: {} })).status, 409); // still live
  await t.call('POST', `/api/meetings/${m._id}/end`, { token: host.token });
  assert.equal((await t.call('POST', `/api/meetings/${m._id}/summarize`, { token: guest.token, body: {} })).status, 403);
  const r = await t.call('POST', `/api/meetings/${m._id}/summarize`, { token: host.token, body: {} });
  assert.equal(r.status, 202); assert.equal(r.body.summary.status, 'processing');
  const done = await until(async () => { const s = (await t.call('GET', `/api/meetings/${m._id}/summary`, { token: host.token })).body.summary; return s.status !== 'processing' && s; });
  assert.equal(done.status, 'failed'); assert.equal(done.errorCode, 'NOT_CONFIGURED');
});

test('notes are generated, stored, and action items are saved as ai_suggested without invented data', async () => {
  setLlm({ configured: true, name: 'fake-llm', model: 'm1', chatJson: async () => notes() });
  const { host, m } = await endedMeeting();
  await t.call('POST', `/api/meetings/${m._id}/end`, { token: host.token });
  await t.call('POST', `/api/meetings/${m._id}/summarize`, { token: host.token, body: {} });
  const s = await until(async () => { const x = (await t.call('GET', `/api/meetings/${m._id}/summary`, { token: host.token })).body.summary; return x.status === 'completed' && x; });
  assert.equal(s.content.executiveSummary, 'e'); assert.equal(s.provider, 'fake-llm');
  const items = (await t.call('GET', `/api/meetings/${m._id}/action-items`, { token: host.token })).body.actionItems;
  assert.equal(items.length, 2);
  const send = items.find(i => i.description === 'Send the report'); const review = items.find(i => i.description === 'Review design');
  assert.equal(send.source, 'ai_suggested'); assert.equal(send.assignedTo.name, 'Rahul');
  assert.equal(new Date(send.dueDate).toISOString().slice(0, 10), '2026-11-07');
  assert.deepEqual(send.transcriptSeqs, [2]);                    // reference 99 does not exist -> dropped
  assert.equal(review.assignedTo, null); assert.equal(review.assigneeHint, 'Someone Else'); // unknown name is not an assignee
  assert.equal(review.dueDate, null); assert.equal(review.priority, 'medium');               // "soon" is not a date; bad priority defaulted

  // Regenerate: untouched AI items are replaced (no duplicates); confirmed items survive.
  await t.call('PATCH', `/api/action-items/${send.id}`, { token: host.token, body: { status: 'in_progress' } });
  await t.call('POST', `/api/meetings/${m._id}/summarize`, { token: host.token, body: {} });
  await until(async () => (await t.call('GET', `/api/meetings/${m._id}/summary`, { token: host.token })).body.summary.status === 'completed');
  const again = (await t.call('GET', `/api/meetings/${m._id}/action-items`, { token: host.token })).body.actionItems;
  assert.equal(again.length, 2);
  assert.equal(again.find(i => i.description === 'Send the report').source, 'user_confirmed');
});

test('ending a meeting auto-generates notes when enabled; empty meetings produce none', async () => {
  const { env } = await import('../src/config/env.js');
  setLlm({ configured: true, chatJson: async () => notes({ actionItems: [] }) });
  env.SUMMARY_AUTO_ON_END = true;
  const { host, m } = await endedMeeting();
  await t.call('POST', `/api/meetings/${m._id}/end`, { token: host.token });
  await until(async () => (await t.call('GET', `/api/meetings/${m._id}/summary`, { token: host.token })).body.summary?.status === 'completed');
  const empty = (await t.call('POST', '/api/meetings', { token: host.token, body: { title: 'Empty' } })).body.meeting;
  await t.call('POST', `/api/meetings/${empty._id}/end`, { token: host.token });
  assert.equal((await t.call('GET', `/api/meetings/${empty._id}/summary`, { token: host.token })).body.summary, null);
  env.SUMMARY_AUTO_ON_END = false;
});

test('only one summary job at a time (409 while processing)', async () => {
  let release; const gate = new Promise(r => { release = r; });
  setLlm({ configured: true, chatJson: async () => { await gate; return notes({ actionItems: [] }); } });
  const { host, m } = await endedMeeting();
  await t.call('POST', `/api/meetings/${m._id}/end`, { token: host.token });
  assert.equal((await t.call('POST', `/api/meetings/${m._id}/summarize`, { token: host.token, body: {} })).status, 202);
  const second = await t.call('POST', `/api/meetings/${m._id}/summarize`, { token: host.token, body: {} });
  assert.equal(second.status, 409); assert.equal(second.body.code, 'SUMMARY_IN_PROGRESS');
  release();
  await until(async () => (await t.call('GET', `/api/meetings/${m._id}/summary`, { token: host.token })).body.summary.status === 'completed');
});
