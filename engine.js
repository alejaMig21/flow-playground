// Minimal workflow engine. A flow is a graph: { nodes: [{id, type, params}], edges: [{from, to}] }.
// Each node receives the items of all its inputs and returns the items it emits.
// Works in the browser (window.FlowEngine) and in Node (module.exports) for the tests.
//
// Every node validates its parameters and refuses input it cannot handle with a clear message.
(function (root) {
  const LIMITS = {
    items: 5000,          // items a node may emit
    calls: 50,            // requests an HTTP / Ollama node may make in one run (one per input item)
    bytes: 5 * 1024 * 1024,   // uploaded file / HTTP response size
    xml: 20 * 1024 * 1024,    // size of a .docx once unzipped (zip-bomb guard)
    prompt: 24000,        // characters; with num_ctx 8192 this fits the model's context window
    delayMs: 60000,
    nodes: 30,
    edges: 100,
  };
  const NUM_CTX = 8192;
  const STOPPED = 'Stopped by user';
  const FORBIDDEN_FIELDS = ['__proto__', 'constructor', 'prototype'];
  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

  // What a node starts with. Also the schema sanitizeFlow() checks imported flows against.
  const DEFAULTS = {
    source: () => ({ items: [{ name: 'Ana', amount: 50, email: 'ana@mail.com' }, { name: 'Luis', amount: 150, email: 'luis@mail.com' }, { name: 'Eva', amount: 300, email: 'eva@mail.com' }] }),
    table: () => ({ items: [], fileName: '' }),
    document: () => ({ items: [], fileName: '' }),
    http: () => ({ method: 'GET', url: 'https://jsonplaceholder.typicode.com/todos?_limit=10', body: '' }),
    ollama: () => ({ host: 'http://localhost:11434', model: 'llama3.2', prompt: 'Summarize in one sentence: {{text}}', field: 'ai' }),
    code: () => ({ code: '{ ...item, name: String(item.name).toUpperCase() }' }),
    filter: () => ({ field: 'amount', op: '>', value: '100' }),
    set: () => ({ field: 'msg', value: 'Thanks {{name}}, we got your {{amount}} order' }),
    validate: () => ({ field: 'email' }),
    delay: () => ({ ms: 400 }),
    output: () => ({}),
  };
  const NO_INPUT = ['source', 'table', 'document'];

  const OPS = {
    '==': (a, b) => String(a) === String(b),
    '!=': (a, b) => String(a) !== String(b),
    '>': (a, b) => Number(a) > Number(b),
    '<': (a, b) => Number(a) < Number(b),
    '>=': (a, b) => Number(a) >= Number(b),
    '<=': (a, b) => Number(a) <= Number(b),
    contains: (a, b) => String(a).includes(String(b)),
  };
  const NUMERIC_OPS = ['>', '<', '>=', '<='];

  // Replaces {{field}} with the item's value; objects become JSON. enc encodes it for where it lands (URL, JSON...).
  const show = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v));
  const render = (tpl, item, enc = (s) => s) =>
    String(tpl ?? '').replace(/\{\{(\w+)\}\}/g, (_, k) => enc(show(item[k] ?? '')));

  function fieldName(p) {
    const f = String(p.field ?? '').trim();
    if (!f) throw new Error('Field is required');
    if (FORBIDDEN_FIELDS.includes(f)) throw new Error(`Field name "${f}" is not allowed`);
    return f;
  }

  function checkItems(items, what) {
    if (!Array.isArray(items) || items.some((x) => !isObj(x)))
      throw new Error(`${what} must be a valid JSON list of objects, e.g. [{"name": "Ana"}]`);
    return items;
  }

  // Nodes that call a service run once per input item, or once if they have no input at all.
  function callRows(items, ctx, what) {
    const r = ctx.hasInput ? items : [{}];
    if (r.length > LIMITS.calls)
      throw new Error(`${what} runs once per item: at most ${LIMITS.calls} items allowed, got ${r.length}. Filter the data first.`);
    return r;
  }

  function checkUrl(raw) {
    let u;
    try { u = new URL(raw); } catch (_) { throw new Error(`Invalid URL "${raw}"`); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Only http and https URLs are allowed, got "${u.protocol}"`);
    return u.href;
  }

  // Ollama must be on this machine: prompts and documents never go to a remote host.
  function checkOllamaHost(raw) {
    const m = /^(https?):\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?\/?$/i.exec(String(raw ?? '').trim());
    if (!m) throw new Error('Ollama host must be local: http://localhost:11434, http://127.0.0.1:11434 or http://[::1]:11434');
    return (m[1] + '://' + m[2] + (m[3] || '')).toLowerCase();
  }

  // Asks the local Ollama which models it has, so the page can say up front whether AI nodes can work.
  // Never throws: any failure (not installed, not running, origin not allowed, timeout) is "not available".
  // smallest = the smallest model that really runs locally, a quick default for a first run.
  async function detectOllama(fetchFn = (...a) => globalThis.fetch(...a), host = DEFAULTS.ollama().host, timeoutMs = 2500) {
    const none = { available: false, models: [], smallest: null };
    let base;
    try { base = checkOllamaHost(host); } catch (_) { return none; }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchFn(base + '/api/tags', { signal: ctl.signal });
      if (!r.ok) return none;
      const models = (await r.json()).models || [];
      // cloud models are a few bytes on disk (not zero) and need an Ollama account, so they are never suggested
      const local = models.filter((m) => m.size >= 50e6 && !/cloud$/i.test(m.name)).sort((a, b) => a.size - b.size);
      return { available: true, models: models.map((m) => m.name), smallest: local[0]?.name ?? null };
    } catch (_) {
      return none;
    } finally {
      clearTimeout(timer);
    }
  }

  const asItems = (data) => (Array.isArray(data) ? data : [data]).map((x) => (isObj(x) ? x : { value: x }));

  // Reads Ollama's newline-delimited JSON stream, reporting the growing answer through ctx.progress.
  async function readStream(r, ctx) {
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '', answer = '';
    const line = (s) => {
      if (!s.trim()) return;
      const j = JSON.parse(s);
      if (j.error) throw new Error('Ollama: ' + j.error);
      if (j.response) { answer += j.response; ctx.progress?.(answer); }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        lines.forEach(line);
      }
      line(buf);
    } catch (e) {
      if (ctx.signal?.aborted) throw new Error(STOPPED);
      throw e;
    }
    return answer;
  }

  const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error(STOPPED));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error(STOPPED)); }, { once: true });
  });

  // Fallback used by the tests and Node. The browser page passes a Web Worker runner with a timeout instead.
  async function localRunCode(code, items) {
    let fn;
    try { fn = new Function('item', 'return (' + code + ')'); }
    catch (e) { throw new Error('Code error: ' + e.message); }
    return items.map((it) => fn(it));
  }

  const handlers = {
    source: async (_items, p) => structuredClone(checkItems(p.items, 'Sample data')),
    // table and document are the two upload nodes; the file is read in the UI (readFile) and stored in params.items
    table: async (_items, p) => {
      if (!p.items?.length) throw new Error('No data: choose a file first (or the file has no rows)');
      return structuredClone(checkItems(p.items, 'File data'));
    },
    document: (...a) => handlers.table(...a),
    output: async (items) => items,
    filter: async (items, p) => {
      const field = fieldName(p);
      const op = OPS[p.op];
      if (!op) throw new Error(`Unknown operator "${p.op}"`);
      if (NUMERIC_OPS.includes(p.op) && (String(p.value).trim() === '' || !Number.isFinite(Number(p.value))))
        throw new Error(`Operator ${p.op} needs a number as value, got "${p.value}"`);
      // a missing field never matches, except that it always differs for !=
      return items.filter((it) => (it[field] === undefined ? p.op === '!=' : op(it[field], p.value)));
    },
    set: async (items, p) => {
      const field = fieldName(p);
      return items.map((it) => ({ ...it, [field]: render(p.value, it) }));
    },
    validate: async (items, p) => {
      const field = fieldName(p);
      items.forEach((it, i) => {
        if (it[field] == null || it[field] === '') throw new Error(`Missing "${field}" in item ${i + 1}`);
      });
      return items;
    },
    delay: async (items, p, ctx) => {
      const ms = typeof p.ms === 'number' ? p.ms : typeof p.ms === 'string' && p.ms.trim() !== '' ? Number(p.ms) : NaN;
      if (!Number.isFinite(ms) || ms < 0 || ms > LIMITS.delayMs) throw new Error(`Delay must be between 0 and ${LIMITS.delayMs} ms`);
      await ctx.sleep(ms, ctx.signal);
      return items;
    },
    // JS expression per item: object -> new item, null/undefined -> item dropped, other -> {value}.
    code: async (items, p, ctx) => {
      if (!String(p.code ?? '').trim()) throw new Error('Code is required');
      const raw = await ctx.runCode(String(p.code), items, ctx.signal);
      return raw.flatMap((v) => (v == null ? [] : [isObj(v) ? v : { value: v }]));
    },
    http: async (items, p, ctx) => {
      const method = p.method || 'GET';
      if (!['GET', 'POST'].includes(method)) throw new Error(`HTTP method "${method}" is not allowed (GET or POST)`);
      const out = [];
      for (const it of callRows(items, ctx, 'HTTP request')) {
        const url = checkUrl(render(p.url, it, encodeURIComponent));
        const init = { method, signal: ctx.signal };
        if (method === 'POST' && p.body) {
          // values are escaped for JSON so they cannot add or change fields of the body
          init.body = render(p.body, it, (s) => JSON.stringify(s).slice(1, -1));
          try { JSON.parse(init.body); } catch (_) { throw new Error('Body is not valid JSON once the {{fields}} are filled in'); }
          init.headers = { 'Content-Type': 'application/json' };
        }
        let r;
        try { r = await ctx.fetch(url, init); }
        catch (_) { throw new Error(ctx.signal?.aborted ? STOPPED : `Request to ${url} failed: network error, or CORS (the server must allow requests from this page)`); }
        if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
        const tooLarge = () => new Error(`Response is too large (limit ${LIMITS.bytes / 1048576} MB)`);
        if (Number(r.headers.get('content-length')) > LIMITS.bytes) throw tooLarge();
        const text = await r.text();
        if (text.length > LIMITS.bytes) throw tooLarge();
        let data = { text };
        if ((r.headers.get('content-type') || '').includes('json')) {
          try { data = JSON.parse(text); } catch (_) { throw new Error('Response is not valid JSON'); }
        }
        out.push(...asItems(data));
      }
      return out;
    },
    // Local model through Ollama's HTTP API. Optional: needs Ollama running with OLLAMA_ORIGINS allowing this page.
    ollama: async (items, p, ctx) => {
      const host = checkOllamaHost(p.host || DEFAULTS.ollama().host);
      const model = String(p.model ?? '').trim();
      if (!/^[A-Za-z0-9][\w.\-:/]{0,99}$/.test(model)) throw new Error('Model name is missing or has characters that are not allowed');
      if (!String(p.prompt ?? '').trim()) throw new Error('Prompt is required');
      const field = p.field === undefined || p.field === '' ? 'ai' : fieldName(p);
      const out = [];
      for (const it of callRows(items, ctx, 'Ollama')) {
        const prompt = render(p.prompt, it);
        if (prompt.length > LIMITS.prompt)
          throw new Error(`Prompt is too long (${prompt.length} characters, limit ${LIMITS.prompt}): shorten the document or the prompt, otherwise the model would silently cut it`);
        let r;
        try {
          r = await ctx.fetch(host + '/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt, stream: true, options: { num_ctx: NUM_CTX } }),
            signal: ctx.signal,
          });
        } catch (_) {
          if (ctx.signal?.aborted) throw new Error(STOPPED);
          throw new Error(`Cannot reach Ollama at ${host}. Is it running? Start it with OLLAMA_ORIGINS set to this page's origin (OLLAMA_ORIGINS=* for a quick test).`);
        }
        if (!r.ok) {
          let hint = '';
          if (r.status === 404) {
            hint = ` Model "${model}" is not installed.`;
            try {
              const names = (await (await ctx.fetch(host + '/api/tags')).json()).models.map((m) => m.name);
              hint += names.length ? ' Installed: ' + names.join(', ') : ` Run: ollama pull ${model}`;
            } catch (_) { /* the hint is a nice-to-have */ }
          }
          throw new Error(`Ollama HTTP ${r.status}.` + hint);
        }
        out.push({ ...it, [field]: await readStream(r, ctx) });
      }
      return out;
    },
  };

  // Kahn's algorithm: returns node ids in run order, or throws if the graph has a cycle.
  function order(nodes, edges) {
    const ids = new Set(nodes.map((n) => n.id));
    edges.forEach((e) => { if (!ids.has(e.from) || !ids.has(e.to)) throw new Error('A connection points to a missing node'); });
    const indeg = new Map(nodes.map((n) => [n.id, 0]));
    edges.forEach((e) => indeg.set(e.to, indeg.get(e.to) + 1));
    const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
    const sorted = [];
    while (queue.length) {
      const id = queue.shift();
      sorted.push(id);
      edges.filter((e) => e.from === id).forEach((e) => {
        indeg.set(e.to, indeg.get(e.to) - 1);
        if (indeg.get(e.to) === 0) queue.push(e.to);
      });
    }
    if (sorted.length !== nodes.length) throw new Error('Flow has a cycle');
    return sorted;
  }

  // Returns { results: {id: {status: 'ok'|'error'|'skipped', items, error}}, log: [string] }.
  // opts.onNode(id, status) fires as each node starts/finishes (the UI uses it to colour nodes).
  // opts.sleep, opts.fetch and opts.runCode can be injected (the tests do; the page injects a Web Worker
  // runner for the Transform node). opts.signal (an AbortSignal) stops the run;
  // opts.onProgress(id, text) receives the growing answer of a streaming node.
  async function runFlow(flow, opts = {}) {
    const { nodes, edges } = flow;
    const base = {
      sleep: opts.sleep || defaultSleep,
      fetch: opts.fetch || ((...a) => globalThis.fetch(...a)),
      runCode: opts.runCode || localRunCode,
    };
    const results = {};
    const log = [];
    for (const id of order(nodes, edges)) {
      const node = nodes.find((n) => n.id === id);
      const inputs = edges.filter((e) => e.to === id).map((e) => results[e.from]);
      if (opts.signal?.aborted || inputs.some((r) => r.status !== 'ok')) {
        results[id] = { status: 'skipped', items: [] };
        log.push(`${node.type} (${id}): skipped, ${opts.signal?.aborted ? 'the run was stopped' : 'an input failed'}`);
        opts.onNode?.(id, 'skipped');
        continue;
      }
      opts.onNode?.(id, 'running');
      try {
        const handler = handlers[node.type];
        if (!handler) throw new Error(`Unknown node type "${node.type}"`);
        const ctx = { ...base, hasInput: inputs.length > 0, signal: opts.signal, progress: (t) => opts.onProgress?.(id, t) };
        const items = await handler(inputs.flatMap((r) => r.items), node.params || {}, ctx);
        if (items.length > LIMITS.items) throw new Error(`Too many items (${items.length}). The limit is ${LIMITS.items}.`);
        results[id] = { status: 'ok', items };
        log.push(`${node.type} (${id}): ok, ${items.length} item(s)`);
      } catch (err) {
        results[id] = { status: 'error', items: [], error: err.message };
        log.push(`${node.type} (${id}): ERROR ${err.message}`);
      }
      opts.onNode?.(id, results[id].status);
    }
    return { results, log };
  }

  // Checks a flow loaded from a file and returns a clean copy: known node types, only known parameters
  // with the right types, valid connections. Anything else is refused, not repaired.
  function sanitizeFlow(data) {
    if (!isObj(data) || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error('Not a valid flow file');
    if (data.nodes.length > LIMITS.nodes) throw new Error(`A flow can have at most ${LIMITS.nodes} nodes`);
    if (data.edges.length > LIMITS.edges) throw new Error(`A flow can have at most ${LIMITS.edges} connections`);
    const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    const nodes = data.nodes.map((n) => {
      if (!isObj(n) || !DEFAULTS[n.type]) throw new Error(`Unknown node type "${isObj(n) ? n.type : n}"`);
      const given = isObj(n.params) ? n.params : {};
      const params = {};
      for (const [k, d] of Object.entries(DEFAULTS[n.type]())) {
        const v = given[k];
        if (typeof d === 'string') params[k] = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : d;
        else if (typeof d === 'number') params[k] = Number.isFinite(num(v)) ? num(v) : d;
        else if (Array.isArray(d)) {
          if (v === undefined) params[k] = d;
          else if (Array.isArray(v) && v.length <= LIMITS.items && v.every(isObj)) params[k] = v;
          else throw new Error(`Data in a "${n.type}" node must be a list of objects (at most ${LIMITS.items})`);
        } else params[k] = d;
      }
      return { id: String(n.id), type: n.type, x: Number.isFinite(n.x) ? n.x : 0, y: Number.isFinite(n.y) ? n.y : 0, params };
    });
    const ids = new Map();
    nodes.forEach((n) => {
      if (ids.has(n.id)) throw new Error(`Duplicate node id "${n.id}"`);
      ids.set(n.id, n);
    });
    const seen = new Set();
    const edges = [];
    data.edges.forEach((e) => {
      if (!isObj(e)) throw new Error('Not a valid flow file');
      const from = ids.get(String(e.from)), to = ids.get(String(e.to));
      if (!from || !to) throw new Error('A connection points to a missing node');
      if (NO_INPUT.includes(to.type)) throw new Error(`"${to.type}" nodes cannot have an input connection`);
      if (from.type === 'output') throw new Error('Output nodes cannot have an output connection');
      const key = from.id + '>' + to.id;
      if (!seen.has(key)) { seen.add(key); edges.push({ from: from.id, to: to.id }); }
    });
    return { nodes, edges };
  }

  function parseCsv(text) {
    const table = [];
    let row = [], cur = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c !== '"') cur += c;
        else if (text[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); table.push(row); row = []; cur = '';
      } else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); table.push(row); }
    if (!table.length) return [];
    const [head, ...body] = table;
    return body
      .filter((r) => r.some((x) => x !== ''))
      .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
  }

  // File contents -> items: .csv (header row), .json (list or object), anything else -> one {name, text} item.
  function parseFile(name, text) {
    if (/\.csv$/i.test(name)) return parseCsv(text);
    if (/\.json$/i.test(name)) {
      try { return asItems(JSON.parse(text)); }
      catch (e) { throw new Error(`Invalid JSON in ${name}: ${e.message}`); }
    }
    if (/[\u0000�]/.test(text.slice(0, 4000)))
      throw new Error(`${name} looks like a binary file. Supported: CSV, JSON, plain text and Word (.docx).`);
    return [{ name, text }];
  }

  // Inflates a raw deflate stream but gives up past max bytes, so a tiny zip cannot expand into gigabytes.
  async function inflate(raw, max) {
    const reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const parts = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > max) { reader.cancel(); throw new Error('Document is too large to read'); }
      parts.push(value);
    }
    return new TextDecoder().decode(await new Blob(parts).arrayBuffer());
  }

  // Text of a .docx (a zip): finds word/document.xml in the central directory and inflates it with the
  // browser's built-in DecompressionStream, so no library is needed.
  async function docxText(buffer) {
    const bad = () => new Error('Not a valid .docx file');
    try {
      const bytes = new Uint8Array(buffer), dv = new DataView(buffer);
      let eocd = -1;
      for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
      if (eocd < 0) throw bad();
      let pos = dv.getUint32(eocd + 16, true);
      for (let n = dv.getUint16(eocd + 10, true); n > 0 && pos + 46 <= bytes.length; n--) {
        const nameLen = dv.getUint16(pos + 28, true);
        const skip = nameLen + dv.getUint16(pos + 30, true) + dv.getUint16(pos + 32, true);
        if (new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen)) === 'word/document.xml') {
          const method = dv.getUint16(pos + 10, true), size = dv.getUint32(pos + 20, true), full = dv.getUint32(pos + 24, true), at = dv.getUint32(pos + 42, true);
          if (full > LIMITS.xml) throw new Error('Document is too large to read');
          const start = at + 30 + dv.getUint16(at + 26, true) + dv.getUint16(at + 28, true);
          const raw = bytes.subarray(start, start + size);
          const xml = method === 0 ? new TextDecoder().decode(raw) : await inflate(raw, LIMITS.xml);
          const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
          return (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [])
            .map((para) => [...para.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>|<w:tab\/>/g)]
              .map((m) => (m[1] === undefined ? '\t' : m[1])).join('').replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => entities[e]))
            .filter((line) => line.trim())
            .join('\n');
        }
        pos += 46 + skip;
      }
      throw bad();
    } catch (e) {
      if (e instanceof RangeError || e instanceof TypeError) throw bad();
      throw e;
    }
  }

  // The only file types each upload node accepts. Enforced here, so it also holds when the
  // browser's file picker is switched to "All files".
  const FILE_KINDS = { table: ['.csv', '.json'], document: ['.docx', '.txt', '.md'] };

  async function readFile(kind, f) {
    const ext = (f.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    if (!FILE_KINDS[kind].includes(ext))
      throw new Error(`Unsupported file type "${ext || f.name}". This node accepts: ${FILE_KINDS[kind].join(', ')}`);
    if (f.size > LIMITS.bytes) throw new Error(`File is too large (${(f.size / 1048576).toFixed(1)} MB). The limit is ${LIMITS.bytes / 1048576} MB.`);
    if (ext === '.docx') return [{ name: f.name, text: await docxText(await f.arrayBuffer()) }];
    return parseFile(f.name, await f.text());
  }

  // CSV for spreadsheets. Text starting with = + - @ would be run as a formula by Excel/Sheets, so it gets a
  // leading apostrophe; real numbers are left alone.
  function toCsv(items) {
    const keys = [...new Set(items.flatMap((it) => Object.keys(it)))];
    const cell = (v) => {
      let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [keys.map(cell).join(','), ...items.map((it) => keys.map((k) => cell(it[k])).join(','))].join('\n');
  }

  const api = {
    runFlow, sanitizeFlow, parseFile, docxText, readFile, toCsv, checkOllamaHost, detectOllama,
    FILE_KINDS, LIMITS, NODE_TYPES: Object.keys(DEFAULTS), defaults: (type) => DEFAULTS[type](),
  };
  if (typeof module !== 'undefined') module.exports = api;
  else root.FlowEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
