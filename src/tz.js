// ---------------------------------------------------------------------------
// Display timezone.
//
// Everything is STORED in UTC (SQLite datetime('now')). One timezone decides
// how times are shown and how "is it due yet?" is answered, so a reminder set
// for 09:00 means 09:00 where you live.
//
//   ATLAS_TZ=America/Chicago    (any IANA zone name)
//
// Defaults to the container/host TZ, then UTC. Set it once in .env; it is the
// only place a timezone is named.
// ---------------------------------------------------------------------------

const TZ = (process.env.ATLAS_TZ || process.env.TZ || 'UTC').trim() || 'UTC';

try {
  new Intl.DateTimeFormat('en-US', { timeZone: TZ });
} catch (e) {
  console.error(`FATAL: ATLAS_TZ="${TZ}" is not a valid IANA timezone (e.g. America/Chicago, Europe/Berlin, UTC)`);
  process.exit(1);
}

function parts(date, opts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour12: false, ...opts })
    .formatToParts(date)
    .reduce((o, p) => (o[p.type] = p.value, o), {});
}

// 'YYYY-MM-DDTHH:MM' in the display timezone. Reminder due-checks compare this
// lexically against trigger_date + trigger_time: valid because every field is
// zero-padded and ordered most-significant-first.
function nowKey(date = new Date()) {
  const p = parts(date, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const hour = p.hour === '24' ? '00' : p.hour; // some engines emit '24' at midnight
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}`;
}

// 'YYYY-MM-DD' in the display timezone.
function today(date = new Date()) {
  return nowKey(date).slice(0, 10);
}

// Hour 0-23 in the display timezone (the groom scheduler's window check).
function hour(date = new Date()) {
  const h = parseInt(parts(date, { hour: '2-digit' }).hour, 10);
  return h % 24;
}

// Human-readable stamp for the time footer: 'Thu 2026-08-14 09:12 EDT'.
function format(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
  }).formatToParts(date).reduce((o, x) => (o[x.type] = x.value, o), {});
  return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

module.exports = { TZ, nowKey, today, hour, format };
