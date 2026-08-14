// End-to-end tests over HTTP, against a real server process.
//
// The scope matrix is the security property this project actually promises:
// a token can never reach a section outside its scope, no matter what the
// client asks for. It is tested here rather than in the storage layer because
// that promise is only true if the SERVER enforces it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 7900 + (process.pid % 90);
const WORK_TOKEN = 'a'.repeat(32);
const PERSONAL_TOKEN = 'b'.repeat(32);
const BASE = `http://127.0.0.1:${PORT}/atlas-mcp`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-srv-'));
let server;

test.before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      ATLAS_DB_PATH: path.join(tmp, 'atlas.db'),
      ATLAS_TZ: 'UTC',
      ATLAS_TOKEN: `worker:${WORK_TOKEN}:work,homie:${PERSONAL_TOKEN}:personal`,
    },
    stdio: 'ignore',
  });
  // Wait for /health rather than sleeping a fixed amount.
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become healthy');
});

test.after(() => {
  if (server) server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// The MCP transport answers in SSE framing; pull the JSON payload back out.
async function rpc(token, method, params) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-atlas-token': token,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  if (!res.ok) return { httpStatus: res.status };
  const body = await res.text();
  const line = body.split('\n').find((l) => l.startsWith('data: '));
  return { httpStatus: res.status, ...JSON.parse(line.slice(6)) };
}

const call = (token, name, args) => rpc(token, 'tools/call', { name, arguments: args });
const textOf = (r) => (r.result?.content || []).map((c) => c.text).join('\n');
// The payload is the first content block; the last one is the time footer.
const jsonOf = (r) => JSON.parse(r.result.content[0].text);

test('an unknown token is rejected before any tool runs', async () => {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-token': 'nope' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.strictEqual(res.status, 401);
});

test('every tool is advertised', async () => {
  const res = await rpc(WORK_TOKEN, 'tools/list');
  const names = res.result.tools.map((t) => t.name);
  for (const expected of ['get_landscape', 'get_observation', 'list_due_reminders',
    'mark_reminder_fired', 'pending_add', 'pending_promote', 'research_add', 'research_kill']) {
    assert.ok(names.includes(expected), `tools/list is missing ${expected}`);
  }
});

test('scope matrix: a token reaches its own section and shared, nothing else', async () => {
  for (const [label, token, reachable, refused] of [
    ['work token', WORK_TOKEN, ['work', 'shared'], 'personal'],
    ['personal token', PERSONAL_TOKEN, ['personal', 'shared'], 'work'],
  ]) {
    for (const section of reachable) {
      const ok = await call(token, 'get_landscape', { section });
      assert.ok(!ok.result.isError, `${label} should reach ${section}`);
    }
    const denied = await call(token, 'get_landscape', { section: refused });
    assert.ok(denied.result.isError, `${label} must not reach ${refused}`);
    assert.match(textOf(denied), /^403:/, 'refusal should say 403');
  }
});

test('a write to an out-of-scope section is refused, not silently dropped', async () => {
  const denied = await call(WORK_TOKEN, 'add_observation', {
    section: 'personal', entity: 'Sneaky', content: 'should never land',
  });
  assert.ok(denied.result.isError);

  // Prove nothing was written, using the token that CAN see that section.
  const landscape = await call(PERSONAL_TOKEN, 'get_landscape', { section: 'personal' });
  assert.ok(!textOf(landscape).includes('Sneaky'));
});

test('get_observation cannot be used to read across scopes', async () => {
  const created = await call(PERSONAL_TOKEN, 'add_observation', {
    section: 'personal', entity: 'Private Thing', content: 'personal only',
  });
  const id = jsonOf(created).observation_id;

  const asWork = jsonOf(await call(WORK_TOKEN, 'get_observation', { ids: [id] }));
  assert.strictEqual(asWork.observations.length, 0);
  assert.deepStrictEqual(asWork.missing, [id], 'out-of-scope must look exactly like nonexistent');

  const asOwner = jsonOf(await call(PERSONAL_TOKEN, 'get_observation', { ids: [id] }));
  assert.strictEqual(asOwner.observations.length, 1);
});

test('every response carries the time footer', async () => {
  const res = await call(WORK_TOKEN, 'get_landscape', { section: 'work' });
  assert.match(textOf(res), /\[server_time: .+\]/);
});

test('denied calls are audited, not just refused', async () => {
  await call(WORK_TOKEN, 'get_landscape', { section: 'personal' });
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(path.join(tmp, 'atlas.db'), { readOnly: true });
  const denials = raw.prepare(
    "SELECT COUNT(*) n FROM audit_log WHERE allowed = 0 AND caller = 'worker'"
  ).get().n;
  assert.ok(denials > 0, 'a refused call must leave an audit row');
});
