// The groom runs unattended every night, and it is the one component allowed to
// delete anything (its own audit log). These tests pin the two properties that
// matter: it survives being the first thing ever run against a new database,
// and it never touches your data.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const GROOM = path.join(__dirname, '..', 'src', 'groom.js');

function runGroom(dbPath) {
  return execFileSync(process.execPath, [GROOM], {
    env: { ...process.env, ATLAS_DB_PATH: dbPath, ATLAS_TZ: 'UTC' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('the groom can be the first thing ever run against a new database', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-groom-'));
  try {
    const dbPath = path.join(tmp, 'atlas.db');
    const out = runGroom(dbPath); // must not throw
    assert.match(out, /groom complete/);

    const raw = new DatabaseSync(dbPath, { readOnly: true });
    assert.strictEqual(raw.prepare('PRAGMA user_version').get().user_version, 3);
    const reports = raw.prepare("SELECT COUNT(*) n FROM entities WHERE name = 'Groom Report'").get().n;
    assert.strictEqual(reports, 3, 'one report entity per section');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the groom reports on your data without deleting any of it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-groom-'));
  try {
    const dbPath = path.join(tmp, 'atlas.db');
    runGroom(dbPath); // build the schema

    const raw = new DatabaseSync(dbPath);
    raw.prepare("INSERT INTO entities (section, name) VALUES ('work', 'Kept')").run();
    const entityId = raw.prepare("SELECT id FROM entities WHERE name = 'Kept'").get().id;
    // Two observations similar enough to trip the near-duplicate check.
    raw.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)')
      .run(entityId, 'The backup window moved to two in the morning on weekdays.');
    raw.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)')
      .run(entityId, 'The backup window moved to two in the morning on weekdays!');
    raw.close();

    runGroom(dbPath);

    const after = new DatabaseSync(dbPath, { readOnly: true });
    const kept = after.prepare('SELECT COUNT(*) n FROM observations WHERE entity_id = ?').get(entityId).n;
    assert.strictEqual(kept, 2, 'the groom flags duplicates, it never removes them');

    const report = after.prepare(
      `SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id
       WHERE e.section = 'work' AND e.name = 'Groom Report'`
    ).all().map((r) => r.content).join('\n');
    assert.match(report, /NEAR-DUPE/, 'the duplicate should be reported');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
