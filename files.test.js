const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { runFlow, parseFile, docxText, readFile } = require('./engine.js');

// Builds a minimal one-entry zip in memory (deflated or stored) and returns an ArrayBuffer.
function makeZip(name, content, stored = false) {
  const data = Buffer.from(content, 'utf8');
  const body = stored ? data : zlib.deflateRawSync(data);
  const method = stored ? 0 : 8;
  const nameB = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
  local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameB.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
  central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameB.length, 28);
  const localPart = Buffer.concat([local, nameB, body]);
  const cd = Buffer.concat([central, nameB]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(localPart.length, 16);
  const all = Buffer.concat([localPart, cd, eocd]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}

const DOC = '<w:document><w:body>'
  + '<w:p><w:r><w:t>Hello</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t xml:space="preserve">World &amp; co</w:t></w:r><w:r><w:tab/><w:t>x</w:t></w:r></w:p>'
  + '<w:p></w:p>'
  + '</w:body></w:document>';

test('docxText extracts paragraphs, entities and tabs from a compressed docx', async () => {
  assert.equal(await docxText(makeZip('word/document.xml', DOC)), 'Hello\nWorld & co\tx');
});

test('docxText also reads stored (uncompressed) entries', async () => {
  assert.equal(await docxText(makeZip('word/document.xml', DOC, true)), 'Hello\nWorld & co\tx');
});

test('docxText rejects data that is not a zip', async () => {
  await assert.rejects(docxText(new TextEncoder().encode('just text').buffer), /valid \.docx/);
});

test('docxText rejects a zip without word/document.xml', async () => {
  await assert.rejects(docxText(makeZip('other.xml', '<a/>')), /valid \.docx/);
});

test('parseFile refuses binary files with a clear message instead of garbage', () => {
  assert.throws(() => parseFile('cv.pdf', '%PDF-1.4\u0000��'), /binary/i);
});

for (const type of ['table', 'document']) {
  test(`${type} node without data says to choose a file`, async () => {
    const r = await runFlow({ nodes: [{ id: 'f', type, params: { items: [] } }], edges: [] });
    assert.equal(r.results.f.status, 'error');
    assert.match(r.results.f.error, /choose a file/i);
  });
}

// ---------- readFile: each upload node accepts a closed list of types ----------
const fake = (name, { text = '', buffer } = {}) => ({ name, text: async () => text, arrayBuffer: async () => buffer });

test('table node reads CSV and JSON', async () => {
  assert.deepEqual(await readFile('table', fake('a.csv', { text: 'a,b\n1,2\n' })), [{ a: '1', b: '2' }]);
  assert.deepEqual(await readFile('table', fake('A.JSON', { text: '[{"a":1}]' })), [{ a: 1 }]);
});

test('document node reads .docx and plain text as one {name, text} item', async () => {
  const buffer = makeZip('word/document.xml', DOC);
  assert.deepEqual(await readFile('document', fake('cv.docx', { buffer })), [{ name: 'cv.docx', text: 'Hello\nWorld & co\tx' }]);
  assert.deepEqual(await readFile('document', fake('n.md', { text: '# hi' })), [{ name: 'n.md', text: '# hi' }]);
});

test('each upload node refuses types that belong to the other or are unsupported', async () => {
  await assert.rejects(readFile('table', fake('cv.docx')), /Unsupported file type.*\.csv, \.json/);
  await assert.rejects(readFile('table', fake('notes.txt')), /Unsupported/);
  await assert.rejects(readFile('document', fake('data.csv')), /Unsupported file type.*\.docx, \.txt, \.md/);
  await assert.rejects(readFile('document', fake('cv.pdf')), /Unsupported/);
  await assert.rejects(readFile('document', fake('noextension')), /Unsupported/);
});

test('ollama 404 lists the models that are installed', async () => {
  const json = (body, ok = true, status = 200) => ({ ok, status, headers: { get: () => 'application/json' }, json: async () => body });
  const fetch = async (url) => (url.endsWith('/api/tags') ? json({ models: [{ name: 'llama3:latest' }] }) : json({}, false, 404));
  const r = await runFlow(
    { nodes: [{ id: 'o', type: 'ollama', params: { host: 'http://localhost:11434', model: 'llama3.2', prompt: 'hi', field: 'ai' } }], edges: [] },
    { fetch },
  );
  assert.match(r.results.o.error, /llama3:latest/);
});
