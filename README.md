# Flow Playground

A small workflow-automation engine that runs entirely in the browser. Pick a template or build your
own flow: upload a file, call an API, run a local AI model, transform and filter the data, then
download the result. No backend, no dependencies, no build step. Files and data never leave the page.

I built it to show how I think about workflow engines after two years writing components for a
workflow-automation platform. It is an independent project written from scratch; it does not use
any code from that platform.

## How it works

- A flow is a graph: `{ nodes: [{ id, type, params }], edges: [{ from, to }] }`.
- The engine (`engine.js`) sorts the graph (Kahn's algorithm), rejects cycles before running, and runs
  each node with the items of all its inputs.
- If a node fails it is marked as an error and everything after it is **skipped**; branches that do
  not depend on it still run.
- Nodes that call a service (HTTP, Ollama) run once per input item, or once if they have no input.

## Nodes

| Node | Does |
|---|---|
| Sample data | Emits a list of JSON items (editable) |
| Upload table | A CSV (header row) or JSON list, read in the browser; each row becomes an item |
| Upload document | A Word (.docx), `.txt` or `.md` file, read in the browser; it becomes one item with `name` and `text` |
| HTTP request | GET/POST to an http(s) URL; `{{field}}` is filled per item; arrays become items |
| Ollama (local AI) | Sends a prompt to a local [Ollama](https://ollama.com) model and saves the answer in a field. The answer streams into the Output panel as it is written; **Stop** cancels the call |
| Transform (JS) | A JavaScript expression per item: object = new item, `null` = drop it, other = `{value}` |
| Filter | Keeps items where `field <op> value` (`>`, `<`, `>=`, `<=`, `==`, `!=`, `contains`) |
| Set field | Writes a field; `{{name}}` is replaced with the item's value |
| Validate | Fails if a required field is missing or empty |
| Delay | Waits N milliseconds (0 to 60000) |
| Output | Collects the final items, shown as readable cards (long AI answers keep their line breaks and **bold**) or as raw JSON; download them as JSON or CSV |

Flows can be exported and imported as JSON.

## What each node refuses

A node never "accepts anything and fails in a confusing way": it states what it takes, enforces it, and
says why when something is refused. The browser flags bad input as you type (red border), and the engine
checks everything again on Run, so imported flows and hand-edited data get the same treatment.

- **Uploads:** each upload node has a closed list of file types (`.csv/.json` or `.docx/.txt/.md`), enforced
  even if the file picker is switched to "All files". Files over 5 MB are refused, a `.docx` that unzips to
  more than 20 MB is refused (zip bomb), and binary files are never read as text.
- **Data:** every node receives a list of plain objects, at most 5000 items. Sample data that is not valid
  JSON or not a list of objects is an error, not silently stale data.
- **HTTP:** only GET and POST, only `http(s)` URLs, `{{fields}}` are URL-encoded in the URL and JSON-escaped in
  the body (a value cannot add fields to the body), responses over 5 MB are refused, and at most 50 requests
  per node.
- **Ollama:** the host must be this machine (`localhost`, `127.0.0.1`, `[::1]`), so prompts and documents never
  go to a remote server. Model names are validated, prompts over 24,000 characters are refused instead of being
  silently cut by the model's context window, and at most 50 calls per node.
- **Filter / Set / Validate:** a field name is required (`__proto__`, `constructor` and `prototype` are not
  allowed), numeric operators need a number, and a missing field never matches `==`.
- **Delay:** 0 to 60000 ms, and it ends immediately when the run is stopped.
- **Transform (JS):** runs in a Web Worker, so it cannot touch the page, it is killed after 3 seconds (an
  infinite loop cannot freeze the tab), and `fetch`, `XMLHttpRequest`, `WebSocket` and similar are removed
  inside the worker. That last part is best effort, not a security boundary.
- **Importing a flow:** the file (max 1 MB) is validated against the node schema: unknown node types, unknown
  parameters, wrong types, connections to missing nodes or into nodes that take no input are refused. A flow
  must then be reviewed and trusted by the person (a banner and a button) before it can run, because it can
  contain URLs and JavaScript.
- **Exporting a flow:** the contents of uploaded files are left out, so a shared flow does not carry documents.
- **CSV download:** text starting with `=`, `+`, `-` or `@` gets a leading apostrophe so a spreadsheet does not
  run it as a formula.
- **Flow size:** at most 30 nodes.

## Things to know

- **HTTP** only works with APIs that allow browser requests (CORS). Failures say so.
- **Ollama** is optional: it needs Ollama running on the visitor's machine, and Ollama only accepts pages
  it is told about (`OLLAMA_ORIGINS`, a setting of the Ollama program that a web page cannot change). So the
  page checks for it only when someone picks an AI template or adds the Ollama node (never on page load, to
  avoid a "local network access" prompt for no reason). If it is not there, the template or node is still
  put on the canvas and step-by-step instructions appear next to it, for Windows, macOS
  and Linux (the person's own system is shown first, the others are one click away); when it is there, new Ollama nodes start with the
  smallest installed local model, so the first run works without editing anything. The default template
  does not need Ollama.

- **Templates and Reset:** choosing a template always puts it on the canvas. **Reset** reloads the chosen one
  and discards your edits (choosing the same option again fires no browser event, so it needs its own
  button). While a flow runs, everything that changes the canvas is switched off, so results can never be
  painted on a different flow, and the run uses a snapshot of the values it started with.
- **Phones and tablets:** below 860 px wide the canvas becomes a single vertical list in flow order, with
  connections running top to bottom (no dragging needed; tap a dot, then another dot). Run and Stop sit in a
  bar fixed at the bottom of the screen, controls are bigger on touch screens, and the page itself never
  scrolls sideways (checked from 280 px up). Ollama cannot run on a phone, so the AI nodes say so there
  instead of showing install steps.

## Run

Open `index.html` in a browser, or serve the folder (`python -m http.server`).

## Test

```bash
node --test
```

79 tests, split by concern: `engine.test.js` (the core: items, filter, templates, validation, cycles),
`nodes.test.js` (every node, streaming, stopping), `files.test.js` (uploads and the `.docx` reader, a small
zip parser on the browser's built-in `DecompressionStream`), `hardening.test.js` (every refusal listed
above) and `detect.test.js` (Ollama detection: models, timeout, never throws). Network calls are injected, so the tests need no internet. Needs Node 18+.

## License

[MIT](LICENSE). Use it, change it, learn from it.

## Limits

Single output per node (no true/false branches), no triggers or scheduling, no saving flows between
visits except by export. Natural next steps: an IF node with two outputs, request headers for HTTP,
and running a flow from a URL.
