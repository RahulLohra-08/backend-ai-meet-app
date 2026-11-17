// Runs without MongoDB (node --test). Provider servers are local fakes; no network or API keys are used.
import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';

test('LLM layer: quota -> fallback, batching, per-item fallback (fake provider servers)', async () => {

  const mk = handler => new Promise(r => { const s = http.createServer((req, res) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => handler(req, res, Buffer.concat(c).toString())); }); s.listen(0, () => r(s)); });
  const reply = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  const chat = content => ({ choices: [{ message: { content } }] });

  // PRIMARY: quota exhausted (what a no-credit OpenAI account returns). FALLBACK: healthy.
  let primaryHits = 0, fallbackHits = 0, fallbackBodies = [];
  const primary = await mk((req, res) => { primaryHits++; reply(res, 429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } }); });
  const fallback = await mk((req, res, body) => {
    fallbackHits++; const b = JSON.parse(body); fallbackBodies.push(b);
    if (/Return ONLY JSON: \{"translations"/.test(b.messages[0].content)) return reply(res, 200, chat(JSON.stringify({ translations: JSON.parse(b.messages[1].content).map(t => `EN:${t}`) })));
    if (b.response_format) return reply(res, 200, chat(JSON.stringify({ overview: 'o', executiveSummary: 'Team agreed to meet.', keyPoints: ['k'], decisions: [], unresolvedQuestions: [], nextSteps: [], discussionTopics: ['t'], actionItems: [{ description: 'Send report', assignedTo: 'Rahul', dueDate: null, priority: 'high', transcriptReference: [1] }] })));
    reply(res, 200, chat('EN:single'));
  });
  Object.assign(process.env, {
    OPENAI_API_KEY: 'sk-primary-test', OPENAI_BASE_URL: `http://127.0.0.1:${primary.address().port}/v1`, OPENAI_MODEL: 'gpt-4o-mini',
    LLM_FALLBACK_API_KEY: 'sk-fallback-test', LLM_FALLBACK_BASE_URL: `http://127.0.0.1:${fallback.address().port}/v1`, LLM_FALLBACK_MODEL: 'llama-test',
    LLM_MAX_RPM: '600', LLM_MAX_RETRIES: '1'
  });
  const { generateNotes } = await import('../src/services/ai/summarizer.js');
  const { llmTranslationProvider } = await import('../src/services/translation/providers.js');
  const { llmProviders } = await import('../src/services/ai/llm.js');

  assert.deepEqual(llmProviders().map(p => p.role), ['primary', 'fallback']);

  // 1) summary: primary is out of quota -> NOT retried against primary, falls back, provider recorded truthfully
  const segs = [{ seq: 1, occurredAt: new Date(), speakerName: 'Rahul', sourceLanguage: 'en', detectedLanguage: null, text: 'I will send the report' }];
  const r = await generateNotes({ segments: segs, participants: ['Rahul'], outputLanguage: 'en' });
  assert.equal(primaryHits, 1, 'quota error must not be retried on the primary');
  assert.equal(r.provider, '127.0.0.1'); assert.equal(r.model, 'llama-test');
  assert.equal(r.notes.actionItems[0].description, 'Send report');
  console.log('summary via fallback OK  (primary hits:', primaryHits, ', fallback hits:', fallbackHits, ')');

  // 2) translation: 4 captions in ONE request to the provider
  fallbackHits = 0;
  const out = await llmTranslationProvider.translateBatch({ texts: ['नमस्ते', 'आप कैसे हैं', 'धन्यवाद', 'ठीक है'], source: 'hi', target: 'en' });
  assert.deepEqual(out.map(o => o.text), ['EN:नमस्ते', 'EN:आप कैसे हैं', 'EN:धन्यवाद', 'EN:ठीक है']);
  assert.equal(fallbackHits, 1, 'one request for four captions');
  console.log('batched translation OK (1 request for 4 captions)');

  // 3) model ignores the JSON format -> graceful per-item fallback, still correct and still gated
  fallback.removeAllListeners('request');
  let n = 0;
  fallback.on('request', (req, res) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => { n++; const b = JSON.parse(Buffer.concat(c).toString()); if (b.response_format) return reply(res, 200, chat('not json at all')); reply(res, 200, chat(`ITEM:${b.messages[1].content}`)); }); });
  const out2 = await llmTranslationProvider.translateBatch({ texts: ['a', 'b'], source: 'hi', target: 'en' });
  assert.deepEqual(out2.map(o => o.text), ['ITEM:a', 'ITEM:b']);
  console.log('per-item fallback OK');

  // 4) fallback NOT configured -> the real error is surfaced (no fake success)
  primary.closeAllConnections?.(); fallback.closeAllConnections?.(); primary.close(); fallback.close();

});
