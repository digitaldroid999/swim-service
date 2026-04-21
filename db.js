// Crew Assist SWIM Service — SQLite Database
// Stores:
//   - flight_events: latest known status for each flight (keyed by flight+date)
//   - flight_watches: which users want push notifications for which flights

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const config   = require('./config');

// Ensure data directory exists
const dbDir = path.dirname(config.db.path);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(config.db.path);

// Performance pragmas
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS flight_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    flight          TEXT NOT NULL,        -- e.g. "UA440"
    date            TEXT NOT NULL,        -- "YYYY-MM-DD" local departure date
    dep_airport     TEXT,                 -- IATA e.g. "EWR"
    arr_airport     TEXT,                 -- IATA e.g. "LAX"
    status          TEXT,                 -- "Scheduled","Departed","Arrived","Cancelled","Diverted"
    scheduled_dep   TEXT,                 -- filed/scheduled departure time (ISO UTC, from flightCreate)
    scheduled_arr   TEXT,                 -- filed/scheduled arrival time (ISO UTC, from flightCreate)
    gate_out        TEXT,                 -- actual OUT time (ISO UTC)
    wheels_off      TEXT,                 -- actual OFF time (ISO UTC)
    wheels_on       TEXT,                 -- actual ON time  (ISO UTC)
    gate_in         TEXT,                 -- actual IN time  (ISO UTC)
    dep_gate        TEXT,                 -- gate number
    arr_gate        TEXT,
    dep_terminal    TEXT,
    arr_terminal    TEXT,
    dep_delay_min   INTEGER DEFAULT 0,
    arr_delay_min   INTEGER DEFAULT 0,
    altitude        INTEGER,              -- current altitude FL (from trackInformation)
    speed           INTEGER,              -- current groundspeed knots
    latitude        REAL,                 -- current position
    longitude       REAL,
    position_time   TEXT,                 -- UTC time of last position report
    gufi            TEXT,                 -- FAA globally unique flight identifier
    tail_number     TEXT,
    aircraft_type   TEXT,
    faa_flight_ref  TEXT,                 -- flightRef on fltdMessage
    tfm_msg_type    TEXT,                 -- e.g. FlightModify, flightCreate
    tfm_fd_trigger  TEXT,                 -- fdTrigger attribute
    tfm_source_timestamp TEXT,            -- sourceTimeStamp (FAA publish time, ISO)
    ncsm_flight_status TEXT,                -- nxcm:flightStatus e.g. PLANNED
    aircraft_category TEXT,                -- e.g. JET on qualifiedAircraftId
    airline_icao   TEXT,                  -- airline attr (3-letter ICAO)
    raw_xml         TEXT,                 -- last raw TFMData message for debugging
    updated_at      TEXT NOT NULL,        -- ISO UTC timestamp of last update
    UNIQUE(flight, date, dep_airport)
  );

  CREATE INDEX IF NOT EXISTS idx_flight_date ON flight_events(flight, date);
  CREATE INDEX IF NOT EXISTS idx_updated     ON flight_events(updated_at);

  CREATE TABLE IF NOT EXISTS flight_watches (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email      TEXT NOT NULL,
    flight          TEXT NOT NULL,        -- "UA440"
    date            TEXT NOT NULL,        -- "YYYY-MM-DD"
    dep_airport     TEXT,
    arr_airport     TEXT,
    last_notified   TEXT,                 -- last status we sent a push for
    created_at      TEXT NOT NULL,
    UNIQUE(user_email, flight, date, dep_airport)
  );

  CREATE INDEX IF NOT EXISTS idx_watches_flight ON flight_watches(flight, date);
`);

// ── Add TFM metadata columns on existing DBs (SQLite) ──────────────────────────
(function migrateFlightEventsColumns() {
  const cols = db.prepare('PRAGMA table_info(flight_events)').all();
  const have = new Set(cols.map((c) => c.name));
  const add = [
    ['faa_flight_ref', 'TEXT'],
    ['tfm_msg_type', 'TEXT'],
    ['tfm_fd_trigger', 'TEXT'],
    ['tfm_source_timestamp', 'TEXT'],
    ['ncsm_flight_status', 'TEXT'],
    ['aircraft_category', 'TEXT'],
    ['airline_icao', 'TEXT'],
  ];
  for (const [name, typ] of add) {
    if (!have.has(name)) {
      db.exec(`ALTER TABLE flight_events ADD COLUMN ${name} ${typ}`);
    }
  }
})();

// ── flight_events helpers ─────────────────────────────────────────────────────

const upsertEvent = db.prepare(`
  INSERT INTO flight_events
    (flight, date, dep_airport, arr_airport, status,
     scheduled_dep, scheduled_arr,
     gate_out, wheels_off, wheels_on, gate_in,
     dep_gate, arr_gate, dep_terminal, arr_terminal,
     dep_delay_min, arr_delay_min,
     altitude, speed, latitude, longitude, position_time, gufi,
     tail_number, aircraft_type,
     faa_flight_ref, tfm_msg_type, tfm_fd_trigger, tfm_source_timestamp,
     ncsm_flight_status, aircraft_category, airline_icao,
     raw_xml, updated_at)
  VALUES
    (@flight, @date, @dep_airport, @arr_airport, @status,
     @scheduled_dep, @scheduled_arr,
     @gate_out, @wheels_off, @wheels_on, @gate_in,
     @dep_gate, @arr_gate, @dep_terminal, @arr_terminal,
     @dep_delay_min, @arr_delay_min,
     @altitude, @speed, @latitude, @longitude, @position_time, @gufi,
     @tail_number, @aircraft_type,
     @faa_flight_ref, @tfm_msg_type, @tfm_fd_trigger, @tfm_source_timestamp,
     @ncsm_flight_status, @aircraft_category, @airline_icao,
     @raw_xml, @updated_at)
  ON CONFLICT(flight, date, dep_airport) DO UPDATE SET
    arr_airport   = excluded.arr_airport,
    status        = excluded.status,
    scheduled_dep = COALESCE(scheduled_dep,   excluded.scheduled_dep),
    scheduled_arr = COALESCE(scheduled_arr,   excluded.scheduled_arr),
    gate_out      = COALESCE(excluded.gate_out,      gate_out),
    wheels_off    = COALESCE(excluded.wheels_off,    wheels_off),
    wheels_on     = COALESCE(excluded.wheels_on,     wheels_on),
    gate_in       = COALESCE(excluded.gate_in,       gate_in),
    dep_gate      = COALESCE(excluded.dep_gate,      dep_gate),
    arr_gate      = COALESCE(excluded.arr_gate,      arr_gate),
    dep_terminal  = COALESCE(excluded.dep_terminal,  dep_terminal),
    arr_terminal  = COALESCE(excluded.arr_terminal,  arr_terminal),
    dep_delay_min = excluded.dep_delay_min,
    arr_delay_min = excluded.arr_delay_min,
    altitude      = COALESCE(excluded.altitude,      altitude),
    speed         = COALESCE(excluded.speed,         speed),
    latitude      = COALESCE(excluded.latitude,      latitude),
    longitude     = COALESCE(excluded.longitude,     longitude),
    position_time = COALESCE(excluded.position_time, position_time),
    gufi          = COALESCE(excluded.gufi,          gufi),
    tail_number   = COALESCE(excluded.tail_number,   tail_number),
    aircraft_type = COALESCE(excluded.aircraft_type, aircraft_type),
    faa_flight_ref = COALESCE(excluded.faa_flight_ref, faa_flight_ref),
    tfm_msg_type = COALESCE(excluded.tfm_msg_type, tfm_msg_type),
    tfm_fd_trigger = COALESCE(excluded.tfm_fd_trigger, tfm_fd_trigger),
    tfm_source_timestamp = COALESCE(excluded.tfm_source_timestamp, tfm_source_timestamp),
    ncsm_flight_status = COALESCE(excluded.ncsm_flight_status, ncsm_flight_status),
    aircraft_category = COALESCE(excluded.aircraft_category, aircraft_category),
    airline_icao = COALESCE(excluded.airline_icao, airline_icao),
    raw_xml       = excluded.raw_xml,
    updated_at    = excluded.updated_at
`);

function saveEvent(event) {
  return upsertEvent.run({
    flight:        event.flight        || null,
    date:          event.date          || null,
    dep_airport:   event.dep_airport   || null,
    arr_airport:   event.arr_airport   || null,
    status:        event.status        || null,
    scheduled_dep: event.scheduled_dep  || null,
    scheduled_arr: event.scheduled_arr  || null,
    gate_out:      event.gate_out       || null,
    wheels_off:    event.wheels_off    || null,
    wheels_on:     event.wheels_on     || null,
    gate_in:       event.gate_in       || null,
    dep_gate:      event.dep_gate      || null,
    arr_gate:      event.arr_gate      || null,
    dep_terminal:  event.dep_terminal  || null,
    arr_terminal:  event.arr_terminal  || null,
    dep_delay_min: event.dep_delay_min || 0,
    arr_delay_min: event.arr_delay_min || 0,
    altitude:      event.altitude       ?? null,
    speed:         event.speed         ?? null,
    latitude:      event.latitude      ?? null,
    longitude:     event.longitude     ?? null,
    position_time: event.position_time || null,
    gufi:          event.gufi          || null,
    tail_number:   event.tail_number   || null,
    aircraft_type: event.aircraft_type || null,
    faa_flight_ref: event.faa_flight_ref || null,
    tfm_msg_type:   event.tfm_msg_type   || null,
    tfm_fd_trigger: event.tfm_fd_trigger || null,
    tfm_source_timestamp: event.tfm_source_timestamp || null,
    ncsm_flight_status: event.ncsm_flight_status || null,
    aircraft_category: event.aircraft_category || null,
    airline_icao:  event.airline_icao  || null,
    raw_xml:       event.raw_xml       || null,
    updated_at:    new Date().toISOString(),
  });
}

function getEvent(flight, date, depAirport) {
  if (depAirport) {
    return db.prepare(
      'SELECT * FROM flight_events WHERE flight=? AND date=? AND dep_airport=?'
    ).get(flight, date, depAirport) || null;
  }
  // No dep airport — return most recently updated matching flight
  return db.prepare(
    'SELECT * FROM flight_events WHERE flight=? AND date=? ORDER BY updated_at DESC LIMIT 1'
  ).get(flight, date) || null;
}

// Clean up events older than 3 days
function pruneOldEvents() {
  const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const result = db.prepare("DELETE FROM flight_events WHERE date < ?").run(cutoff);
  if (result.changes > 0) console.log(`[db] pruned ${result.changes} old flight events`);
}

// ── flight_watches helpers ────────────────────────────────────────────────────

function addWatch(userEmail, flight, date, depAirport, arrAirport) {
  db.prepare(`
    INSERT OR IGNORE INTO flight_watches
      (user_email, flight, date, dep_airport, arr_airport, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userEmail, flight, date, depAirport || null, arrAirport || null, new Date().toISOString());
}

function getWatchesForFlight(flight, date) {
  return db.prepare(
    'SELECT * FROM flight_watches WHERE flight=? AND date=?'
  ).all(flight, date);
}

function updateWatchNotified(id, status) {
  db.prepare('UPDATE flight_watches SET last_notified=? WHERE id=?').run(status, id);
}

function pruneOldWatches() {
  const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  db.prepare("DELETE FROM flight_watches WHERE date < ?").run(cutoff);
}

module.exports = {
  saveEvent,
  getEvent,
  pruneOldEvents,
  addWatch,
  getWatchesForFlight,
  updateWatchNotified,
  pruneOldWatches,
};
