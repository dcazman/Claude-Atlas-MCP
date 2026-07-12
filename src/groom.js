#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Atlas Groom Worker — mechanical layer (phase 2 of the groom design).
// Runs offline (cron, 4am). Report-only for user data: findings land in a
// "Groom Report" entity per section; nothing is deleted except audit rotation.
// Judgment layer (Claude API via Batches, dedupe confirmation + prospecting)
// is phase 3 and plugs in behind these findings.
// Run: docker exec atlas node /app/src/groom.js
// ---------------------------------------------------------------------------
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const DB_PATH = process.env.ATLAS_DB_PATH || path.join(__dirname, '..', 'data', 'atlas.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`CREATE TABLE IF NOT EXISTS groom_meta (key TEXT PRIMARY KEY, value TEXT);`);

const SECTIONS = ['work', 'personal', 'shared'];
const REPORT_ENTITY = 'Groom Report';
const AUDIT_KEEP_DAYS = 90;
const DORMANT_DAYS = 60;
const DISMISSED_REMINDER_DAYS = 90;
const DUPE_THRESHOLD = 0.85;

function tokens(s) {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function findDupes(entityId) {
  const obs = db.prepare('SELECT id, content, protected FROM observations WHERE entity_id = ? ORDER BY id').all(entityId);
  const toks = obs.map(o => tokens(o.content));
  const pairs = [];
  for (let i = 0; i < obs.length; i++) {
    for (let j = i + 1; j < obs.length; j++) {
      const sim = jaccard(toks[i], toks[j]);
      if (sim >= DUPE_THRESHOLD) pairs.push({ a: obs[i].id, b: obs[j].id, sim: Math.round(sim * 100) });
    }
  }
  return pairs;
}

function groomSection(section) {
  const findings = [];
  const entities = db.prepare('SELECT id, name, updated_at FROM entities WHERE section = ? AND name != ?').all(section, REPORT_ENTITY);

  // change detection: skip entities untouched since last groom
  const lastRun = db.prepare('SELECT value FROM groom_meta WHERE key = ?').get(`last_groomed:${section}`);
  const lastRunTs = lastRun ? lastRun.value : null;

  let scanned = 0, skipped = 0;
  for (const e of entities) {
    if (lastRunTs && e.updated_at <= lastRunTs) { skipped++; continue; }
    scanned++;
    const dupes = findDupes(e.id);
    for (const d of dupes) {
      findings.push(`NEAR-DUPE in "${e.name}": obs ${d.a} vs obs ${d.b} (${d.sim}% similar) — review and remove one.`);
    }
  }

  // dormant entities (informational; computed cheap so always run)
  const dormant = db.prepare(
    `SELECT name, updated_at FROM entities WHERE section = ? AND name != ? AND updated_at < datetime('now', ?)`
  ).all(section, REPORT_ENTITY, `-${DORMANT_DAYS} days`);
  if (dormant.length) {
    findings.push(`DORMANT (${DORMANT_DAYS}+ days untouched): ${dormant.map(d => d.name).join('; ')}. Candidates for archive/summary-compression.`);
  }

  // long-dismissed reminders
  const oldDismissed = db.prepare(
    `SELECT id, content FROM reminders WHERE section = ? AND dismissed_at IS NOT NULL AND dismissed_at < datetime('now', ?)`
  ).all(section, `-${DISMISSED_REMINDER_DAYS} days`);
  if (oldDismissed.length) {
    findings.push(`STALE DISMISSED REMINDERS (${DISMISSED_REMINDER_DAYS}+ days): ids ${oldDismissed.map(r => r.id).join(', ')} — candidates for remove_reminder.`);
  }

  // write report: replace previous unprotected report observations
  let entity = db.prepare('SELECT id FROM entities WHERE section = ? AND name = ?').get(section, REPORT_ENTITY);
  if (!entity) {
    db.prepare('INSERT INTO entities (section, name, summary) VALUES (?, ?, ?)')
      .run(section, REPORT_ENTITY, 'Nightly groom worker findings. Report-only: approve/act, then items clear on next run.');
    entity = db.prepare('SELECT id FROM entities WHERE section = ? AND name = ?').get(section, REPORT_ENTITY);
  }
  db.prepare('DELETE FROM observations WHERE entity_id = ? AND protected = 0').run(entity.id);

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const header = `Groom run ${stamp} UTC — scanned ${scanned} changed entities, skipped ${skipped} unchanged, ${findings.length} finding(s).`;
  db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(entity.id, header);
  for (const f of findings.slice(0, 40)) {
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(entity.id, f);
  }
  db.prepare("UPDATE entities SET updated_at = datetime('now') WHERE id = ?").run(entity.id);

  db.prepare('INSERT INTO groom_meta (key, value) VALUES (?, datetime(\'now\')) ON CONFLICT(key) DO UPDATE SET value = datetime(\'now\')')
    .run(`last_groomed:${section}`);

  db.prepare('INSERT INTO audit_log (caller, tool, section, allowed, detail) VALUES (?, ?, ?, 1, ?)')
    .run('groom-worker', 'groom', section, `scanned=${scanned} skipped=${skipped} findings=${findings.length}`);

  console.log(`[${section}] ${header}`);
}

// audit rotation — the one destructive op, mechanical by design
const rotated = db.prepare(`DELETE FROM audit_log WHERE created_at < datetime('now', '-${AUDIT_KEEP_DAYS} days')`);
const info = rotated.run();
console.log(`audit rotation: removed ${info.changes} rows older than ${AUDIT_KEEP_DAYS}d`);

for (const s of SECTIONS) groomSection(s);

db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
console.log('groom complete, WAL checkpointed');
