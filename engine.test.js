const test = require('node:test');
const assert = require('node:assert/strict');
const { runFlow } = require('./engine.js');

const orders = [
  { name: 'Ana', amount: 50 },
  { name: 'Luis', amount: 150 },
  { name: 'Eva', amount: 300 },
];
const src = { id: 's', type: 'source', params: { items: orders } };
const out = { id: 'o', type: 'output', params: {} };

test('source -> output passes every item through', async () => {
  const r = await runFlow({ nodes: [src, out], edges: [{ from: 's', to: 'o' }] });
  assert.equal(r.results.o.status, 'ok');
  assert.deepEqual(r.results.o.items, orders);
});

test('filter keeps only matching items', async () => {
  const filter = { id: 'f', type: 'filter', params: { field: 'amount', op: '>', value: 100 } };
  const r = await runFlow({
    nodes: [src, filter, out],
    edges: [{ from: 's', to: 'f' }, { from: 'f', to: 'o' }],
  });
  assert.deepEqual(r.results.o.items.map((i) => i.name), ['Luis', 'Eva']);
});

test('set writes a field and fills {{field}} templates', async () => {
  const set = { id: 'e', type: 'set', params: { field: 'msg', value: 'Hola {{name}}' } };
  const r = await runFlow({
    nodes: [src, set, out],
    edges: [{ from: 's', to: 'e' }, { from: 'e', to: 'o' }],
  });
  assert.equal(r.results.o.items[0].msg, 'Hola Ana');
});

test('validate fails on a missing field; downstream is skipped, upstream stays ok', async () => {
  const bad = { id: 's', type: 'source', params: { items: [{ name: 'Ana' }, { amount: 5 }] } };
  const val = { id: 'v', type: 'validate', params: { field: 'name' } };
  const r = await runFlow({
    nodes: [bad, val, out],
    edges: [{ from: 's', to: 'v' }, { from: 'v', to: 'o' }],
  });
  assert.equal(r.results.s.status, 'ok');
  assert.equal(r.results.v.status, 'error');
  assert.match(r.results.v.error, /name/);
  assert.equal(r.results.o.status, 'skipped');
});

test('a node with two inputs receives the items of both', async () => {
  const s2 = { id: 's2', type: 'source', params: { items: [{ name: 'Zoe', amount: 1 }] } };
  const r = await runFlow({
    nodes: [src, s2, out],
    edges: [{ from: 's', to: 'o' }, { from: 's2', to: 'o' }],
  });
  assert.equal(r.results.o.items.length, 4);
});

test('delay waits through the injected sleep', async () => {
  const waited = [];
  const delay = { id: 'd', type: 'delay', params: { ms: 250 } };
  await runFlow(
    { nodes: [src, delay, out], edges: [{ from: 's', to: 'd' }, { from: 'd', to: 'o' }] },
    { sleep: async (ms) => waited.push(ms) },
  );
  assert.deepEqual(waited, [250]);
});

test('a cycle is rejected before running anything', async () => {
  const a = { id: 'a', type: 'set', params: { field: 'x', value: '1' } };
  const b = { id: 'b', type: 'set', params: { field: 'y', value: '2' } };
  await assert.rejects(
    runFlow({ nodes: [a, b], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }),
    /cycle/i,
  );
});

test('an unknown filter operator is reported as a node error', async () => {
  const filter = { id: 'f', type: 'filter', params: { field: 'amount', op: '~~', value: 1 } };
  const r = await runFlow({ nodes: [src, filter], edges: [{ from: 's', to: 'f' }] });
  assert.equal(r.results.f.status, 'error');
});
