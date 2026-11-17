// Test environment. This file must not statically import anything from ../src: env vars are set first.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.DEV_MOCK_PROVIDERS = 'false';
process.env.SUMMARY_AUTO_ON_END = 'false';
process.env.STT_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.LIBRETRANSLATE_URL = '';

import http from 'node:http';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { io as ioClient } from 'socket.io-client';

export async function startTestServer() {
  let mongod = null;
  let uri = process.env.TEST_MONGODB_URI; // optional: point at a real local MongoDB instead of downloading one
  if (!uri) { mongod = await MongoMemoryServer.create(); uri = mongod.getUri('lingua_test'); }
  const { default: mongoose } = await import('mongoose');
  const { createApp } = await import('../src/app.js');
  const { attachSockets } = await import('../src/sockets/index.js');
  await mongoose.connect(uri);
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map(m => m.init()));
  const app = createApp();
  const server = http.createServer(app);
  const io = attachSockets(server, app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const call = async (method, path, { token, body, headers = {}, raw } = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: raw ? raw : body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, headers: res.headers };
  };
  let counter = 0;
  const register = async (name = 'User', extra = {}) => {
    const email = `${name.toLowerCase().replace(/\W/g, '')}${++counter}-${Date.now()}@example.com`;
    const r = await call('POST', '/api/auth/register', { body: { name, email, password: 'Password123!', ...extra } });
    if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.body)}`);
    return { token: r.body.accessToken, user: r.body.user, email, cookie: (r.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ') };
  };
  const connectSocket = (token) => new Promise((resolve, reject) => {
    const s = ioClient(baseUrl, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
    s.on('connect', () => resolve(s));
    s.on('connect_error', e => { s.close(); reject(e); });
  });
  const emitAck = (socket, event, payload) => new Promise(resolve => socket.emit(event, payload, resolve));
  const waitFor = (socket, event, ms = 4000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, d => { clearTimeout(t); resolve(d); });
  });
  const stop = async () => {
    io.close(); server.close();
    await mongoose.disconnect();
    if (mongod) await mongod.stop();
  };
  return { call, register, connectSocket, emitAck, waitFor, stop, baseUrl, io };
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function until(fn, ms = 5000, step = 50) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('until() timed out'); await sleep(step); }
}
export const wavBytes = (n = 4000) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(n, 7)]);
