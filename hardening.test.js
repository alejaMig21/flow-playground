// Every node must refuse input it cannot handle with a clear message, instead of failing in a confusing way,
// hanging, silently producing wrong data, or leaking data somewhere unexpected.
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { runFlow, sanitizeFlow, checkOllamaHost, toCsv, readFile, parseFile, docxText } = require('./engine.js');

const src = (items) => ({ id: 's', type: 'source', params: { items } });
const edge = (from, to) => ({ from, to });
const after = (node, items = [{ a: 1 }], opts) =>
  runFlow({ nodes: [src(items), { id: 'n', ...node }], edges: [edge('s', 'n')] }, opts);
const alone = (node, opts) => runFlow({ nodes: [{ id: 'n', ...node }], edges: [] }, opts);
const res = (body, { ok = true, status = 200, type = 'application/json' } = {}) => ({
  ok, status, headers: { get: () => type },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const spy = (reply) => { const calls = []; return { calls, fetch: async (u, i) => { calls.push({ u, i }); return reply; } }; };
const many = (n) => Array.from({ length: n }, (_, i) => ({ i }));

// ---------- items: every node receives a list of plain objects, never more than the limit ----------
test('source refuses data that is not a JSON list of objects', async () => {
  for (const items of [null, 'text', [1, 2], [null], [[1]]]) {
    const r = await alone({ type: 'source', params: { items } });
    assert.equal(r.results.n.status, 'error', JSON.stringify(items));
    assert.match(r.results.n.error, /list of objects/);
  }
});

test('a node cannot emit more than 5000 items', async () => {
  const r = await alone({ type: 'source', params: { items: many(5001) } });
  assert.match(r.results.n.error, /Too many items.*5000/);
});

test('JSON files: nested arrays and primitives are wrapped, never used as items', () => {
  assert.deepEqual(parseFile('a.json', '[[1,2],3,null]'), [{ value: [1, 2] }, { value: 3 }, { value: null }]);
});

// ---------- filter ----------
test('filter needs a field, and numeric operators need a numeric value', async () => {
  assert.match((await after({ type: 'filter', params: { field: '', op: '==', value: '1' } })).results.n.error, /field/i);
  assert.match((await after({ type: 'filter', params: { field: 'a', op: '>', value: 'abc' } })).results.n.error, /number/i);
});

test('filter: a missing field never matches ==, and always differs for !=', async () => {
  const items = [{ a: 1 }, { b: 2 }];
  assert.deepEqual((await after({ type: 'filter', params: { field: 'a', op: '==', value: 'undefined' } }, items)).results.n.items, []);
  assert.deepEqual((await after({ type: 'filter', params: { field: 'a', op: '!=', value: '1' } }, items)).results.n.items, [{ b: 2 }]);
});

// ---------- set ----------
test('set needs a normal field name', async () => {
  assert.match((await after({ type: 'set', params: { field: '', value: 'x' } })).results.n.error, /field/i);
  for (const f of ['__proto__', 'constructor', 'prototype'])
    assert.match((await after({ type: 'set', params: { field: f, value: 'x' } })).results.n.error, /not allowed/i);
});

test('{{field}} with an object value is written as JSON, not "[object Object]"', async () => {
  const r = await after({ type: 'set', params: { field: 'm', value: '{{o}}' } }, [{ o: { x: 1 } }]);
  assert.equal(r.results.n.items[0].m, '{"x":1}');
});

// ---------- validate ----------
test('validate needs a field, and treats null as missing', async () => {
  assert.match((await after({ type: 'validate', params: { field: '' } })).results.n.error, /field/i);
  assert.match((await after({ type: 'validate', params: { field: 'a' } }, [{ a: null }])).results.n.error, /Missing "a"/);
});

// ---------- delay ----------
test('delay only accepts 0 to 60000 ms', async () => {
  for (const ms of [-1, 60001, 'abc', NaN, null])
    assert.match((await after({ type: 'delay', params: { ms } }, [{ a: 1 }], { sleep: async () => {} })).results.n.error, /between 0 and 60000/, String(ms));
});

test('delay ends as soon as the run is stopped', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  const t0 = Date.now();
  const r = await after({ type: 'delay', params: { ms: 50000 } }, [{ a: 1 }], { signal: ac.signal });
  assert.ok(Date.now() - t0 < 2000);
  assert.match(r.results.n.error, /Stopped/);
});

// ---------- code ----------
test('code needs an expression and runs through the injected runner (the browser uses a worker with a timeout)', async () => {
  assert.match((await after({ type: 'code', params: { code: '  ' } })).results.n.error, /code/i);
  const r = await after({ type: 'code', params: { code: 'whatever' } }, [{ a: 1 }], { runCode: async (code, items) => [{ ran: code, n: items.length }] });
  assert.deepEqual(r.results.n.items, [{ ran: 'whatever', n: 1 }]);
});

test('code: errors thrown by the user code become node errors', async () => {
  const r = await after({ type: 'code', params: { code: 'nope.x' } });
  assert.equal(r.results.n.status, 'error');
  assert.match(r.results.n.error, /nope/);
});

// ---------- http ----------
const httpNode = (params) => ({ type: 'http', params: { method: 'GET', url: 'https://x.test/api', body: '', ...params } });

test('http only allows GET and POST', async () => {
  const { fetch } = spy(res({}));
  assert.match((await alone(httpNode({ method: 'DELETE' }), { fetch })).results.n.error, /method/i);
});

test('http only allows http(s) URLs', async () => {
  const { calls, fetch } = spy(res({}));
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x.test', 'data:text/plain,hi', 'not a url', ''])
    assert.match((await alone(httpNode({ url }), { fetch })).results.n.error, /http|URL/i, url);
  assert.equal(calls.length, 0);
});

test('http POST: values cannot break out of the JSON body', async () => {
  const evil = 'a","admin":true,"x":"';
  const { calls, fetch } = spy(res({}));
  await after(httpNode({ method: 'POST', body: '{"n":"{{name}}"}' }), [{ name: evil }], { fetch });
  const sent = JSON.parse(calls[0].i.body);
  assert.deepEqual(sent, { n: evil });
});

test('http POST: a body that is not JSON is refused before any request', async () => {
  const { calls, fetch } = spy(res({}));
  const r = await alone(httpNode({ method: 'POST', body: '{oops' }), { fetch });
  assert.match(r.results.n.error, /JSON/);
  assert.equal(calls.length, 0);
});

test('http refuses huge responses and bad JSON', async () => {
  const big = res('"' + 'x'.repeat(5 * 1024 * 1024 + 10) + '"');
  assert.match((await alone(httpNode({}), { fetch: spy(big).fetch })).results.n.error, /too large/i);
  assert.match((await alone(httpNode({}), { fetch: spy(res('{broken')).fetch })).results.n.error, /valid JSON/i);
});

test('http and ollama run at most 50 calls per node', async () => {
  const { calls, fetch } = spy(res({}));
  const r = await after(httpNode({ url: 'https://x.test/{{i}}' }), many(51), { fetch });
  assert.match(r.results.n.error, /at most 50/);
  assert.equal(calls.length, 0);
});

// ---------- ollama ----------
const ollamaNode = (params) => ({ type: 'ollama', params: { host: 'http://localhost:11434', model: 'llama3', prompt: 'hi', field: 'ai', ...params } });

test('checkOllamaHost accepts only this machine', () => {
  for (const h of ['http://localhost:11434', 'http://127.0.0.1:11434/', 'http://[::1]:11434', 'https://localhost'])
    assert.ok(checkOllamaHost(h), h);
  assert.equal(checkOllamaHost('http://localhost:11434/'), 'http://localhost:11434');
  for (const h of ['https://evil.example', 'http://localhost.evil.com', 'http://localhost@evil.com', 'http://192.168.1.5:11434', 'file:///x', '', 'localhost:11434'])
    assert.throws(() => checkOllamaHost(h), /local|host/i, h);
});

test('ollama refuses a remote host, so prompts and documents never leave this machine', async () => {
  const { calls, fetch } = spy(res({}));
  assert.match((await alone(ollamaNode({ host: 'https://evil.example' }), { fetch })).results.n.error, /local/i);
  assert.equal(calls.length, 0);
});

test('ollama validates model, prompt and field before calling anything', async () => {
  const { calls, fetch } = spy(res({}));
  assert.match((await alone(ollamaNode({ model: '' }), { fetch })).results.n.error, /model/i);
  assert.match((await alone(ollamaNode({ model: 'a b;rm' }), { fetch })).results.n.error, /model/i);
  assert.match((await alone(ollamaNode({ prompt: '   ' }), { fetch })).results.n.error, /prompt/i);
  assert.match((await alone(ollamaNode({ field: '__proto__' }), { fetch })).results.n.error, /not allowed/i);
  assert.equal(calls.length, 0);
});

test('ollama refuses prompts too long for the model instead of letting it silently cut them', async () => {
  const { calls, fetch } = spy(res({}));
  const r = await after(ollamaNode({ prompt: '{{text}}' }), [{ text: 'x'.repeat(24001) }], { fetch });
  assert.match(r.results.n.error, /too long/i);
  assert.equal(calls.length, 0);
});

test('ollama asks for a context window that fits the allowed prompt size', async () => {
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"response":"ok"}\n')); c.close(); } });
  const { calls, fetch } = spy({ ok: true, status: 200, headers: { get: () => '' }, body });
  await alone(ollamaNode({}), { fetch });
  assert.equal(JSON.parse(calls[0].i.body).options.num_ctx, 8192);
});

// ---------- CSV export ----------
test('toCsv neutralises spreadsheet formulas but leaves real numbers alone', () => {
  const csv = toCsv([{ a: '=1+1' }, { a: '+cmd' }, { a: '@x' }, { a: '-1+1' }, { a: '-5' }, { a: 7 }, { a: 'plain' }]);
  assert.deepEqual(csv.split('\n').slice(1), ["'=1+1", "'+cmd", "'@x", "'-1+1", '-5', '7', 'plain']);
});

// ---------- uploads ----------
test('readFile refuses files over 5 MB', async () => {
  const f = { name: 'big.csv', size: 6 * 1024 * 1024, text: async () => 'a\n1' };
  await assert.rejects(readFile('table', f), /too large/i);
});

test('docxText refuses a zip bomb', async () => {
  const data = Buffer.alloc(25 * 1024 * 1024);
  const body = zlib.deflateRawSync(data);
  const name = Buffer.from('word/document.xml');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  const lp = Buffer.concat([local, name, body]), cd = Buffer.concat([central, name]);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(lp.length, 16);
  const all = Buffer.concat([lp, cd, eocd]);
  await assert.rejects(docxText(all.buffer.slice(all.byteOffset, all.byteOffset + all.length)), /too large/i);
});

test('docxText turns a corrupt zip into "not a valid .docx", not a RangeError', async () => {
  const junk = new Uint8Array(40); new DataView(junk.buffer).setUint32(18, 0x06054b50, true);
  await assert.rejects(docxText(junk.buffer), /valid \.docx/);
});

// ---------- imported flows ----------
const okFlow = () => ({
  nodes: [{ id: 'a', type: 'source', x: 5, y: 6, params: { items: [{ k: 1 }] } }, { id: 'b', type: 'filter', x: 'bad', params: { field: 'k', op: '>', value: 5, evil: 'x' } }],
  edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }],
});

test('sanitizeFlow keeps only known parameters, fixes their types and drops duplicate connections', () => {
  const f = sanitizeFlow(okFlow());
  assert.equal(f.edges.length, 1);
  assert.deepEqual(f.nodes[1].params, { field: 'k', op: '>', value: '5' });
  assert.equal(f.nodes[1].x, 0);
  assert.deepEqual(f.nodes[0].params.items, [{ k: 1 }]);
});

test('sanitizeFlow falls back to defaults for parameters of the wrong type', () => {
  const f = sanitizeFlow({ nodes: [{ id: 'd', type: 'delay', params: { ms: 'abc' } }], edges: [] });
  assert.equal(f.nodes[0].params.ms, 400);
});

test('sanitizeFlow rejects flows that cannot be trusted to load', () => {
  const bad = (mutate, re) => { const f = okFlow(); mutate(f); assert.throws(() => sanitizeFlow(f), re); };
  assert.throws(() => sanitizeFlow(null), /flow/i);
  assert.throws(() => sanitizeFlow({ nodes: 'x', edges: [] }), /flow/i);
  bad((f) => { f.nodes[1].type = 'nope'; }, /Unknown node type/);
  bad((f) => { f.nodes[1].id = 'a'; }, /Duplicate/);
  bad((f) => { f.edges.push({ from: 'a', to: 'zzz' }); }, /missing node/);
  bad((f) => { f.edges.push({ from: 'b', to: 'a' }); }, /input/);
  bad((f) => { f.nodes.push({ id: 'o', type: 'output', params: {} }); f.edges.push({ from: 'o', to: 'b' }); }, /output/i);
  bad((f) => { f.nodes = Array.from({ length: 31 }, (_, i) => ({ id: 'n' + i, type: 'delay', params: {} })); f.edges = []; }, /at most 30/);
});

test('runFlow itself rejects a connection to a node that does not exist', async () => {
  await assert.rejects(runFlow({ nodes: [src([{ a: 1 }])], edges: [edge('s', 'ghost')] }), /missing node/);
});
