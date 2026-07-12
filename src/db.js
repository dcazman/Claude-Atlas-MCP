const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DB_PATH = process.env.ATLAS_DB_PATH || path.join(__dirname, '..', 'data', 'atlas.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');

// ---------------------------------------------------------------------------
// v2 MIGRATION (idempotent, guarded by PRAGMA user_version)
// v1 schema = user_version 0. v2 = user_version 2.
// Changes: section CHECK gains 'shared' (table rebuild, IDs preserved),
// observations gains protected flag (additive ALTER), audit_log table added.
// Runs BEFORE the CREATE IF NOT EXISTS block so old tables get rebuilt.
// ---------------------------------------------------------------------------
const userVersion = db.prepare('PRAGMA user_version').get().user_version;
const hasEntities = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entities'").get();

if (userVersion < 2 && hasEntities) {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN;');

  db.exec(`
    CREATE TABLE entities_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section TEXT NOT NULL CHECK (section IN ('work','personal','shared')),
      name TEXT NOT NULL,
      summary TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(section, name)
    );
    INSERT INTO entities_new (id, section, name, summary, updated_at)
      SELECT id, section, name, summary, updated_at FROM entities;
    DROP TABLE entities;
    ALTER TABLE entities_new RENAME TO entities;

    CREATE TABLE events_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section TEXT NOT NULL CHECK (section IN ('work','personal','shared')),
      entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO events_new (id, section, entity_id, content, created_at)
      SELECT id, section, entity_id, content, created_at FROM events;
    DROP TABLE events;
    ALTER TABLE events_new RENAME TO events;

    CREATE TABLE reminders_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section TEXT NOT NULL CHECK (section IN ('work','personal','shared')),
      entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
      content TEXT NOT NULL,
      trigger_date TEXT NOT NULL,
      dismissed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO reminders_new (id, section, entity_id, content, trigger_date, dismissed_at, created_at)
      SELECT id, section, entity_id, content, trigger_date, dismissed_at, created_at FROM reminders;
    DROP TABLE reminders;
    ALTER TABLE reminders_new RENAME TO reminders;

    ALTER TABLE observations ADD COLUMN protected INTEGER NOT NULL DEFAULT 0;

    PRAGMA user_version = 2;
  `);

  db.exec('COMMIT;');
  db.exec('PRAGMA foreign_keys = ON;');

  const fkErrors = db.prepare('PRAGMA foreign_key_check').all();
  if (fkErrors.length > 0) {
    console.error('FATAL: foreign_key_check failed after migration:', JSON.stringify(fkErrors));
    process.exit(1);
  }
  console.log('atlas v2 migration complete (user_version 2)');
}

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL CHECK (section IN ('work','personal','shared')),
    name TEXT NOT NULL,
    summary TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(section, name)
  );

  CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    protected INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL CHECK (section IN ('work','personal','shared')),
    entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL CHECK (section IN ('work','personal','shared')),
    entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    trigger_date TEXT NOT NULL,
    dismissed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    caller TEXT NOT NULL,
    tool TEXT NOT NULL,
    section TEXT,
    allowed INTEGER NOT NULL DEFAULT 1,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_entities_section ON entities(section);
  CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id);
  CREATE INDEX IF NOT EXISTS idx_events_section ON events(section);
  CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_id);
  CREATE INDEX IF NOT EXISTS idx_reminders_section ON reminders(section);
  CREATE INDEX IF NOT EXISTS idx_reminders_trigger ON reminders(trigger_date);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
`);

function findEntity(section, name) {
  return db.prepare('SELECT id, name, summary, updated_at FROM entities WHERE section = ? AND name = ?').get(section, name);
}

function touchEntity(id) {
  db.prepare("UPDATE entities SET updated_at = datetime('now') WHERE id = ?").run(id);
}

function ensureEntity(section, name) {
  let entity = findEntity(section, name);
  if (!entity) {
    db.prepare('INSERT INTO entities (section, name) VALUES (?, ?)').run(section, name);
    entity = findEntity(section, name);
  }
  return entity;
}

function sectionEntities(section) {
  const entities = db.prepare(
    'SELECT id, name, summary, updated_at FROM entities WHERE section = ? ORDER BY updated_at DESC'
  ).all(section);

  for (const e of entities) {
    e.section = section;
    e.observations = db.prepare(
      'SELECT id, content, protected, updated_at FROM observations WHERE entity_id = ? ORDER BY updated_at DESC'
    ).all(e.id);
  }

  return entities;
}

function getLandscape(section) {
  // Own section + shared merged: any landscape pull automatically sees shared.
  // Entities and reminders are tagged with their origin section.
  let entities = sectionEntities(section);
  let reminders = getActiveReminders(section).map((r) => ({ ...r, section }));

  if (section !== 'shared') {
    entities = entities.concat(sectionEntities('shared'));
    reminders = reminders.concat(
      getActiveReminders('shared').map((r) => ({ ...r, section: 'shared' }))
    );
  }

  return { reminders, entities };
}

function getEntity(section, name) {
  const entity = findEntity(section, name);
  if (!entity) return null;

  entity.observations = db.prepare(
    'SELECT id, content, protected, updated_at FROM observations WHERE entity_id = ? ORDER BY updated_at DESC'
  ).all(entity.id);

  entity.recent_events = db.prepare(
    'SELECT id, content, created_at FROM events WHERE entity_id = ? ORDER BY created_at DESC LIMIT 10'
  ).all(entity.id);

  return entity;
}

function upsertEntity(section, name, summary) {
  const existing = findEntity(section, name);
  if (existing) {
    if (summary !== undefined && summary !== null) {
      db.prepare("UPDATE entities SET summary = ?, updated_at = datetime('now') WHERE id = ?").run(summary, existing.id);
    } else {
      touchEntity(existing.id);
    }
  } else {
    db.prepare('INSERT INTO entities (section, name, summary) VALUES (?, ?, ?)').run(section, name, summary ?? null);
  }
  return getEntity(section, name);
}

function removeEntity(section, name) {
  const entity = findEntity(section, name);
  if (!entity) return { ok: false, reason: 'not_found' };
  const prot = db.prepare('SELECT COUNT(*) n FROM observations WHERE entity_id = ? AND protected = 1').get(entity.id);
  if (prot.n > 0) return { ok: false, reason: 'protected', count: prot.n };
  db.prepare('DELETE FROM entities WHERE id = ?').run(entity.id);
  return { ok: true };
}

function addObservation(section, entityName, content) {
  const entity = ensureEntity(section, entityName);
  touchEntity(entity.id);
  const info = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(entity.id, content);
  return { observation_id: info.lastInsertRowid, entity: entityName };
}

function getObservation(section, observationId) {
  return db.prepare(
    `SELECT o.id, o.content, o.protected, o.updated_at, o.entity_id, ent.name AS entity
     FROM observations o JOIN entities ent ON ent.id = o.entity_id
     WHERE o.id = ? AND ent.section = ?`
  ).get(observationId, section);
}

function updateObservation(section, observationId, content) {
  const obs = getObservation(section, observationId);
  if (!obs) return { ok: false, reason: 'not_found' };
  db.prepare("UPDATE observations SET content = ?, updated_at = datetime('now') WHERE id = ?").run(content, observationId);
  touchEntity(obs.entity_id);
  return { ok: true, observation_id: observationId, entity: obs.entity, protected: obs.protected };
}

function setObservationProtected(section, observationId, value) {
  const obs = getObservation(section, observationId);
  if (!obs) return { ok: false, reason: 'not_found' };
  db.prepare('UPDATE observations SET protected = ? WHERE id = ?').run(value ? 1 : 0, observationId);
  return { ok: true, observation_id: observationId, entity: obs.entity, protected: value ? 1 : 0 };
}

function removeObservation(section, observationId) {
  const obs = getObservation(section, observationId);
  if (!obs) return { ok: false, reason: 'not_found' };
  if (obs.protected) return { ok: false, reason: 'protected' };
  db.prepare('DELETE FROM observations WHERE id = ?').run(observationId);
  return { ok: true };
}

function logEvent(section, content, entityName) {
  let entityId = null;
  if (entityName) {
    entityId = ensureEntity(section, entityName).id;
  }
  const info = db.prepare('INSERT INTO events (section, entity_id, content) VALUES (?, ?, ?)').run(section, entityId, content);
  return { event_id: info.lastInsertRowid };
}

function createReminder(section, content, triggerDate, entityName) {
  let entityId = null;
  if (entityName) {
    entityId = ensureEntity(section, entityName).id;
  }
  const info = db.prepare(
    'INSERT INTO reminders (section, entity_id, content, trigger_date) VALUES (?, ?, ?, ?)'
  ).run(section, entityId, content, triggerDate);
  return { reminder_id: info.lastInsertRowid, trigger_date: triggerDate };
}

function getActiveReminders(section) {
  return db.prepare(
    `SELECT r.id, r.content, r.trigger_date, r.created_at, ent.name AS entity
     FROM reminders r LEFT JOIN entities ent ON ent.id = r.entity_id
     WHERE r.section = ? AND r.dismissed_at IS NULL AND r.trigger_date <= date('now')
     ORDER BY r.trigger_date ASC`
  ).all(section);
}

function listReminders(section, includeDismissed) {
  if (includeDismissed) {
    return db.prepare(
      `SELECT r.id, r.content, r.trigger_date, r.dismissed_at, r.created_at, ent.name AS entity
       FROM reminders r LEFT JOIN entities ent ON ent.id = r.entity_id
       WHERE r.section = ? ORDER BY r.trigger_date ASC`
    ).all(section);
  }
  return db.prepare(
    `SELECT r.id, r.content, r.trigger_date, r.created_at, ent.name AS entity
     FROM reminders r LEFT JOIN entities ent ON ent.id = r.entity_id
     WHERE r.section = ? AND r.dismissed_at IS NULL ORDER BY r.trigger_date ASC`
  ).all(section);
}

function dismissReminder(section, reminderId) {
  const info = db.prepare(
    "UPDATE reminders SET dismissed_at = datetime('now') WHERE id = ? AND section = ? AND dismissed_at IS NULL"
  ).run(reminderId, section);
  return info.changes > 0;
}

function removeReminder(section, reminderId) {
  const info = db.prepare('DELETE FROM reminders WHERE id = ? AND section = ?').run(reminderId, section);
  return info.changes > 0;
}

function getHistory(section, limit, entityName) {
  const cappedLimit = Math.min(Math.max(limit || 20, 1), 200);

  if (entityName) {
    const entity = findEntity(section, entityName);
    if (!entity) return [];
    return db.prepare(
      'SELECT id, content, created_at FROM events WHERE section = ? AND entity_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(section, entity.id, cappedLimit);
  }

  return db.prepare(
    `SELECT e.id, e.content, e.created_at, ent.name AS entity
     FROM events e LEFT JOIN entities ent ON ent.id = e.entity_id
     WHERE e.section = ? ORDER BY e.created_at DESC LIMIT ?`
  ).all(section, cappedLimit);
}

function search(section, query) {
  const like = `%${query}%`;

  const entities = db.prepare(
    'SELECT id, name, summary FROM entities WHERE section = ? AND (name LIKE ? OR summary LIKE ?)'
  ).all(section, like, like);

  const observations = db.prepare(
    `SELECT o.id, o.content, o.protected, o.updated_at, ent.name AS entity
     FROM observations o JOIN entities ent ON ent.id = o.entity_id
     WHERE ent.section = ? AND o.content LIKE ?`
  ).all(section, like);

  const events = db.prepare(
    `SELECT e.id, e.content, e.created_at, ent.name AS entity
     FROM events e LEFT JOIN entities ent ON ent.id = e.entity_id
     WHERE e.section = ? AND e.content LIKE ? ORDER BY e.created_at DESC LIMIT 50`
  ).all(section, like);

  return { entities, observations, events };
}

function audit(caller, tool, section, allowed, detail) {
  try {
    db.prepare('INSERT INTO audit_log (caller, tool, section, allowed, detail) VALUES (?, ?, ?, ?, ?)')
      .run(caller, tool, section ?? null, allowed ? 1 : 0, detail ?? null);
  } catch (e) {
    console.error('audit write failed:', e.message);
  }
}

// Most recent audit timestamp for a caller (UTC 'YYYY-MM-DD HH:MM:SS'), or null.
// Used by the time footer to report elapsed time since the token's last call.
function lastCallTime(caller) {
  const row = db.prepare('SELECT created_at FROM audit_log WHERE caller = ? ORDER BY id DESC LIMIT 1').get(caller);
  return row ? row.created_at : null;
}

// groom_meta: tiny key/value store used by the groom worker and its scheduler.
db.exec(`CREATE TABLE IF NOT EXISTS groom_meta (key TEXT PRIMARY KEY, value TEXT);`);
function getGroomMeta(key) {
  const row = db.prepare('SELECT value FROM groom_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setGroomMeta(key, value) {
  db.prepare('INSERT INTO groom_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

module.exports = {
  getLandscape,
  getEntity,
  upsertEntity,
  removeEntity,
  addObservation,
  getObservation,
  updateObservation,
  setObservationProtected,
  removeObservation,
  logEvent,
  getHistory,
  search,
  createReminder,
  getActiveReminders,
  listReminders,
  dismissReminder,
  removeReminder,
  audit,
  lastCallTime,
  getGroomMeta,
  setGroomMeta,
};
