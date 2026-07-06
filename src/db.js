const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DB_PATH = process.env.ATLAS_DB_PATH || path.join(__dirname, '..', 'data', 'atlas.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL CHECK (section IN ('work','personal')),
    name TEXT NOT NULL,
    summary TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(section, name)
  );

  CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL CHECK (section IN ('work','personal')),
    entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL CHECK (section IN ('work','personal')),
    entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    trigger_date TEXT NOT NULL,
    dismissed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_entities_section ON entities(section);
  CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id);
  CREATE INDEX IF NOT EXISTS idx_events_section ON events(section);
  CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_id);
  CREATE INDEX IF NOT EXISTS idx_reminders_section ON reminders(section);
  CREATE INDEX IF NOT EXISTS idx_reminders_trigger ON reminders(trigger_date);
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

function getLandscape(section) {
  const entities = db.prepare(
    'SELECT id, name, summary, updated_at FROM entities WHERE section = ? ORDER BY updated_at DESC'
  ).all(section);

  for (const e of entities) {
    e.observations = db.prepare(
      'SELECT id, content, updated_at FROM observations WHERE entity_id = ? ORDER BY updated_at DESC'
    ).all(e.id);
  }

  return { reminders: getActiveReminders(section), entities };
}

function getEntity(section, name) {
  const entity = findEntity(section, name);
  if (!entity) return null;

  entity.observations = db.prepare(
    'SELECT id, content, updated_at FROM observations WHERE entity_id = ? ORDER BY updated_at DESC'
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
  const info = db.prepare('DELETE FROM entities WHERE section = ? AND name = ?').run(section, name);
  return info.changes > 0;
}

function addObservation(section, entityName, content) {
  const entity = ensureEntity(section, entityName);
  touchEntity(entity.id);
  const info = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(entity.id, content);
  return { observation_id: info.lastInsertRowid, entity: entityName };
}

function removeObservation(section, observationId) {
  const info = db.prepare(
    'DELETE FROM observations WHERE id = ? AND entity_id IN (SELECT id FROM entities WHERE section = ?)'
  ).run(observationId, section);
  return info.changes > 0;
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
    `SELECT o.id, o.content, o.updated_at, ent.name AS entity
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

module.exports = {
  getLandscape,
  getEntity,
  upsertEntity,
  removeEntity,
  addObservation,
  removeObservation,
  logEvent,
  getHistory,
  search,
  createReminder,
  getActiveReminders,
  listReminders,
  dismissReminder,
  removeReminder,
};
