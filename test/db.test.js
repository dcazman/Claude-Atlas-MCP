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
  assert.strictEqual(version, 3, 'fresh database should land on the current user_version');

  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const expected of ['entities', 'observations', 'events', 'reminders', 'audit_log',
    'groom_meta', 'pending_items', 'research_items']) {
    assert.ok(tables.includes(expected), `missing table ${expected}`);
  }
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
  const landscape = db.getLandscape('work');
  const sections = new Set(landscape.entities.map((e) => e.section));
  assert.ok(sections.has('work') && sections.has('shared'));
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
