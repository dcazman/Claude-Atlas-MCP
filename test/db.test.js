// Unit tests for the storage layer. Each run starts from an EMPTY database, so
// this doubles as the blank-slate migration test: if the schema cannot build
// itself from nothing, every test here fails immediately.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-test-'));
process.env.ATLAS_DB_PATH = path.join(tmp, 'atlas.db');
process.env.ATLAS_TZ = 'UTC';

const db = require('../src/db');
const { DatabaseSync } = require('node:sqlite');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('blank slate: an empty database migrates to the current schema', () => {
  const raw = new DatabaseSync(process.env.ATLAS_DB_PATH, { readOnly: true });
  const version = raw.prepare('PRAGMA user_version').get().user_version;
  assert.strictEqual(version, 5, 'fresh database should land on the current user_version');

  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const expected of ['entities', 'observations', 'events', 'reminders', 'audit_log',
    'groom_meta', 'pending_items', 'research_items', 'entity_aliases']) {
    assert.ok(tables.includes(expected), `missing table ${expected}`);
  }

  const cols = raw.prepare("PRAGMA table_info(entities)").all().map((c) => c.name);
  assert.ok(cols.includes('core'), 'entities should have a core column');
});

test('observations: add, update in place, protect, delete', () => {
  const { observation_id } = db.addObservation('work', 'Home Network', 'Router is a UDM Pro.');
  assert.ok(observation_id > 0);

  db.updateObservation('work', observation_id, 'Router is a UDM Pro, firmware 4.0.');
  assert.match(db.getObservation('work', observation_id).content, /firmware 4\.0/);

  db.setObservationProtected('work', observation_id, true);
  assert.deepStrictEqual(db.removeObservation('work', observation_id), { ok: false, reason: 'protected' });

  // Protection blocks deletion but never blocks correction.
  assert.strictEqual(db.updateObservation('work', observation_id, 'Router replaced.').ok, true);

  db.setObservationProtected('work', observation_id, false);
  assert.strictEqual(db.removeObservation('work', observation_id).ok, true);
});

test('an entity holding a protected observation cannot be removed', () => {
  const { observation_id } = db.addObservation('work', 'Standing Rules', 'Never deploy on Friday.');
  db.setObservationProtected('work', observation_id, true);
  assert.strictEqual(db.removeEntity('work', 'Standing Rules').ok, false);
});

test('obs-number addressing resolves scope from the row, not the caller', () => {
  const mine = db.addObservation('work', 'Project A', 'A work fact.').observation_id;
  const theirs = db.addObservation('personal', 'Project B', 'A personal fact.').observation_id;
  const shared = db.addObservation('shared', 'House Rules', 'A shared fact.').observation_id;

  const asWork = db.getObservationsByIds(['work', 'shared'], [mine, theirs, shared, 999999]);
  assert.deepStrictEqual(asWork.observations.map((o) => o.id).sort((a, b) => a - b), [mine, shared].sort((a, b) => a - b));

  // The out-of-scope id and the nonexistent id are indistinguishable in the
  // response - that is the property that stops a token probing other sections.
  assert.deepStrictEqual(asWork.missing.sort((a, b) => a - b), [theirs, 999999].sort((a, b) => a - b));
});

test('shared is merged into every landscape pull, tagged with its origin', () => {
  db.addObservation('shared', 'House Rules', 'Shared context lives here.');
  // get_landscape defaults to core=1 entities only (see v4 migration) - use
  // all:true here since this test is about the shared-merge behavior, not core.
  const landscape = db.getLandscape('work', { all: true });
  const sections = new Set(landscape.entities.map((e) => e.section));
  assert.ok(sections.has('work') && sections.has('shared'));
});

test('core memory tier: get_landscape defaults to core=1 entities, all:true dumps everything', () => {
  db.upsertEntity('work', 'Core Tier A', 'in the working set');
  db.upsertEntity('work', 'Core Tier B', 'archived, not active');
  db.setEntityCore('work', 'Core Tier A', true);

  const bounded = db.getLandscape('work');
  const boundedNames = bounded.entities.map((e) => e.name);
  assert.ok(boundedNames.includes('Core Tier A'), 'core entity should appear in the default view');
  assert.ok(!boundedNames.includes('Core Tier B'), 'non-core entity should not appear in the default view');
  assert.strictEqual(bounded.view, 'core');

  const all = db.getLandscape('work', { all: true });
  const allNames = all.entities.map((e) => e.name);
  assert.ok(allNames.includes('Core Tier A') && allNames.includes('Core Tier B'), 'all:true returns every entity');
  assert.strictEqual(all.view, 'all');
});

test('promote_entity / evict_entity move an entity in and out of the core view without deleting it', () => {
  db.upsertEntity('work', 'Toggle Me', 'a topic');
  assert.strictEqual(db.getEntity('work', 'Toggle Me').core, 0, 'new entities start out of core');

  const promoted = db.setEntityCore('work', 'Toggle Me', true);
  assert.deepStrictEqual(promoted, { ok: true, name: 'Toggle Me', core: 1 });
  assert.ok(db.getLandscape('work').entities.some((e) => e.name === 'Toggle Me'));

  const evicted = db.setEntityCore('work', 'Toggle Me', false);
  assert.deepStrictEqual(evicted, { ok: true, name: 'Toggle Me', core: 0 });
  assert.ok(!db.getLandscape('work').entities.some((e) => e.name === 'Toggle Me'), 'evicted entity leaves the default view');
  assert.ok(db.getEntity('work', 'Toggle Me'), 'but it is still fully intact via get_entity');

  assert.deepStrictEqual(db.setEntityCore('work', 'No Such Entity', true), { ok: false, reason: 'not_found' });
});

test('list_entities enumerates everything regardless of core status, with observation counts', () => {
  db.upsertEntity('personal', 'Listed Core', 'x');
  db.setEntityCore('personal', 'Listed Core', true);
  db.upsertEntity('personal', 'Listed Archived', 'y');
  db.addObservation('personal', 'Listed Archived', 'one fact');
  db.addObservation('personal', 'Listed Archived', 'two facts');

  const rows = db.listEntities('personal');
  const core = rows.find((r) => r.name === 'Listed Core');
  const archived = rows.find((r) => r.name === 'Listed Archived');
  assert.strictEqual(core.core, 1);
  assert.strictEqual(archived.core, 0);
  assert.strictEqual(archived.observation_count, 2);
  assert.ok(!('observations' in archived), 'list_entities never carries observation bodies');
});

test('merge_entity moves observations, keeps protected ones intact, and records a permanent alias', () => {
  const keep = db.addObservation('work', 'Merge Survivor', 'already here').observation_id;
  const dupeObs = db.addObservation('work', 'Merge Dupe', 'a fact worth keeping').observation_id;
  db.setObservationProtected('work', dupeObs, true);
  db.addObservation('work', 'Merge Dupe', 'an unprotected fact');

  assert.deepStrictEqual(db.mergeEntity('work', 'Merge Dupe', 'Merge Dupe'), { ok: false, reason: 'same_entity' });
  assert.deepStrictEqual(db.mergeEntity('work', 'Nope', 'Merge Survivor'), { ok: false, reason: 'from_not_found' });
  assert.deepStrictEqual(db.mergeEntity('work', 'Merge Dupe', 'Nope'), { ok: false, reason: 'into_not_found' });

  const r = db.mergeEntity('work', 'Merge Dupe', 'Merge Survivor');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.moved, 2);
  assert.strictEqual(db.getEntity('work', 'Merge Dupe'), null, 'the merged-away entity is gone');

  const survivor = db.getEntity('work', 'Merge Survivor');
  assert.ok(survivor.observations.some((o) => o.id === dupeObs && o.protected === 1), 'protected obs kept its id and flag');
  assert.ok(survivor.observations.some((o) => /MERGED IN from "Merge Dupe"/.test(o.content)), 'unprotected obs copied with provenance');

  // recreating the dead name redirects silently from now on
  assert.strictEqual(db.resolveAlias('work', 'Merge Dupe'), 'Merge Survivor');
  const redirected = db.upsertEntity('work', 'Merge Dupe');
  assert.strictEqual(redirected.name, 'Merge Survivor');
  assert.match(redirected.redirected, /known alias/);
});

test('upsert_entity and add_observation redirect a merged-away name through its alias', () => {
  db.addObservation('personal', 'Alias Survivor', 'kept');
  db.addObservation('personal', 'Alias Dead', 'to be merged');
  db.mergeEntity('personal', 'Alias Dead', 'Alias Survivor');

  const viaAdd = db.addObservation('personal', 'Alias Dead', 'a brand new fact');
  assert.strictEqual(viaAdd.entity, 'Alias Survivor');
  assert.match(viaAdd.redirected, /Alias Dead.*Alias Survivor/);
  assert.ok(db.getEntity('personal', 'Alias Survivor').observations.some((o) => o.content === 'a brand new fact'));
});

test('a brand-new but merely-similar entity name still creates, flagged for a human to check', () => {
  db.upsertEntity('work', 'Home Network Router', 'the router');
  const similar = db.upsertEntity('work', 'Home Network Router Config');
  assert.ok(similar.similar_entities && similar.similar_entities.length > 0, 'a close name should surface a similarity hint');
  assert.strictEqual(similar.similar_entities[0].name, 'Home Network Router');
  // creation always succeeds regardless - never blocked, only flagged
  assert.ok(db.getEntity('work', 'Home Network Router Config'));

  const unrelated = db.upsertEntity('work', 'Completely Unrelated Topic Xyz');
  assert.ok(!unrelated.similar_entities, 'an unrelated name gets no similarity hint');
});

test('the landscape surfaces the tray, and counts the shelf without listing it', () => {
  // Nothing waiting: both surfaces report empty rather than being absent, so a
  // client can rely on the shape.
  const empty = db.getLandscape('personal');
  assert.deepStrictEqual(empty.tray, []);
  assert.deepStrictEqual(empty.shelf, { open: 0 });

  db.addPendingItem('personal', 'Landlord called about the boiler', { source: 'phone' });
  db.addResearchItem('personal', 'Learn to sail?');
  db.addResearchItem('personal', 'Move the server rack downstairs?');

  const landscape = db.getLandscape('personal');
  assert.strictEqual(landscape.tray.length, 1, 'an untriaged capture must surface unasked');
  assert.match(landscape.tray[0].summary, /boiler/);
  assert.strictEqual(landscape.tray[0].section, 'personal', 'tray items carry their origin section');

  // The shelf is a count, never a list - a no-pressure shelf that recites
  // itself every conversation has become a nagging backlog.
  assert.deepStrictEqual(landscape.shelf, { open: 2 });
  assert.ok(!JSON.stringify(landscape.shelf).includes('sail'));

  // Triaged items leave the landscape the same way they leave the tray.
  db.resolvePending('personal', landscape.tray[0].id, 'dismissed', { resolution_note: 'handled on the call' });
  assert.deepStrictEqual(db.getLandscape('personal').tray, []);
});

test('shared tray items surface in a work or personal landscape too', () => {
  db.addPendingItem('shared', 'Renew the family domain');
  const fromWork = db.getLandscape('work');
  assert.ok(fromWork.tray.some((t) => t.section === 'shared' && /domain/.test(t.summary)));

  // ...but a shared-scoped pull sees only shared, never the other sections.
  const fromShared = db.getLandscape('shared');
  assert.ok(fromShared.tray.every((t) => t.section === 'shared'));
});

test('timed reminders: due only after their time, and fire exactly once', () => {
  const past = db.createReminder('work', 'Stand up', '2020-01-01', null, '09:00');
  const future = db.createReminder('work', 'Renew cert', '2999-01-01', null, '09:00');
  const passive = db.createReminder('work', 'Watch this', '2020-01-01');

  assert.strictEqual(past.trigger_time, '09:00');
  assert.strictEqual(passive.trigger_time, null);

  const dueIds = db.getDueReminders('work').map((r) => r.id);
  assert.ok(dueIds.includes(past.reminder_id), 'past timed reminder should be due');
  assert.ok(dueIds.includes(passive.reminder_id), 'passive reminder should be due');
  assert.ok(!dueIds.includes(future.reminder_id), 'future reminder should not be due');

  // First delivery wins; a second poller gets false instead of a duplicate.
  assert.strictEqual(db.markReminderFired('work', past.reminder_id), true);
  assert.strictEqual(db.markReminderFired('work', past.reminder_id), false);
  assert.ok(!db.getDueReminders('work').map((r) => r.id).includes(past.reminder_id));

  // A passive reminder has no firing step - it stays due until dismissed.
  assert.ok(db.getDueReminders('work').map((r) => r.id).includes(passive.reminder_id));
  db.dismissReminder('work', passive.reminder_id);
  assert.ok(!db.getDueReminders('work').map((r) => r.id).includes(passive.reminder_id));
});

test('createReminder rejects a malformed trigger_time', () => {
  assert.throws(() => db.createReminder('work', 'Bad', '2030-01-01', null, '25:00'), /HH:MM/);
});

test('tray: capture, promote into memory, and reopen', () => {
  const { pending_id } = db.addPendingItem('work', 'Ops asked about the backup window', { source: 'email' });
  assert.strictEqual(db.listPending('work').length, 1);

  const promoted = db.promotePending('work', pending_id, 'Backups', 'Backup window moves to 02:00 UTC.');
  assert.strictEqual(promoted.ok, true);
  assert.ok(promoted.observation_id > 0);
  assert.strictEqual(db.listPending('work').length, 0, 'promoted items leave the tray');

  // The capture is not deleted - it records what it became.
  const row = db.getPending('work', pending_id);
  assert.strictEqual(row.state, 'promoted');
  assert.strictEqual(row.promoted_observation, promoted.observation_id);
  assert.ok(row.resolved_at, 'resolved_at is stamped by the DB trigger, not the caller');

  // And the fact really landed in memory.
  const entity = db.getEntity('work', 'Backups');
  assert.match(entity.observations[0].content, /02:00 UTC/);

  db.reopenPending('work', pending_id);
  assert.strictEqual(db.listPending('work').length, 1);
  assert.strictEqual(db.getPending('work', pending_id).promoted_observation, null);
});

test('tray: an item can only be resolved once', () => {
  const { pending_id } = db.addPendingItem('work', 'Duplicate capture');
  db.resolvePending('work', pending_id, 'dismissed', { resolution_note: 'nothing to do' });
  const second = db.promotePending('work', pending_id, 'Anywhere');
  assert.deepStrictEqual(second, { ok: false, reason: 'already_resolved', state: 'dismissed' });
});

test('tray: merging folds a duplicate into the survivor', () => {
  const keep = db.addPendingItem('work', 'Rebuild the NAS').pending_id;
  const dupe = db.addPendingItem('work', 'NAS rebuild (again)').pending_id;

  assert.strictEqual(db.mergePending('work', dupe, dupe).ok, false, 'cannot merge into itself');
  assert.strictEqual(db.mergePending('work', dupe, 999999).ok, false, 'merge target must exist');

  assert.strictEqual(db.mergePending('work', dupe, keep, 'same thing').ok, true);
  assert.strictEqual(db.getPending('work', dupe).merged_into, keep);
});

test('shelf: ideas graduate to the tray or get killed with a reason', () => {
  const before = db.listResearch('personal').length;
  const idea = db.addResearchItem('personal', 'Self-hosted photo backup?').research_id;
  assert.strictEqual(db.listResearch('personal').length, before + 1);

  const promoted = db.promoteResearch('personal', idea, 'finally have the disks');
  assert.strictEqual(promoted.ok, true);
  assert.ok(promoted.pending_id > 0, 'graduating creates a tray item');
  assert.strictEqual(db.listResearch('personal').length, before, 'a graduated idea leaves the shelf');
  assert.strictEqual(db.getResearch('personal', idea).promoted_to, promoted.pending_id);

  const dead = db.addResearchItem('personal', 'Rewrite everything in Rust').research_id;
  db.killResearch('personal', dead, 'no reason beyond boredom');
  assert.strictEqual(db.getResearch('personal', dead).state, 'dead');
  assert.match(db.getResearch('personal', dead).resolution_note, /boredom/);

  db.reopenResearch('personal', dead);
  assert.strictEqual(db.getResearch('personal', dead).state, 'open');
});

test('search finds facts across entities, observations, and history', () => {
  db.addObservation('work', 'Findable', 'A distinctive marmalade fact.');
  db.logEvent('work', 'Discussed marmalade at length.', 'Findable');
  const hits = db.search('work', 'marmalade');
  assert.strictEqual(hits.observations.length, 1);
  assert.strictEqual(hits.events.length, 1);
});
