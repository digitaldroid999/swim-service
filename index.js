// Crew Assist SWIM Service — Main Entry Point
// Connects to FAA SWIM SCDS via Solace SMF (solclientjs, tcps:// or wss://),
// parses TFMData / SFDPS XML messages, stores flight events, and triggers push notifications.

const cron          = require('node-cron');
const config        = require('./config');
const db            = require('./db');
const parser        = require('./parser');
const sfdpsParser   = require('./sfdps-parser');
const { initVapid, notifyWatchers } = require('./notifications');
const { startApi }  = require('./api');
const { connectQueueConsumer } = require('./solace-smf');

// ── Startup ───────────────────────────────────────────────────────────────────

console.log('[swim] Crew Assist SWIM Service starting…');

initVapid();
startApi();

// Prune old data daily at 3am
cron.schedule('0 3 * * *', () => {
  db.pruneOldEvents();
  db.pruneOldWatches();
  console.log('[swim] daily prune complete');
});

// ── SMF (Solace) connections ────────────────────────────────────────────────────

const swim = config.swim;
const swimUrl = swim.url || `tcps://${swim.host}:${swim.port}`;

if (!swim.username || !swim.password || !swim.queue) {
  console.warn('[swim] TFMData credentials not configured — running in API-only mode');
  console.warn('[swim] Set SWIM_USERNAME, SWIM_PASSWORD, SWIM_QUEUE in .env to enable live data');
} else {
  connectSwim();
}

const sfdps = config.sfdps;
const sfdpsUrl = sfdps.url || `tcps://${sfdps.host}:${sfdps.port}`;

if (!sfdps.username || !sfdps.password || !sfdps.queue) {
  console.warn('[sfdps] SFDPS credentials not configured — actual OOOI times unavailable');
  console.warn('[sfdps] Set SWIM_SFDPS_* vars in .env to enable actual gate/runway times');
} else {
  connectSfdps();
}

let swimReconnectDelay = 5000;
let swimReconnectTimer = null;
let swimHandle = null;

function connectSwim() {
  clearTimeout(swimReconnectTimer);
  swimReconnectTimer = null;

  console.log(`[swim] connecting SMF ${swimUrl} vpn=${swim.vpn} as ${swim.username}`);

  swimHandle = connectQueueConsumer({
    url: swimUrl,
    vpnName: swim.vpn,
    userName: swim.username,
    password: swim.password,
    queueName: swim.queue,
    clientName: 'ca-swim-tfmdata',
    logPrefix: 'swim',
    onSessionUp: () => {
      swimReconnectDelay = 5000;
    },
    onXml: async (xmlStr) => {
      const events = await parser.parseTfmMessage(xmlStr);

      for (const event of events) {
        const prev = db.getEvent(event.flight, event.date, event.dep_airport);
        const prevStatus = prev ? prev.status : null;

        db.saveEvent(event);

        if (event.status !== prevStatus) {
          notifyWatchers(event, prevStatus).catch(err =>
            console.warn('[swim] notify error:', err.message)
          );
        }
      }
    },
    onDisconnect: () => {
      swimHandle = null;
      console.warn('[swim] connection closed — reconnecting in', swimReconnectDelay / 1000, 's');
      swimReconnectTimer = setTimeout(() => {
        swimReconnectDelay = Math.min(swimReconnectDelay * 2, 300000);
        connectSwim();
      }, swimReconnectDelay);
    },
  });
}

let sfdpsReconnectDelay = 5000;
let sfdpsReconnectTimer = null;
let sfdpsHandle = null;

function connectSfdps() {
  clearTimeout(sfdpsReconnectTimer);
  sfdpsReconnectTimer = null;

  console.log(`[sfdps] connecting SMF ${sfdpsUrl} vpn=${sfdps.vpn} as ${sfdps.username}`);

  sfdpsHandle = connectQueueConsumer({
    url: sfdpsUrl,
    vpnName: sfdps.vpn,
    userName: sfdps.username,
    password: sfdps.password,
    queueName: sfdps.queue,
    clientName: 'ca-swim-sfdps',
    logPrefix: 'sfdps',
    onSessionUp: () => {
      sfdpsReconnectDelay = 5000;
    },
    onXml: async (xmlStr) => {
      const events = sfdpsParser.parseSfdpsMessage(xmlStr);

      for (const event of events) {
        const prev = db.getEvent(event.flight, event.date, event.dep_airport);
        const prevStatus = prev ? prev.status : null;
        db.saveEvent(event);
        if (event.status && event.status !== prevStatus) {
          notifyWatchers(event, prevStatus).catch(err =>
            console.warn('[sfdps] notify error:', err.message)
          );
        }
      }
    },
    onDisconnect: () => {
      sfdpsHandle = null;
      console.warn('[sfdps] connection closed — reconnecting in', sfdpsReconnectDelay / 1000, 's');
      sfdpsReconnectTimer = setTimeout(() => {
        sfdpsReconnectDelay = Math.min(sfdpsReconnectDelay * 2, 300000);
        connectSfdps();
      }, sfdpsReconnectDelay);
    },
  });
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown() {
  clearTimeout(swimReconnectTimer);
  clearTimeout(sfdpsReconnectTimer);
  if (swimHandle) swimHandle.disconnect();
  if (sfdpsHandle) sfdpsHandle.disconnect();
}

process.on('SIGTERM', () => {
  console.log('[swim] SIGTERM received — shutting down');
  shutdown();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[swim] SIGINT received — shutting down');
  shutdown();
  process.exit(0);
});
