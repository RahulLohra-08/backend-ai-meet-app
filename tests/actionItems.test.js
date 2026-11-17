import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.stop(); });

async function room() {
  const host = await t.register('Host'); const a = await t.register('Alice'); const b = await t.register('Bob'); const out = await t.register('Out');
  const m = (await t.call('POST', '/api/meetings', { token: host.token, body: { title: 'Tasks' } })).body.meeting;
  for (const u of [host, a, b]) await t.call('POST', `/api/meetings/${m.code}/join`, { token: u.token, body: {} });
  return { host, a, b, out, m };
}

test('create / list / update / delete with validation', async () => {
  const { host, a, m } = await room();
  const c = await t.call('POST', `/api/meetings/${m._id}/action-items`, { token: host.token, body: { description: 'Write spec', assignedTo: a.user.id, dueDate: '2026-12-01', priority: 'high' } });
  assert.equal(c.status, 201); assert.equal(c.body.actionItem.source, 'manual'); assert.equal(c.body.actionItem.assignedTo.name, 'Alice');
  assert.equal((await t.call('POST', `/api/meetings/${m._id}/action-items`, { token: host.token, body: { description: '' } })).status, 400);
  assert.equal((await t.call('POST', `/api/meetings/${m._id}/action-items`, { token: host.token, body: { description: 'x', priority: 'urgent' } })).status, 400);
  const id = c.body.actionItem.id;
  const done = await t.call('PATCH', `/api/action-items/${id}`, { token: a.token, body: { status: 'done' } }); // assignee may update
  assert.equal(done.status, 200); assert.ok(done.body.actionItem.completedAt);
  assert.equal((await t.call('PATCH', `/api/action-items/${id}`, { token: host.token, body: {} })).status, 400);
  const mine = await t.call('GET', '/api/action-items?assignedTo=me&status=done', { token: a.token });
  assert.equal(mine.body.total, 1);
  assert.equal((await t.call('GET', `/api/meetings/${m._id}/action-items`, { token: a.token })).body.actionItems.length, 1);
  assert.equal((await t.call('DELETE', `/api/action-items/${id}`, { token: host.token })).status, 200);
  assert.equal((await t.call('PATCH', `/api/action-items/${id}`, { token: host.token, body: { status: 'todo' } })).status, 404);
});

test('permissions: outsiders blocked, unrelated participants cannot edit, assignee must be a participant', async () => {
  const { host, a, b, out, m } = await room();
  const id = (await t.call('POST', `/api/meetings/${m._id}/action-items`, { token: host.token, body: { description: 'Host task', assignedTo: a.user.id } })).body.actionItem.id;
  assert.equal((await t.call('GET', `/api/meetings/${m._id}/action-items`, { token: out.token })).status, 403);
  assert.equal((await t.call('POST', `/api/meetings/${m._id}/action-items`, { token: out.token, body: { description: 'sneaky' } })).status, 403);
  assert.equal((await t.call('PATCH', `/api/action-items/${id}`, { token: out.token, body: { status: 'done' } })).status, 403);
  assert.equal((await t.call('PATCH', `/api/action-items/${id}`, { token: b.token, body: { status: 'done' } })).status, 403); // Bob is neither creator nor assignee
  assert.equal((await t.call('DELETE', `/api/action-items/${id}`, { token: b.token })).status, 403);
  const bad = await t.call('PATCH', `/api/action-items/${id}`, { token: host.token, body: { assignedTo: out.user.id } });
  assert.equal(bad.status, 400); assert.equal(bad.body.code, 'ASSIGNEE_NOT_PARTICIPANT');
  assert.equal((await t.call('PATCH', '/api/action-items/not-an-id', { token: host.token, body: { status: 'done' } })).status, 404);
});
