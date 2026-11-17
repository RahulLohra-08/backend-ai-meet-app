import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.stop(); });

test('register returns a session and never leaks the password hash', async () => {
  const r = await t.call('POST', '/api/auth/register', { body: { name: 'Asha', email: 'asha@example.com', password: 'Password123!' } });
  assert.equal(r.status, 201);
  assert.ok(r.body.accessToken);
  assert.equal(r.body.user.email, 'asha@example.com');
  assert.equal(JSON.stringify(r.body).includes('passwordHash'), false);
  assert.match(r.headers.getSetCookie().join(';'), /lm_refresh=.*HttpOnly/i);
});

test('duplicate email -> 409, weak password / bad email -> 400', async () => {
  await t.call('POST', '/api/auth/register', { body: { name: 'Dup', email: 'dup@example.com', password: 'Password123!' } });
  assert.equal((await t.call('POST', '/api/auth/register', { body: { name: 'Dup', email: 'dup@example.com', password: 'Password123!' } })).status, 409);
  assert.equal((await t.call('POST', '/api/auth/register', { body: { name: 'X Y', email: 'x@example.com', password: 'short' } })).status, 400);
  assert.equal((await t.call('POST', '/api/auth/register', { body: { name: 'X Y', email: 'nope', password: 'Password123!' } })).status, 400);
});

test('login works; wrong password and unknown user are indistinguishable 401s', async () => {
  await t.call('POST', '/api/auth/register', { body: { name: 'Log In', email: 'login@example.com', password: 'Password123!' } });
  const ok = await t.call('POST', '/api/auth/login', { body: { email: 'login@example.com', password: 'Password123!' } });
  assert.equal(ok.status, 200);
  const bad = await t.call('POST', '/api/auth/login', { body: { email: 'login@example.com', password: 'wrong-password' } });
  const ghost = await t.call('POST', '/api/auth/login', { body: { email: 'ghost@example.com', password: 'wrong-password' } });
  assert.equal(bad.status, 401); assert.equal(ghost.status, 401);
  assert.equal(bad.body.error, ghost.body.error);
});

test('protected route: no token / garbage token -> 401; valid token -> 200', async () => {
  const u = await t.register('Prot');
  assert.equal((await t.call('GET', '/api/auth/me')).status, 401);
  assert.equal((await t.call('GET', '/api/auth/me', { token: 'garbage' })).status, 401);
  const me = await t.call('GET', '/api/auth/me', { token: u.token });
  assert.equal(me.status, 200); assert.equal(me.body.user.id, u.user.id);
});

test('refresh rotates the cookie; replaying the old cookie later is rejected', async () => {
  const u = await t.register('Rot');
  const r1 = await t.call('POST', '/api/auth/refresh', { headers: { Cookie: u.cookie } });
  assert.equal(r1.status, 200); assert.ok(r1.body.accessToken);
  const newCookie = r1.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  assert.notEqual(newCookie, u.cookie);
  assert.equal((await t.call('POST', '/api/auth/refresh', { headers: { Cookie: newCookie } })).status, 200);
  assert.equal((await t.call('POST', '/api/auth/refresh')).status, 401); // no cookie
});

test('logout revokes the refresh token', async () => {
  const u = await t.register('Bye');
  assert.equal((await t.call('POST', '/api/auth/logout', { headers: { Cookie: u.cookie } })).status, 200);
  assert.equal((await t.call('POST', '/api/auth/refresh', { headers: { Cookie: u.cookie } })).status, 401);
});

test('profile update validates language; change-password revokes old access tokens', async () => {
  const u = await t.register('Prof');
  assert.equal((await t.call('PATCH', '/api/auth/me', { token: u.token, body: { preferredLanguage: 'xx' } })).status, 400);
  const upd = await t.call('PATCH', '/api/auth/me', { token: u.token, body: { name: 'New Name', preferredLanguage: 'hi' } });
  assert.equal(upd.body.user.preferredLanguage, 'hi');
  assert.equal((await t.call('POST', '/api/auth/change-password', { token: u.token, body: { currentPassword: 'nope-nope', newPassword: 'Another123!' } })).status, 401);
  const ch = await t.call('POST', '/api/auth/change-password', { token: u.token, body: { currentPassword: 'Password123!', newPassword: 'Another123!' } });
  assert.equal(ch.status, 200);
  assert.equal((await t.call('GET', '/api/auth/me', { token: u.token })).status, 401);          // old token revoked
  assert.equal((await t.call('GET', '/api/auth/me', { token: ch.body.accessToken })).status, 200); // new session works
});

test('password reset flow (dev mailer): token is single use', async () => {
  const u = await t.register('Reset');
  const { env } = await import('../src/config/env.js');
  env.DEV_EXPOSE_RESET_LINK = true;
  const f = await t.call('POST', '/api/auth/forgot-password', { body: { email: u.email } });
  env.DEV_EXPOSE_RESET_LINK = false;
  assert.equal(f.status, 200);
  const token = new URL(f.body.devResetLink).searchParams.get('token');
  assert.equal((await t.call('POST', '/api/auth/reset-password', { body: { token, newPassword: 'Brandnew123!' } })).status, 200);
  assert.equal((await t.call('POST', '/api/auth/reset-password', { body: { token, newPassword: 'Brandnew456!' } })).status, 400);
  assert.equal((await t.call('POST', '/api/auth/login', { body: { email: u.email, password: 'Brandnew123!' } })).status, 200);
  const unknown = await t.call('POST', '/api/auth/forgot-password', { body: { email: 'nobody@example.com' } });
  assert.equal(unknown.status, 200); assert.equal(unknown.body.devResetLink, undefined);
});

test('health and capabilities endpoints', async () => {
  const h = await t.call('GET', '/api/health');
  assert.equal(h.status, 200); assert.equal(h.body.database, 'connected');
  const c = await t.call('GET', '/api/capabilities');
  assert.equal(c.body.speechToText.configured, false); // nothing configured in the test env
  assert.ok((await t.call('GET', '/api/languages')).body.languages.some(l => l.code === 'hi'));
});
