import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.stop(); });

const create = (token, body = {}) => t.call('POST', '/api/meetings', { token, body: { title: 'Hindi English Sync', sourceLanguage: 'hi', targetLanguage: 'en', ...body } });

test('create meeting: host is first participant, 8-char code, validation enforced', async () => {
  const host = await t.register('Host');
  const r = await create(host.token);
  assert.equal(r.status, 201);
  assert.match(r.body.meeting.code, /^[A-F0-9]{8}$/);
  assert.equal(r.body.meeting.participants[0].role, 'host');
  assert.equal(r.body.meeting.isHost, true);
  assert.equal((await create(host.token, { title: 'x' })).status, 400);
  assert.equal((await create(host.token, { targetLanguage: 'klingon' })).status, 400);
  assert.equal((await t.call('POST', '/api/meetings', { body: { title: 'No auth' } })).status, 401);
});

test('private meeting: outsiders get 403 until they join; join by code works; no duplicates on re-join', async () => {
  const host = await t.register('Host'); const guest = await t.register('Guest'); const stranger = await t.register('Stranger');
  const m = (await create(host.token)).body.meeting;
  assert.equal((await t.call('GET', `/api/meetings/${m._id}`, { token: guest.token })).status, 403);
  const j1 = await t.call('POST', `/api/meetings/${m.code}/join`, { token: guest.token, body: {} });
  assert.equal(j1.status, 200); assert.equal(j1.body.meeting.status, 'live');
  await t.call('POST', `/api/meetings/${m.code}/join`, { token: guest.token, body: {} });
  const got = await t.call('GET', `/api/meetings/${m._id}`, { token: guest.token });
  assert.equal(got.status, 200); assert.equal(got.body.meeting.participants.length, 2);
  assert.equal((await t.call('GET', `/api/meetings/${m._id}`, { token: stranger.token })).status, 403);
  assert.equal((await t.call('GET', '/api/meetings/FFFFFFFF', { token: stranger.token })).status, 404);
});

test('invite-only meeting rejects uninvited e-mails and admits invited ones', async () => {
  const host = await t.register('Host'); const invited = await t.register('Invited'); const other = await t.register('Other');
  const m = (await create(host.token, { requireInvite: true, invitedEmails: [] })).body.meeting;
  await t.call('PATCH', `/api/meetings/${m._id}`, { token: host.token, body: { invitedEmails: [invited.email] } });
  const no = await t.call('POST', `/api/meetings/${m.code}/join`, { token: other.token, body: {} });
  assert.equal(no.status, 403); assert.equal(no.body.code, 'NOT_INVITED');
  assert.equal((await t.call('POST', `/api/meetings/${m.code}/join`, { token: invited.token, body: {} })).status, 200);
});

test('only the host can update, end and delete; ended meetings cannot be joined', async () => {
  const host = await t.register('Host'); const guest = await t.register('Guest');
  const m = (await create(host.token)).body.meeting;
  await t.call('POST', `/api/meetings/${m.code}/join`, { token: guest.token, body: {} });
  assert.equal((await t.call('PATCH', `/api/meetings/${m._id}`, { token: guest.token, body: { title: 'Hijack' } })).status, 403);
  assert.equal((await t.call('POST', `/api/meetings/${m._id}/end`, { token: guest.token })).status, 403);
  assert.equal((await t.call('DELETE', `/api/meetings/${m._id}`, { token: guest.token })).status, 403);
  const ended = await t.call('POST', `/api/meetings/${m._id}/end`, { token: host.token });
  assert.equal(ended.body.meeting.status, 'completed');
  assert.equal((await t.call('POST', `/api/meetings/${m._id}/end`, { token: host.token })).status, 200); // idempotent
  const late = await t.register('Late');
  assert.equal((await t.call('POST', `/api/meetings/${m.code}/join`, { token: late.token, body: {} })).status, 409);
});

test('history is paginated and only shows my meetings; leave marks leftAt; rejoin clears it', async () => {
  const host = await t.register('Host'); const guest = await t.register('Guest');
  for (let i = 0; i < 3; i++) await create(host.token, { title: `Meeting ${i}` });
  const page = await t.call('GET', '/api/meetings?limit=2&page=1', { token: host.token });
  assert.equal(page.body.meetings.length, 2); assert.equal(page.body.total, 3);
  assert.equal((await t.call('GET', '/api/meetings', { token: guest.token })).body.meetings.length, 0);
  const m = page.body.meetings[0];
  await t.call('POST', `/api/meetings/${m.code}/join`, { token: guest.token, body: {} });
  await t.call('POST', `/api/meetings/${m._id}/leave`, { token: guest.token });
  let p = (await t.call('GET', `/api/meetings/${m._id}`, { token: host.token })).body.meeting.participants.find(x => x.userId === guest.user.id);
  assert.ok(p.leftAt);
  await t.call('POST', `/api/meetings/${m.code}/join`, { token: guest.token, body: {} });
  p = (await t.call('GET', `/api/meetings/${m._id}`, { token: host.token })).body.meeting.participants.find(x => x.userId === guest.user.id);
  assert.equal(p.leftAt, null);
});

test('deleting a meeting removes its transcripts', async () => {
  const host = await t.register('Host');
  const m = (await create(host.token)).body.meeting;
  await t.call('POST', `/api/meetings/${m.code}/join`, { token: host.token, body: {} });
  await t.call('POST', `/api/meetings/${m._id}/transcripts`, { token: host.token, body: { text: 'hello', sourceLanguage: 'en', clientSegmentId: 'seg-aaaaaaaa' } });
  assert.equal((await t.call('DELETE', `/api/meetings/${m._id}`, { token: host.token })).status, 200);
  const { default: Transcript } = await import('../src/models/Transcript.js');
  assert.equal(await Transcript.countDocuments({ meeting: m._id }), 0);
  assert.equal((await t.call('GET', `/api/meetings/${m._id}`, { token: host.token })).status, 404);
});
