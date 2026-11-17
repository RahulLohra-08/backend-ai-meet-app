// Runs without MongoDB (node --test). Provider servers are local fakes; no network or API keys are used.
import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';

test('Speech adapter against a fake Whisper-style server', async () => {

  let hits = 0, lastBody = null, mode = 'ok';
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      hits++; lastBody = Buffer.concat(chunks).toString('latin1');
      if (req.headers.authorization !== 'Bearer test-key') { res.writeHead(401); return res.end('{}'); }
      if (mode === 'flaky' && hits < 3) { res.writeHead(429, { 'retry-after': '0' }); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (mode === 'silence') return res.end(JSON.stringify({ text: 'Thank you for watching', language: 'english', duration: 3.2, segments: [{ no_speech_prob: 0.9 }] }));
      res.end(JSON.stringify({ text: ' नमस्ते सब लोग ', language: 'hindi', duration: 4.5, segments: [{ no_speech_prob: 0.01 }] }));
    });
  });
  await new Promise(r => server.listen(0, r));
  process.env.STT_API_KEY = 'test-key';
  process.env.STT_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  const { openaiSpeechAdapter } = await import('../src/services/speech/openaiAdapter.js');
  const buf = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2000, 1)]);

  // happy path: Hindi detected, text trimmed, language mapped to ISO, multipart contains model + file + format
  let r = await openaiSpeechAdapter.transcribe({ buffer: buf, mimeType: 'audio/webm;codecs=opus', language: 'auto' });
  assert.deepEqual(r, { text: 'नमस्ते सब लोग', language: 'hi', durationMs: 4500 });
  assert.match(lastBody, /name="model"/); assert.match(lastBody, /whisper-1/); assert.match(lastBody, /verbose_json/); assert.match(lastBody, /filename="chunk\.webm"/);
  assert.doesNotMatch(lastBody, /name="language"/);          // 'auto' must not force a language
  await openaiSpeechAdapter.transcribe({ buffer: buf, mimeType: 'audio/webm', language: 'hi' });
  assert.match(lastBody, /name="language"[\s\S]*hi/);         // explicit language is forwarded

  // silence hallucination is dropped
  mode = 'silence'; r = await openaiSpeechAdapter.transcribe({ buffer: buf, mimeType: 'audio/webm' });
  assert.equal(r.text, '');

  // transient 429 is retried (adapter allows 1 retry => 2 attempts max, so make it succeed on 2nd)
  mode = 'flaky'; hits = 1;
  r = await openaiSpeechAdapter.transcribe({ buffer: buf, mimeType: 'audio/webm' });
  assert.equal(r.language, 'hi');

  // persistent rate-limit surfaces RATE_LIMITED
  mode = 'flaky'; hits = -50;
  await assert.rejects(() => openaiSpeechAdapter.transcribe({ buffer: buf, mimeType: 'audio/webm' }), e => e.code === 'RATE_LIMITED' && e.status === 429);

  // provider unreachable -> PROVIDER_ERROR, not a crash
  server.closeAllConnections?.(); server.close();
  await assert.rejects(() => openaiSpeechAdapter.transcribe({ buffer: buf, mimeType: 'audio/webm' }), e => e.code === 'PROVIDER_ERROR');

});
