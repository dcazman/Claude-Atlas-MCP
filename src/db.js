const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const tz = require('./tz');

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

// ---------------------------------------------------------------------------
// v3 MIGRATION (additive, idempotent, guarded by PRAGMA user_version)
// Adds timed reminders (reminders.trigger_time + reminders.fired_at) and the
// two capture surfaces: the tray (pending_items) and the shelf (research_items).
//
// Additive only - no table is rebuilt and no row moves, so a v2 database
// upgrades in place on the next boot. On a fresh database the ALTERs fail
// harmlessly (no table yet) and the CREATE block below defines the columns
// directly; either path lands on the same schema.
// ---------------------------------------------------------------------------
if (db.prepare('PRAGMA user_version').get().user_version < 3) {
  try { db.exec('ALTER TABLE reminders ADD COLUMN trigger_time TEXT'); } catch (e) { /* fresh DB or already present */ }
  try { db.exec('ALTER TABLE reminders ADD COLUMN fired_at TEXT'); } catch (e) { /* fresh DB or already present */ }
  db.exec('PRAGMA user_version = 3;');
  console.log('atlas v3 migration complete (timed reminders, tray, shelf)');
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

  -- A reminder with a trigger_time is TIMED: something outside Atlas (see
  -- list_due_reminders) is expected to deliver it once, then stamp fired_at so
  -- it never fires twice. Without a trigger_time it is passive - it surfaces in
  -- get_landscape from trigger_date onward and stays until dismissed.
  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL CHECK (section IN ('work','personal','shared')),
    entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    trigger_date TEXT NOT NULL,
    trigger_time TEXT,
    fired_at TEXT,
    dismissed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- THE TRAY: raw captures waiting to be triaged. Anything that arrives while
  -- you are busy lands here instead of interrupting - then it is promoted into
  -- memory, merged into another capture, or dismissed. The source column is free text so
  -- you can name your own inputs: email, meeting, standup, whatever fits.
  CREATE TABLE IF NOT EXISTS pending_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL CHECK (section IN ('work','personal','shared')),
    source TEXT NOT NULL DEFAULT 'manual',
    source_ref TEXT,
    source_date TEXT,
    summary TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','merged','promoted','dismissed')),
    merged_into INTEGER REFERENCES pending_items(id) ON DELETE SET NULL,
    promoted_observation INTEGER REFERENCES observations(id) ON DELETE SET NULL,
    resolution_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  -- THE SHELF: your own ideas and loose threads. Undated and unpressured - an
  -- item sitting here for a year is not a failure. It leaves by graduating to
  -- the tray, or by being killed on purpose.
  CREATE TABLE IF NOT EXISTS research_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL CHECK (section IN ('work','personal','shared')),
    content TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','promoted','dead')),
    promoted_to INTEGER REFERENCES pending_items(id) ON DELETE SET NULL,
    resolution_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  -- resolved_at is stamped by the DB, not by callers: a deterministic fence
  -- beats remembering to set it on every path out of 'pending' / 'open'.
  CREATE TRIGGER IF NOT EXISTS pending_items_resolve
    AFTER UPDATE OF state ON pending_items FOR EACH ROW
    WHEN NEW.state <> 'pending' AND OLD.state = 'pending'
    BEGIN UPDATE pending_items SET resolved_at = datetime('now') WHERE id = NEW.id; END;

  CREATE TRIGGER IF NOT EXISTS research_items_resolve
    AFTER UPDATE OF state ON research_items FOR EACH ROW
    WHEN NEW.state <> 'open' AND OLD.state = 'open'
    BEGIN UPDATE research_items SET resolved_at = datetime('now') WHERE id = NEW.id; END;

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
  CREATE INDEX IF NOT EXISTS idx_pending_section_state ON pending_items(section, state);
  CREATE INDEX IF NOT EXISTS idx_research_section_state ON research_items(section, state);
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
  // Entities, reminders and tray items are tagged with their origin section.
  let entities = sectionEntities(section);
  let reminders = getActiveReminders(section).map((r) => ({ ...r, section }));
  let tray = listPending(section).map((p) => ({ ...p, section }));
  let shelfOpen = listResearch(section).length;

  if (section !== 'shared') {
    entities = entities.concat(sectionEntities('shared'));
    reminders = reminders.concat(
      getActiveReminders('shared').map((r) => ({ ...r, section: 'shared' }))
    );
    tray = tray.concat(listPending('shared').map((p) => ({ ...p, section: 'shared' })));
    shelfOpen += listResearch('shared').length;
  }

  // The tray ships in full: an untriaged capture is waiting on a decision, and
  // something waiting on a decision has to be visible without being asked for.
  //
  // The shelf ships as a COUNT only, on purpose. Listing every idea at the top
  // of every conversation would turn a no-pressure shelf into a nagging
  // backlog, which is the one thing it must not become. The count says "there
  // is something here" and leaves reaching for it to the user.
  return { reminders, tray, shelf: { open: shelfOpen }, entities };
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

// Fetch observations directly by ID - the "obs-number addressing" path. Scope
// comes from the ROW, not from what the caller claims: each observation
// resolves through its entity to its ACTUAL section, which must be one the
// token may reach. Out-of-scope and nonexistent IDs come back identically in
// `missing`, so a token cannot probe whether an ID exists outside its scope.
// (IDs are AUTOINCREMENT and never recycled, so a missing ID was deleted or
// never issued - it is never someone else's row wearing that number.)
function getObservationsByIds(allowedSections, ids) {
  const stmt = db.prepare(
    `SELECT o.id, o.content, o.protected, o.updated_at, ent.name AS entity, ent.section AS section
     FROM observations o JOIN entities ent ON ent.id = o.entity_id
     WHERE o.id = ?`
  );
  const observations = [];
  const missing = [];
  for (const id of ids) {
    const row = stmt.get(id);
    if (row && allowedSections.includes(row.section)) observations.push(row);
    else missing.push(id);
  }
  return { observations, missing };
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

function createReminder(section, content, triggerDate, entityName, triggerTime) {
  let entityId = null;
  if (entityName) {
    entityId = ensureEntity(section, entityName).id;
  }
  // trigger_time is optional and must be HH:MM (24h), read in the display
  // timezone (ATLAS_TZ). Setting it makes the reminder TIMED: it becomes due at
  // that moment and is expected to be delivered once by whatever polls
  // list_due_reminders. Leaving it null keeps the reminder passive.
  let time = null;
  if (triggerTime != null && String(triggerTime).trim() !== '') {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(triggerTime).trim());
    if (!m) throw new Error(`trigger_time must be HH:MM (24h); got "${triggerTime}"`);
    time = `${m[1].padStart(2, '0')}:${m[2]}`;
  }
  const info = db.prepare(
    'INSERT INTO reminders (section, entity_id, content, trigger_date, trigger_time) VALUES (?, ?, ?, ?, ?)'
  ).run(section, entityId, content, triggerDate, time);
  return { reminder_id: info.lastInsertRowid, trigger_date: triggerDate, trigger_time: time };
}

function getActiveReminders(section) {
  return db.prepare(
    `SELECT r.id, r.content, r.trigger_date, r.trigger_time, r.created_at, ent.name AS entity
     FROM reminders r LEFT JOIN entities ent ON ent.id = r.entity_id
     WHERE r.section = ? AND r.dismissed_at IS NULL AND r.trigger_date <= ?
     ORDER BY r.trigger_date ASC`
  ).all(section, tz.today());
}

// Everything currently due and not dismissed, in two flavors:
//   - passive (trigger_time NULL): due once trigger_date arrives, and it STAYS
//     due until dismissed. fired_at does not apply - nothing pushes these.
//   - timed: due once its date+time arrives AND it has not been fired yet.
//     A poller delivers these and calls mark_reminder_fired so they land once.
// Date comparisons happen in JS against the display timezone, because SQLite's
// date('now') is UTC and would fire a 21:00 reminder on the wrong local day.
function getDueReminders(section) {
  const rows = db.prepare(
    `SELECT r.id, r.content, r.trigger_date, r.trigger_time, r.created_at, ent.name AS entity
     FROM reminders r LEFT JOIN entities ent ON ent.id = r.entity_id
     WHERE r.section = ? AND r.dismissed_at IS NULL
       AND (r.trigger_time IS NULL OR r.fired_at IS NULL)
     ORDER BY r.trigger_date ASC, r.trigger_time ASC`
  ).all(section);
  const nowKey = tz.nowKey();
  const todayLocal = nowKey.slice(0, 10);
  return rows.filter((r) => (r.trigger_time == null
    ? r.trigger_date <= todayLocal
    : `${r.trigger_date}T${r.trigger_time}` <= nowKey));
}

// Stamp a timed reminder as delivered so it never fires twice. The
// `fired_at IS NULL` guard makes overlapping poll ticks idempotent - only the
// first UPDATE wins, and a second poller gets `false` instead of a duplicate.
function markReminderFired(section, reminderId) {
  const info = db.prepare(
    "UPDATE reminders SET fired_at = datetime('now') WHERE id = ? AND section = ? AND fired_at IS NULL"
  ).run(reminderId, section);
  return info.changes > 0;
}

function listReminders(section, includeDismissed) {
  if (includeDismissed) {
    return db.prepare(
      `SELECT r.id, r.content, r.trigger_date, r.trigger_time, r.fired_at, r.dismissed_at, r.created_at, ent.name AS entity
       FROM reminders r LEFT JOIN entities ent ON ent.id = r.entity_id
       WHERE r.section = ? ORDER BY r.trigger_date ASC`
    ).all(section);
  }
  return db.prepare(
    `SELECT r.id, r.content, r.trigger_date, r.trigger_time, r.fired_at, r.created_at, ent.name AS entity
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

// ---------------------------------------------------------------------------
// THE TRAY (pending_items) and THE SHELF (research_items).
//
// One funnel, three stages, each with a different amount of commitment:
//
//   shelf  -> an idea of your own. No date, no pressure, may sit forever.
//   tray   -> something that arrived and needs triage. Has a source.
//   memory -> an observation on an entity. This is the part Claude reads back.
//
// Both surfaces are VIEW-vs-STORE: nothing is deleted on resolve, it just stops
// showing up in the default listing. The history stays for later reading.
// ---------------------------------------------------------------------------

function addPendingItem(section, summary, opts = {}) {
  const info = db.prepare(
    `INSERT INTO pending_items (section, summary, source, source_ref, source_date)
     VALUES (?, ?, COALESCE(?, 'manual'), ?, ?)`
  ).run(section, summary, opts.source ?? null, opts.source_ref ?? null, opts.source_date ?? null);
  return { pending_id: info.lastInsertRowid };
}

// Untriaged only, oldest-first: the tray is a queue, not a pile to browse.
function listPending(section) {
  return db.prepare(
    "SELECT * FROM pending_items WHERE section = ? AND state = 'pending' ORDER BY created_at ASC, id ASC"
  ).all(section);
}

function getPending(section, id) {
  return db.prepare('SELECT * FROM pending_items WHERE id = ? AND section = ?').get(id, section);
}

function resolvePending(section, id, newState, opts = {}) {
  const p = getPending(section, id);
  if (!p) return { ok: false, reason: 'not_found' };
  if (p.state !== 'pending') return { ok: false, reason: 'already_resolved', state: p.state };
  db.prepare(
    'UPDATE pending_items SET state = ?, merged_into = ?, promoted_observation = ?, resolution_note = ? WHERE id = ?'
  ).run(newState, opts.merged_into ?? null, opts.promoted_observation ?? null, opts.resolution_note ?? null, id);
  return { ok: true, pending_id: id, state: newState };
}

// Promote a capture into memory: it becomes an observation on an entity, and
// the tray row records which observation it turned into. This is the tray's
// whole purpose - noise in, durable fact out.
function promotePending(section, id, entityName, content) {
  const p = getPending(section, id);
  if (!p) return { ok: false, reason: 'not_found' };
  if (p.state !== 'pending') return { ok: false, reason: 'already_resolved', state: p.state };
  const obs = addObservation(section, entityName, content || p.summary);
  resolvePending(section, id, 'promoted', { promoted_observation: obs.observation_id });
  return {
    ok: true,
    pending_id: id,
    state: 'promoted',
    observation_id: obs.observation_id,
    entity: entityName,
  };
}

// Fold a duplicate capture into the one you are keeping.
function mergePending(section, id, intoId, note) {
  const target = getPending(section, intoId);
  if (!target) return { ok: false, reason: 'merge_target_not_found' };
  if (Number(id) === Number(intoId)) return { ok: false, reason: 'cannot_merge_into_itself' };
  return resolvePending(section, id, 'merged', { merged_into: intoId, resolution_note: note });
}

// Recover a resolved tray item back to pending - triage mistakes are cheap.
function reopenPending(section, id) {
  const p = getPending(section, id);
  if (!p) return { ok: false, reason: 'not_found' };
  db.prepare(
    `UPDATE pending_items
     SET state = 'pending', resolution_note = NULL, resolved_at = NULL,
         merged_into = NULL, promoted_observation = NULL
     WHERE id = ?`
  ).run(id);
  return { ok: true, pending_id: id, state: 'pending' };
}

function addResearchItem(section, content) {
  const info = db.prepare('INSERT INTO research_items (section, content) VALUES (?, ?)').run(section, content);
  return { research_id: info.lastInsertRowid };
}

function listResearch(section) {
  return db.prepare(
    "SELECT * FROM research_items WHERE section = ? AND state = 'open' ORDER BY created_at ASC, id ASC"
  ).all(section);
}

function getResearch(section, id) {
  return db.prepare('SELECT * FROM research_items WHERE id = ? AND section = ?').get(id, section);
}

// An idea graduates by becoming a tray item - it has stopped being a maybe and
// now needs triage like anything else that arrived.
function promoteResearch(section, id, note) {
  const r = getResearch(section, id);
  if (!r) return { ok: false, reason: 'not_found' };
  if (r.state !== 'open') return { ok: false, reason: 'already_resolved', state: r.state };
  const p = addPendingItem(section, r.content, { source: 'shelf', source_ref: `research:${id}` });
  db.prepare("UPDATE research_items SET state = 'promoted', promoted_to = ?, resolution_note = ? WHERE id = ?")
    .run(p.pending_id, note ?? null, id);
  return { ok: true, research_id: id, state: 'promoted', pending_id: p.pending_id };
}

// Killing an idea on purpose is a real outcome, and the reason is worth keeping.
function killResearch(section, id, note) {
  const r = getResearch(section, id);
  if (!r) return { ok: false, reason: 'not_found' };
  if (r.state !== 'open') return { ok: false, reason: 'already_resolved', state: r.state };
  db.prepare("UPDATE research_items SET state = 'dead', resolution_note = ? WHERE id = ?").run(note ?? null, id);
  return { ok: true, research_id: id, state: 'dead' };
}

function reopenResearch(section, id) {
  const r = getResearch(section, id);
  if (!r) return { ok: false, reason: 'not_found' };
  db.prepare(
    "UPDATE research_items SET state = 'open', resolution_note = NULL, resolved_at = NULL, promoted_to = NULL WHERE id = ?"
  ).run(id);
  return { ok: true, research_id: id, state: 'open' };
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
  getObservationsByIds,
  updateObservation,
  setObservationProtected,
  removeObservation,
  logEvent,
  getHistory,
  search,
  createReminder,
  getActiveReminders,
  getDueReminders,
  markReminderFired,
  listReminders,
  dismissReminder,
  removeReminder,
  addPendingItem,
  listPending,
  getPending,
  promotePending,
  mergePending,
  resolvePending,
  reopenPending,
  addResearchItem,
  listResearch,
  getResearch,
  promoteResearch,
  killResearch,
  reopenResearch,
  audit,
  lastCallTime,
  getGroomMeta,
  setGroomMeta,
};
