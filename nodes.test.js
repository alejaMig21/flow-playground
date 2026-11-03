const test = require('node:test');
const assert = require('node:assert/strict');
const { runFlow, parseFile, toCsv } = require('./engine.js');

const edge = (from, to) => ({ from, to });
const res = (body, { ok = true, status = 200, type = 'application/json' } = {}) => ({
  ok, status,
  headers: { get: () => type },
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const recorder = (reply) => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return typeof reply === 'function' ? reply(url, init) : reply; };
  return { calls, fetch };
};

// ---------- parseFile / toCsv ----------
test('parseFile reads CSV with quoted commas', () => {
  const items = parseFile('a.csv', 'name,amount\nAna,50\n"Lu, is",150\n');
  assert.deepEqual(items, [{ name: 'Ana', amount: '50' }, { name: 'Lu, is', amount: '150' }]);
});

test('parseFile reads JSON lists and single objects', () => {
  assert.deepEqual(parseFile('a.json', '[{"a":1},{"a":2}]'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(parseFile('a.json', '{"a":1}'), [{ a: 1 }]);
});

test('parseFile turns any other file into one {name, text} item', () => {
  assert.deepEqual(parseFile('notes.txt', 'hello\nworld'), [{ name: 'notes.txt', text: 'hello\nworld' }]);
});

test('parseFile reports invalid JSON', () => {
  assert.throws(() => parseFile('a.json', '{oops'), /JSON/);
});

test('toCsv writes a header and escapes commas', () => {
  assert.equal(toCsv([{ a: 1, b: 'x,y' }, { a: 2 }]), 'a,b\n1,"x,y"\n2,');
});

// ---------- upload nodes ----------
for (const type of ['table', 'document']) {
  test(`${type} node emits the items read from the uploaded file`, async () => {
    const r = await runFlow({
      nodes: [{ id: 'f', type, params: { items: [{ a: 1 }] } }],
      edges: [],
    });
    assert.deepEqual(r.results.f.items, [{ a: 1 }]);
  });
}

// ---------- http node ----------
test('http GET with no input runs once and emits the JSON object', async () => {
  const { calls, fetch } = recorder(res({ id: 1 }));
  const r = await runFlow(
    { nodes: [{ id: 'h', type: 'http', params: { method: 'GET', url: 'https://x.test/api' } }], edges: [] },
    { fetch },
  );
  assert.deepEqual(r.results.h.items, [{ id: 1 }]);
  assert.equal(calls[0].init.method, 'GET');
});

test('http runs once per input item and fills {{field}} in the URL', async () => {
  const { calls, fetch } = recorder(res({ ok: true }));
  await runFlow(
    {
      nodes: [
        { id: 's', type: 'source', params: { items: [{ id: 7 }, { id: 8 }] } },
        { id: 'h', type: 'http', params: { method: 'GET', url: 'https://x.test/u/{{id}}' } },
      ],
      edges: [edge('s', 'h')],
    },
    { fetch },
  );
  assert.deepEqual(calls.map((c) => c.url), ['https://x.test/u/7', 'https://x.test/u/8']);
});

test('http flattens a JSON array response into items', async () => {
  const { fetch } = recorder(res([{ n: 1 }, { n: 2 }]));
  const r = await runFlow(
    { nodes: [{ id: 'h', type: 'http', params: { method: 'GET', url: 'https://x.test' } }], edges: [] },
    { fetch },
  );
  assert.equal(r.results.h.items.length, 2);
});

test('http POST sends the rendered body as JSON', async () => {
  const { calls, fetch } = recorder(res({}));
  await runFlow(
    {
      nodes: [
        { id: 's', type: 'source', params: { items: [{ name: 'Ana' }] } },
        { id: 'h', type: 'http', params: { method: 'POST', url: 'https://x.test', body: '{"n":"{{name}}"}' } },
      ],
      edges: [edge('s', 'h')],
    },
    { fetch },
  );
  assert.equal(calls[0].init.body, '{"n":"Ana"}');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
});

test('http reports a non-2xx status as a node error', async () => {
  const { fetch } = recorder(res({}, { ok: false, status: 404 }));
  const r = await runFlow(
    { nodes: [{ id: 'h', type: 'http', params: { method: 'GET', url: 'https://x.test' } }], edges: [] },
    { fetch },
  );
  assert.equal(r.results.h.status, 'error');
  assert.match(r.results.h.error, /404/);
});

test('http explains a network/CORS failure', async () => {
  const fetch = async () => { throw new TypeError('Failed to fetch'); };
  const r = await runFlow(
    { nodes: [{ id: 'h', type: 'http', params: { method: 'GET', url: 'https://x.test' } }], edges: [] },
    { fetch },
  );
  assert.match(r.results.h.error, /CORS/);
});

// ---------- code node ----------
test('code maps each item with a JS expression and drops null results', async () => {
  const r = await runFlow({
    nodes: [
      { id: 's', type: 'source', params: { items: [{ amount: 50 }, { amount: 150 }] } },
      { id: 'c', type: 'code', params: { code: 'item.amount > 100 ? { ...item, big: true } : null' } },
    ],
    edges: [edge('s', 'c')],
  });
  assert.deepEqual(r.results.c.items, [{ amount: 150, big: true }]);
});

test('code wraps a non-object result as {value}', async () => {
  const r = await runFlow({
    nodes: [
      { id: 's', type: 'source', params: { items: [{ a: 2 }] } },
      { id: 'c', type: 'code', params: { code: 'item.a * 3' } },
    ],
    edges: [edge('s', 'c')],
  });
  assert.deepEqual(r.results.c.items, [{ value: 6 }]);
});

test('code reports a syntax error as a node error', async () => {
  const r = await runFlow({
    nodes: [
      { id: 's', type: 'source', params: { items: [{ a: 1 }] } },
      { id: 'c', type: 'code', params: { code: 'item.(' } },
    ],
    edges: [edge('s', 'c')],
  });
  assert.equal(r.results.c.status, 'error');
});

// ---------- ollama node ----------
const ollama = { host: 'http://localhost:11434', model: 'llama3', prompt: 'Say hi to {{name}}', field: 'ai' };

// Ollama streams newline-delimited JSON: {"response":"tok","done":false} ... {"done":true}
const ndjson = (objs, { split = false } = {}) => {
  const text = objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
  const parts = split ? [text.slice(0, 10), text.slice(10)] : [text];
  const enc = new TextEncoder();
  return {
    ok: true, status: 200, headers: { get: () => 'application/x-ndjson' },
    body: new ReadableStream({ start(c) { parts.forEach((p) => c.enqueue(enc.encode(p))); c.close(); } }),
  };
};
const oneOllama = (extra = {}) => ({ nodes: [{ id: 'o', type: 'ollama', params: { ...ollama, prompt: 'Say hi', ...extra } }], edges: [] });

test('ollama sends the rendered prompt and stores the answer in the chosen field', async () => {
  const { calls, fetch } = recorder(ndjson([{ response: 'Hello ' }, { response: 'Ana' }, { done: true }]));
  const r = await runFlow(
    {
      nodes: [
        { id: 's', type: 'source', params: { items: [{ name: 'Ana' }] } },
        { id: 'o', type: 'ollama', params: ollama },
      ],
      edges: [edge('s', 'o')],
    },
    { fetch },
  );
  assert.equal(calls[0].url, 'http://localhost:11434/api/generate');
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: 'llama3', prompt: 'Say hi to Ana', stream: true, options: { num_ctx: 8192 } });
  assert.deepEqual(r.results.o.items, [{ name: 'Ana', ai: 'Hello Ana' }]);
});

test('ollama reports the answer as it grows, and copes with a line split across chunks', async () => {
  const seen = [];
  const { fetch } = recorder(ndjson([{ response: 'He' }, { response: 'llo' }, { done: true }], { split: true }));
  const r = await runFlow(oneOllama(), { fetch, onProgress: (id, text) => seen.push([id, text]) });
  assert.deepEqual(seen, [['o', 'He'], ['o', 'Hello']]);
  assert.equal(r.results.o.items[0].ai, 'Hello');
});

test('ollama turns an error line in the stream into a node error', async () => {
  const { fetch } = recorder(ndjson([{ response: 'Hi' }, { error: 'model runner crashed' }]));
  const r = await runFlow(oneOllama(), { fetch });
  assert.equal(r.results.o.status, 'error');
  assert.match(r.results.o.error, /model runner crashed/);
});

test('stopping mid-answer ends the node with "Stopped" and skips what follows', async () => {
  const ac = new AbortController();
  const enc = new TextEncoder();
  const fetch = async (_url, init) => ({
    ok: true, status: 200, headers: { get: () => '' },
    body: new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('{"response":"Hel"}\n'));
        init.signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
      },
    }),
  });
  const flow = { nodes: [...oneOllama().nodes, { id: 'x', type: 'output', params: {} }], edges: [edge('o', 'x')] };
  const r = await runFlow(flow, { fetch, signal: ac.signal, onProgress: () => ac.abort() });
  assert.equal(r.results.o.status, 'error');
  assert.match(r.results.o.error, /Stopped/);
  assert.equal(r.results.x.status, 'skipped');
});

test('a run that is already stopped skips every node', async () => {
  const ac = new AbortController(); ac.abort();
  const r = await runFlow(
    { nodes: [{ id: 's', type: 'source', params: { items: [{ a: 1 }] } }, { id: 'x', type: 'output', params: {} }], edges: [edge('s', 'x')] },
    { signal: ac.signal },
  );
  assert.deepEqual([r.results.s.status, r.results.x.status], ['skipped', 'skipped']);
});

test('ollama explains how to allow the page when the server is unreachable', async () => {
  const fetch = async () => { throw new TypeError('Failed to fetch'); };
  const r = await runFlow({ nodes: [{ id: 'o', type: 'ollama', params: ollama }], edges: [] }, { fetch });
  assert.equal(r.results.o.status, 'error');
  assert.match(r.results.o.error, /OLLAMA_ORIGINS/);
});

test('ollama with no input runs once', async () => {
  const { calls, fetch } = recorder(ndjson([{ response: 'hi' }, { done: true }]));
  const r = await runFlow({ nodes: [{ id: 'o', type: 'ollama', params: { ...ollama, prompt: 'Say hi' } }], edges: [] }, { fetch });
  assert.equal(calls.length, 1);
  assert.deepEqual(r.results.o.items, [{ ai: 'hi' }]);
});
