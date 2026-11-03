// detectOllama(): asks the local Ollama which models it has, so the page can tell the person up front
// whether AI nodes can work, instead of letting them run a flow and hit an error.
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectOllama, platformOf } = require('./engine.js');

test('platformOf picks the instructions to show: windows, mac, linux (the safe default) or mobile (Ollama cannot run there)', () => {
  for (const s of ['Win32', 'Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)']) assert.equal(platformOf(s), 'windows', s);
  for (const s of ['MacIntel', 'macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)']) assert.equal(platformOf(s), 'mac', s);
  for (const s of ['Linux x86_64', 'X11; CrOS x86_64', '', undefined, null]) assert.equal(platformOf(s), 'linux', String(s));
  // phones and tablets: an iPhone user agent also contains "like Mac OS X", mobile must win
  for (const s of ['Android', 'iPhone', 'iPad', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile']) assert.equal(platformOf(s), 'mobile', s);
});

const reply = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
const spy = (fn) => { const calls = []; return { calls, fetch: async (u, i) => { calls.push({ u, i }); return fn(u, i); } }; };

test('detectOllama reports the installed models and the smallest local one', async () => {
  const { calls, fetch } = spy(() => reply({ models: [
    { name: 'big:30b', size: 18e9 }, { name: 'remote:cloud', size: 0 }, { name: 'gpt-oss:20b-cloud', size: 384 },
    { name: 'small:4b', size: 3e9 }, { name: 'mid:8b', size: 5e9 },
  ] }));
  const r = await detectOllama(fetch);
  assert.equal(r.available, true);
  assert.deepEqual(r.models, ['big:30b', 'remote:cloud', 'gpt-oss:20b-cloud', 'small:4b', 'mid:8b']);
  // cloud models are never suggested: they are a few bytes on disk (not 0) and need an Ollama account
  assert.equal(r.smallest, 'small:4b');
  assert.equal(calls[0].u, 'http://localhost:11434/api/tags');
});

test('detectOllama: Ollama running with no models is available but has nothing to suggest', async () => {
  const r = await detectOllama(spy(() => reply({ models: [] })).fetch);
  assert.deepEqual(r, { available: true, models: [], smallest: null });
});

test('detectOllama is "not available" (never throws) when it cannot connect, answers badly or replies junk', async () => {
  const down = async () => { throw new TypeError('Failed to fetch'); };
  const notOk = spy(() => reply({}, false)).fetch;
  const junk = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } });
  for (const f of [down, notOk, junk])
    assert.deepEqual(await detectOllama(f), { available: false, models: [], smallest: null });
});

test('detectOllama gives up after the timeout instead of waiting forever', async () => {
  const hang = (_u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const t0 = Date.now();
  const r = await detectOllama(hang, 'http://localhost:11434', 40);
  assert.equal(r.available, false);
  assert.ok(Date.now() - t0 < 1500);
});

test('detectOllama never calls a host that is not this machine', async () => {
  const { calls, fetch } = spy(() => reply({ models: [] }));
  const r = await detectOllama(fetch, 'https://evil.example');
  assert.equal(r.available, false);
  assert.equal(calls.length, 0);
});
