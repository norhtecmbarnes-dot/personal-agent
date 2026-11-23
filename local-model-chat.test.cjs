const { test } = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const vm = require('node:vm');
const fs = require('node:fs');
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('local-model-chat.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: exportsObject, fetch, Date, Error });
const chat = exportsObject.requestLocalChat;
const input = { model: 'local:latest', messages: [{ role: 'user', content: 'Draft' }] };
const reply = data => new Response(JSON.stringify(data));
test('clarification disables hidden reasoning, bounds output/context, and keeps exact model and host', async () => {
  const signal = new AbortController().signal;
  const result = await chat('http://127.0.0.1:11434', { ...input, purpose: 'workflow-clarification' }, signal, async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(init.body);
    assert.equal(body.model, input.model);
    assert.equal(body.think, false);
    assert.equal(body.options.num_predict, 2048);
    assert.equal(body.options.num_ctx, 32768);
    assert.equal(init.signal, signal);
    return reply({ message: { content: ' DRAFT ' }, done_reason: 'stop', load_duration: 1500000 });
  });
  assert.equal(result.message, 'DRAFT');
  assert.equal(result.truncated, false);
  assert.equal(result.metrics.loadMs, 2);
});
test('ordinary and JSON chats retain existing inference behavior', async () => {
  await chat('http://127.0.0.1:11434', { ...input, format: 'json' }, new AbortController().signal, async (_, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.format, 'json');
    assert.equal(body.options.temperature, 0.1);
    assert.equal('think' in body, false);
    assert.equal('num_predict' in body.options, false);
    return reply({ message: { content: '{}' } });
  });
});
test('reasoning-only or empty response is an error, never a successful draft', async () => {
  await assert.rejects(chat('local', input, new AbortController().signal, async () => reply({ message: { thinking: 'hidden', content: '' } })), /no answer text/);
});
test('Ollama errors are surfaced and truncated output is explicitly marked', async () => {
  await assert.rejects(chat('local', input, new AbortController().signal, async () => reply({ error: 'out of memory' })), /out of memory/);
  const result = await chat('local', input, new AbortController().signal, async () => reply({ message: { content: 'partial' }, done_reason: 'length' }));
  assert.equal(result.truncated, true);
});
test('cancellation is propagated without fallback inference', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(chat('local', input, controller.signal, async (_, init) => { calls++; init.signal.throwIfAborted(); }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

const providerChat = exportsObject.requestProviderChat;
const providerInput = { model: 'acme-large', messages: [{ role: 'user', content: 'Draft' }] };
test('provider chat posts to {base}/chat/completions with a bearer key and returns the message', async () => {
  const signal = new AbortController().signal;
  const result = await providerChat('https://api.example.test/v1/', 'sk-test-123', providerInput, signal, async (url, init) => {
    assert.equal(url, 'https://api.example.test/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer sk-test-123');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'acme-large');
    assert.equal(body.stream, false);
    assert.equal(init.signal, signal);
    return reply({ choices: [{ message: { content: ' ANSWER ' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
  });
  assert.equal(result.message, 'ANSWER');
  assert.equal(result.truncated, false);
  assert.equal(result.metrics.generatedTokens, 3);
  assert.equal(result.metrics.promptTokens, 10);
});
test('provider errors surface the provider message; missing choices is an error', async () => {
  await assert.rejects(providerChat('https://api.example.test/v1', 'sk-test-123', providerInput, new AbortController().signal, async () => new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429 })), /quota exceeded/);
  await assert.rejects(providerChat('https://api.example.test/v1', 'sk-test-123', providerInput, new AbortController().signal, async () => reply({})), /no answer text/i);
  await assert.rejects(providerChat('https://api.example.test/v1', 'sk-test-123', providerInput, new AbortController().signal, async () => new Response('upstream down', { status: 502 })), /HTTP 502/);
});
test('provider truncation is flagged, never silently accepted', async () => {
  const result = await providerChat('https://api.example.test/v1', 'sk-test-123', providerInput, new AbortController().signal, async () => reply({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }));
  assert.equal(result.truncated, true);
});
