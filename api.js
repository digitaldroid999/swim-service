// Crew Assist SWIM Service — REST API
// Netlify functions call this to get cached flight status instead of AeroDataBox.
// Also accepts watch registrations from the schedule save flow.

const express = require('express');
const db      = require('./db');
const config  = require('./config');

const app = express();
app.use(express.json());

/** Max flights per POST /watch body (abuse / memory guard). */
const MAX_WATCH_FLIGHTS = 100;

// Simple shared-secret auth (set API_SECRET env var on both sides).
// Header-only: never accept ?secret= — query strings are logged by load balancers and log pipelines.
function auth(req, res, next) {
  const secret = req.headers['x-api-secret'];
  if (secret !== config.api.secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function normalizeFlightId(s) {
  return String(s || '').toUpperCase().replace(/\s/g, '');
}

function normalizeWatchDate(s) {
  return String(s || '').slice(0, 10);
}

function normalizeIata(s) {
  if (s == null || s === '') return null;
  return String(s).toUpperCase().replace(/\s/g, '');
}

function isValidFlightId(flight) {
  return /^[A-Z0-9]{2,12}$/.test(flight);
}

function isValidIsoDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  return !Number.isNaN(Date.parse(`${dateStr}T12:00:00Z`));
}

function isValidIataOptional(raw) {
  if (raw == null || raw === '') return true;
  return /^[A-Z]{3}$/.test(normalizeIata(raw));
}

function isValidWatchEmail(email) {
  if (typeof email !== 'string') return false;
  const e = email.trim();
  if (e.length < 3 || e.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// ── GET /flight?flight=UA440&date=2026-04-15&dep=EWR ─────────────────────────
// Returns cached SWIM data for a flight. Used by Netlify flight_status.js.
app.get('/flight', auth, (req, res) => {
  const flight = (req.query.flight || '').toUpperCase().replace(/\s/g, '');
  const date   = (req.query.date   || '').slice(0, 10);
  const dep    = (req.query.dep    || '').toUpperCase().replace(/\s/g, '');

  if (!flight || !date) {
    return res.status(400).json({ error: 'flight and date required' });
  }

  const event = db.getEvent(flight, date, dep || null);
  if (!event) {
    return res.status(404).json({ error: 'No SWIM data for this flight' });
  }

  // Normalize to same shape as AeroDataBox response so flight_status.js
  // can use either source transparently
  const normalized = {
    flight:   event.flight,
    status:   event.status || 'Scheduled',
    aircraft: event.tail_number
      ? { model: event.aircraft_type, reg: event.tail_number }
      : null,
    departure: {
      airport:       event.dep_airport ? { iata: event.dep_airport } : null,
      scheduledTime: event.scheduled_dep ? { utc: event.scheduled_dep } : null,
      actualTime:    event.gate_out    ? { utc: event.gate_out    } : null,
      revisedTime:   null,
      bestTime:      event.gate_out    ? { utc: event.gate_out    } : null,
      runwayTime:    event.wheels_off  ? { utc: event.wheels_off  } : null,
      gate:          event.dep_gate    || null,
      terminal:      event.dep_terminal|| null,
      delay:         event.dep_delay_min || 0,
    },
    arrival: {
      airport:       event.arr_airport ? { iata: event.arr_airport } : null,
      scheduledTime: event.scheduled_arr ? { utc: event.scheduled_arr } : null,
      actualTime:    event.gate_in     ? { utc: event.gate_in     } : null,
      revisedTime:   null,
      bestTime:      event.gate_in     ? { utc: event.gate_in     } : null,
      runwayTime:    event.wheels_on   ? { utc: event.wheels_on   } : null,
      gate:          event.arr_gate    || null,
      terminal:      event.arr_terminal|| null,
      delay:         event.arr_delay_min || 0,
    },
    position: (event.latitude && event.longitude) ? {
      lat:      event.latitude,
      lon:      event.longitude,
      altitude: event.altitude,     // FL e.g. 280 = FL280
      speed:    event.speed,        // knots
      time:     event.position_time,
    } : null,
    _source:     'swim',
    _updated_at: event.updated_at,
    _tfm: {
      faa_flight_ref:     event.faa_flight_ref     || null,
      msg_type:           event.tfm_msg_type       || null,
      fd_trigger:         event.tfm_fd_trigger     || null,
      source_timestamp:   event.tfm_source_timestamp || null,
      ncsm_flight_status: event.ncsm_flight_status || null,
      aircraft_category:  event.aircraft_category  || null,
      airline_icao:       event.airline_icao      || null,
      gufi:               event.gufi              || null,
    },
  };

  res.json(normalized);
});

// ── POST /watch ───────────────────────────────────────────────────────────────
// Register a user to receive push notifications when a flight changes status.
// Called by Netlify save_schedule.js after saving a schedule.
// Body: { userEmail, flights: [{ flight, date, dep, arr }] }
app.post('/watch', auth, (req, res) => {
  const { userEmail, flights } = req.body || {};
  if (!userEmail || !Array.isArray(flights) || !flights.length) {
    return res.status(400).json({ error: 'userEmail and flights[] required' });
  }
  if (!isValidWatchEmail(userEmail)) {
    return res.status(400).json({ error: 'invalid userEmail' });
  }
  if (flights.length > MAX_WATCH_FLIGHTS) {
    return res.status(400).json({ error: `flights[] must have at most ${MAX_WATCH_FLIGHTS} items` });
  }

  const email = userEmail.trim();
  let added = 0;
  for (const f of flights) {
    if (!f || typeof f !== 'object') {
      return res.status(400).json({ error: 'each flights[] item must be an object' });
    }
    const flight = normalizeFlightId(f.flight);
    const date = normalizeWatchDate(f.date);
    if (!flight || !date) continue;

    if (!isValidFlightId(flight)) {
      return res.status(400).json({ error: 'invalid flight identifier' });
    }
    if (!isValidIsoDate(date)) {
      return res.status(400).json({ error: 'invalid date' });
    }
    if (!isValidIataOptional(f.dep)) {
      return res.status(400).json({ error: 'invalid dep airport code' });
    }
    if (!isValidIataOptional(f.arr)) {
      return res.status(400).json({ error: 'invalid arr airport code' });
    }

    const dep = f.dep != null && f.dep !== '' ? normalizeIata(f.dep) : null;
    const arr = f.arr != null && f.arr !== '' ? normalizeIata(f.arr) : null;
    db.addWatch(email, flight, date, dep, arr);
    added++;
  }

  res.json({ ok: true, added });
});

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'crew-assist-swim', time: new Date().toISOString() });
});

function startApi() {
  app.listen(config.api.port, () => {
    console.log(`[api] listening on port ${config.api.port}`);
  });
}

module.exports = { startApi, app };
