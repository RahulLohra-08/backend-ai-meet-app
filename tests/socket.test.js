import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, sleep } from './helpers.js';

let t, setTranslationProvider;
before(async () => { t = await startTestServer(); ({ setTranslationProvider } = await import('../src/services/translation/index.js')); });
after(async () => { setTranslationProvider(null); await t.stop(); });

const setup = async () => {
  const host = await t.register('Host'); const guest = await t.register('Guest'); const outsider = await t.register('Outsider');
  const m = (await t.call('POST', '/api/meetings', { token: host.token, body: { title: 'WS', sourceLanguage: 'hi', targetLanguage: 'en' } })).body.meeting;
  await t.call('POST', `/api/meetings/${m.code}/join`, { token: host.token, body: {} });
  await t.call('POST', `/api/meetings/${m.code}/join`, { token: guest.token, body: {} });
  return { host, guest, outsider, m };
};

test('socket rejects missing / invalid tokens', async () => {
  await assert.rejects(() => t.connectSocket(undefined), /UNAUTHENTICATED/);
  await assert.rejects(() => t.connectSocket('bad.token.value'), /UNAUTHENTICATED|TOKEN_EXPIRED/);
});

test('non-members cannot join the room or receive captions', async () => {
  const { host, outsider, m } = await setup();
  const hs = await t.connectSocket(host.token); const os = await t.connectSocket(outsider.token);
  assert.equal((await t.emitAck(os, 'meeting:join', { meetingId: m._id })).code, 'NOT_A_PARTICIPANT');
  assert.equal((await t.emitAck(hs, 'meeting:join', { meetingId: m._id })).ok, true);
  let leaked = false; os.on('caption:final', () => { leaked = true; });
  await t.call('POST', `/api/meetings/${m._id}/transcripts`, { token: host.token, body: { text: 'secret', sourceLanguage: 'en', clientSegmentId: 'segment-ws-01' } });
  await sleep(300);
  assert.equal(leaked, false);
  // events sent without joining are refused
  assert.equal((await t.emitAck(os, 'chat:send', { text: 'hi' })).code, 'NOT_IN_MEETING');
  hs.close(); os.close();
});

test('captions: original to everyone, translation only to the language room, partials not echoed to sender', async () => {
  setTranslationProvider({ name: 'fake', isConfigured: () => true, translate: async ({ text, target }) => ({ text: `${target.toUpperCase()}:${text}` }) });
  const { host, guest, m } = await setup();
  const hs = await t.connectSocket(host.token); const gs = await t.connectSocket(guest.token);
  await t.emitAck(hs, 'meeting:join', { meetingId: m._id, captionLanguage: 'hi' });   // host reads Hindi
  await t.emitAck(gs, 'meeting:join', { meetingId: m._id, captionLanguage: 'en' });   // guest reads English
  const gFinal = t.waitFor(gs, 'caption:final'); const gTr = t.waitFor(gs, 'caption:translation');
  const hTr = t.waitFor(hs, 'caption:translation');
  let hostGotEnglish = false; hs.on('caption:translation', d => { if (d.language === 'en') hostGotEnglish = true; });
  await t.call('POST', `/api/meetings/${m._id}/transcripts`, { token: host.token, body: { text: 'नमस्ते', sourceLanguage: 'hi', clientSegmentId: 'segment-ws-02' } });
  const final = await gFinal;
  assert.equal(final.text, 'नमस्ते'); assert.equal(final.speaker.name, 'Host'); assert.equal(final.seq, 1); assert.equal(final.isFinal, true);
  const tr = await gTr;
  assert.equal(tr.language, 'en'); assert.equal(tr.status, 'translated'); assert.equal(tr.text, 'EN:नमस्ते'); assert.equal(tr.segmentId, final.id);
  assert.equal((await hTr).status, 'same_language');   // host already reads Hindi: no fake "translation"
  assert.equal(hostGotEnglish, false);

  // partial: delivered to the other participant, never back to the sender
  let echoed = false; hs.on('caption:partial', () => { echoed = true; });
  const gPartial = t.waitFor(gs, 'caption:partial');
  await t.emitAck(hs, 'transcript:partial', { segmentId: 'segment-ws-03', text: 'आप कै', sourceLanguage: 'hi' });
  const p = await gPartial;
  assert.equal(p.isFinal, false); assert.equal(p.text, 'आप कै');
  await sleep(150); assert.equal(echoed, false);
  hs.close(); gs.close();
});

test('switching caption language moves the socket between language rooms; presence + chat work', async () => {
  const { host, guest, m } = await setup();
  const hs = await t.connectSocket(host.token); const gs = await t.connectSocket(guest.token);
  await t.emitAck(hs, 'meeting:join', { meetingId: m._id }); await t.emitAck(gs, 'meeting:join', { meetingId: m._id, captionLanguage: 'en' });
  assert.equal((await t.emitAck(gs, 'caption:setLanguage', { language: 'klingon' })).ok, false);
  assert.equal((await t.emitAck(gs, 'caption:setLanguage', { language: 'fr' })).captionLanguage, 'fr');
  const upd = t.waitFor(hs, 'presence:update');
  await t.emitAck(gs, 'presence:update', { micOn: true, handRaised: true });
  const pres = (await upd).presence.find(p => p.name === 'Guest');
  assert.equal(pres.handRaised, true); assert.equal(pres.captionLanguage, 'fr');
  const msg = t.waitFor(hs, 'chat:message');
  await t.emitAck(gs, 'chat:send', { text: 'bonjour' });
  assert.equal((await msg).text, 'bonjour');
  assert.equal((await t.emitAck(gs, 'chat:send', { text: '' })).ok, false);
  hs.close(); gs.close();
});

test('ending the meeting notifies the room and blocks new joins to the room', async () => {
  const { host, guest, m } = await setup();
  const gs = await t.connectSocket(guest.token);
  await t.emitAck(gs, 'meeting:join', { meetingId: m._id });
  const ended = t.waitFor(gs, 'meeting:ended');
  await t.call('POST', `/api/meetings/${m._id}/end`, { token: host.token });
  assert.equal((await ended).meetingId, m._id);
  assert.equal((await t.emitAck(gs, 'meeting:join', { meetingId: m._id })).code, 'MEETING_ENDED');
  gs.close();
});
