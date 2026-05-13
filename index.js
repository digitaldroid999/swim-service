// Crew Assist SWIM Service — Main Entry Point
// SWIM: Solace SMF only here (tcps/tcp/wss/ws). AMQP consumer paths are commented out below.
// Parses TFMData / SFDPS XML, stores events, triggers push notifications.

require('dotenv').config(); // before reading SWIM_* (run app from project root so `.env` is found)

const fs = require('fs');
const path = require('path');

const cron = require('node-cron');
const config = require('./config');
const db = require('./db');
const parser = require('./parser');
const sfdpsParser = require('./sfdps-parser');
const { initVapid, notifyWatchers } = require('./notifications');
const { startApi } = require('./api');
const { brokerKind } = require('./lib/broker-url');
// const { connectAmqpQueue } = require('./lib/amqp-queue'); // disabled — use SMF to FAA SWIM
const { connectSmfQueue } = require('./lib/smf-queue');

function envFlag(name) {
  const v = process.env[name];
  if (v === undefined || v === '') return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function isLogPreSaveEnabled() {
  return envFlag('SWIM_LOG_PRE_SAVE') || envFlag('SWIM_LOG_DB_ROWS');
}

function preSaveLogFilePath() {
  const p = (process.env.SWIM_LOG_PRE_SAVE_FILE || '').trim();
  return path.resolve(process.cwd(), p || 'log/swim-pre-save.log');
}

function appendPreSaveLogFile(text) {
  const filePath = preSaveLogFilePath();
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(filePath, text, 'utf8');
  } catch (err) {
    console.error('[swim] SWIM_LOG_PRE_SAVE file write failed:', err.message);
  }
}

/**
 * Log one sample event (flight_events shape) and flight_watches for that flight/date.
 * Call once per handler invocation, not per event in a batch.
 * Writes the same content to console and to SWIM_LOG_PRE_SAVE_FILE (default log/swim-pre-save.log).
 */
function logBeforeSaveEvent(source, event) {
  if (!isLogPreSaveEnabled()) return;
  const ev = { ...event };
  const watches =
    event.flight && event.date ? db.getWatchesForFlight(event.flight, event.date) : null;

  const ts = new Date().toISOString();
  let block = `\n--- ${ts} [${source}] ---\n`;
  block += `flight_events (before saveEvent)\n${JSON.stringify(ev, null, 2)}\n`;
  if (watches != null) {
    block +=
      `flight_watches (existing rows for ${event.flight} ${event.date}, before saveEvent)\n` +
      `${JSON.stringify(watches, null, 2)}\n`;
  }

  // console.log(`[${source}] flight_events (before saveEvent)\n${JSON.stringify(ev, null, 2)}`);
  if (watches != null) {
    // console.log(
    //   `[${source}] flight_watches (existing rows for ${event.flight} ${event.date}, before saveEvent)\n` +
    //     JSON.stringify(watches, null, 2)
    // );
  }
  appendPreSaveLogFile(block);
}

// console.log('[swim] Crew Assist SWIM Service starting…');

if (isLogPreSaveEnabled()) {
  // console.log(
  //   `[swim] SWIM_LOG_PRE_SAVE is on — logs append to ${preSaveLogFilePath()} (and console) when TFM/SFDPS messages arrive.`
  // );
}

initVapid();
startApi();

cron.schedule('0 3 * * *', () => {
  db.pruneOldEvents();
  db.pruneOldWatches();
  // console.log('[swim] daily prune complete');
});

const swim = config.swim;
if (!swim.username || !swim.password || !swim.queue) {
  console.warn('[swim] TFMData credentials not configured — running in API-only mode');
  console.warn('[swim] Set SWIM_USERNAME, SWIM_PASSWORD, SWIM_QUEUE in .env to enable live data');
} else {
  const kind = brokerKind(swim.url, true);
  if (kind === 'smf' && !swim.vpn) {
    console.error('[swim] SMF requires SWIM_VPN (message VPN), matching Solace / swim-node-consumer');
  } else if (kind !== 'smf') {
    if (kind === 'unknown' && swim.url) {
      console.error('[swim] unsupported SWIM_URL scheme — use tcps://, tcp://, wss://, or ws:// for SMF');
    } else {
      console.error(
        '[swim] SMF only: set SWIM_URL to your FAA Solace broker (e.g. tcps://host:port). AMQP / legacy host:port is disabled.'
      );
    }
  } else {
    connectSwim();
  }
}

const sfdps = config.sfdps;
if (!sfdps.username || !sfdps.password || !sfdps.queue) {
  console.warn('[sfdps] SFDPS credentials not configured — actual OOOI times unavailable');
  console.warn('[sfdps] Set SWIM_SFDPS_* vars in .env to enable actual gate/runway times');
} else {
  const sKind = brokerKind(sfdps.url, true);
  if (sKind === 'smf' && !sfdps.vpn) {
    console.error('[sfdps] SMF requires SWIM_SFDPS_VPN');
  } else if (sKind !== 'smf') {
    if (sKind === 'unknown' && sfdps.url) {
      console.error('[sfdps] unsupported SWIM_SFDPS_URL scheme — use tcps://, tcp://, wss://, or ws:// for SMF');
    } else {
      console.error(
        '[sfdps] SMF only: set SWIM_SFDPS_URL to your FAA Solace broker (e.g. tcps://host:port). AMQP / legacy host:port is disabled.'
      );
    }
  } else {
    connectSfdps();
  }
}

async function handleTfmXml(xmlStr) {
  const events = await parser.parseTfmMessage(xmlStr);
  console.log(`[TFM] parsed ${events.length} events from TFM message`);

  if (events.length > 0) {
    logBeforeSaveEvent('tfm', events[0]);
  }
  const toNotify = [];
  db.runInTransaction(() => {
    for (const event of events) {
      const prev = db.getEvent(event.flight, event.date, event.dep_airport);
      const prevStatus = prev ? prev.status : null;
      db.saveEvent(event);
      if (event.status !== prevStatus) {
        toNotify.push({ event, prevStatus });
      }
    }
  });
  for (const { event, prevStatus } of toNotify) {
    notifyWatchers(event, prevStatus).catch((err) => console.warn('[swim] notify error:', err.message));
  }
}

async function handleSfdpsXml(xmlStr) {
  const events = sfdpsParser.parseSfdpsMessage(xmlStr);
  console.log(`[SFDPS] parsed ${events.length} events from SFDPS message`);

  if (events.length > 0) {
    logBeforeSaveEvent('sfdps', events[0]);
  }
  const toNotify = [];
  db.runInTransaction(() => {
    for (const event of events) {
      const prev = db.getEvent(event.flight, event.date, event.dep_airport);
      const prevStatus = prev ? prev.status : null;
      db.saveEvent(event);
      if (event.status && event.status !== prevStatus) {
        toNotify.push({ event, prevStatus });
      }
    }
  });
  for (const { event, prevStatus } of toNotify) {
    notifyWatchers(event, prevStatus).catch((err) => console.warn('[sfdps] notify error:', err.message));
  }
}

function connectSwim() {
  const c = config.swim;
  // Entry only when brokerKind(swim.url) === 'smf' (see startup checks).
  connectSmfQueue({
    providerUrl: c.url,
    vpn: c.vpn,
    username: c.username,
    password: c.password,
    queue: c.queue,
    clientName: c.clientName,
    reconnectRetries: c.reconnectRetries,
    sslValidateCertificate: c.sslValidateCertificate,
    sslTrustStores: c.sslTrustStores,
    logPrefix: '[swim]',
    onMessage: handleTfmXml,
  });

  /*
  // ── AMQP (disabled; use SMF + SWIM_URL=tcps://… ) ─────────────────────────────
  const kind = brokerKind(c.url, true);
  if (kind === 'amqp-url') {
    connectAmqpQueue({
      mode: 'url',
      providerUrl: c.url,
      host: c.host,
      port: c.port,
      username: c.username,
      password: c.password,
      queue: c.queue,
      virtualHost: c.vpn,
      connectionId: 'ca-swim-tfmdata',
      logPrefix: '[swim]',
      onMessage: handleTfmXml,
    });
    return;
  }
  connectAmqpQueue({
    mode: 'legacy',
    host: c.host,
    port: c.port,
    username: c.username,
    password: c.password,
    queue: c.queue,
    virtualHost: c.vpn,
    connectionId: 'ca-swim-tfmdata',
    logPrefix: '[swim]',
    onMessage: handleTfmXml,
  });
  */
}

function connectSfdps() {
  const c = config.sfdps;
  connectSmfQueue({
    providerUrl: c.url,
    vpn: c.vpn,
    username: c.username,
    password: c.password,
    queue: c.queue,
    clientName: c.clientName,
    reconnectRetries: c.reconnectRetries,
    sslValidateCertificate: c.sslValidateCertificate,
    sslTrustStores: c.sslTrustStores,
    logPrefix: '[sfdps]',
    onMessage: handleSfdpsXml,
  });

  /*
  // ── AMQP (disabled; use SMF + SWIM_SFDPS_URL=tcps://… ) ───────────────────────
  const kind = brokerKind(c.url, true);
  if (kind === 'amqp-url') {
    connectAmqpQueue({
      mode: 'url',
      providerUrl: c.url,
      host: c.host,
      port: c.port,
      username: c.username,
      password: c.password,
      queue: c.queue,
      virtualHost: c.vpn,
      connectionId: 'ca-swim-sfdps',
      logPrefix: '[sfdps]',
      onMessage: handleSfdpsXml,
    });
    return;
  }
  connectAmqpQueue({
    mode: 'legacy',
    host: c.host,
    port: c.port,
    username: c.username,
    password: c.password,
    queue: c.queue,
    virtualHost: c.vpn,
    connectionId: 'ca-swim-sfdps',
    logPrefix: '[sfdps]',
    onMessage: handleSfdpsXml,
  });
  */
}

process.on('SIGTERM', () => {
  // console.log('[swim] SIGTERM received — shutting down');
  process.exit(0);
});

process.on('SIGINT', () => {
  // console.log('[swim] SIGINT received — shutting down');
  process.exit(0);
});
