// Crew Assist SWIM Service — Main Entry Point
// Connects to FAA SWIM SCDS via AMQP 1.0 (Solace JMS broker),
// parses TFMData XML messages, stores flight events, and triggers push notifications.

const rhea          = require('rhea');
const cron          = require('node-cron');
const config        = require('./config');
const db            = require('./db');
const parser        = require('./parser');
const sfdpsParser   = require('./sfdps-parser');
const { initVapid, notifyWatchers } = require('./notifications');
const { startApi }  = require('./api');

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

// ── AMQP connections ──────────────────────────────────────────────────────────

const { host, port, username, password, queue } = config.swim;

if (!username || !password || !queue) {
  console.warn('[swim] TFMData credentials not configured — running in API-only mode');
  console.warn('[swim] Set SWIM_USERNAME, SWIM_PASSWORD, SWIM_QUEUE in .env to enable live data');
} else {
  connectSwim();
}

const sfdps = config.sfdps;
if (!sfdps.username || !sfdps.password || !sfdps.queue) {
  console.warn('[sfdps] SFDPS credentials not configured — actual OOOI times unavailable');
  console.warn('[sfdps] Set SWIM_SFDPS_* vars in .env to enable actual gate/runway times');
} else {
  connectSfdps();
}

function connectSwim() {
  console.log(`[swim] connecting to ${host}:${port} as ${username}`);

  const container = rhea.create_container();
  let reconnectDelay = 5000;  // start with 5s, back off to max 5min

  container.on('connection_open', (ctx) => {
    console.log('[swim] AMQP connection established');
    reconnectDelay = 5000;  // reset on successful connect

    // Open receiver on our assigned queue
    ctx.connection.open_receiver({
      source:      { address: queue },
      credit_window: 100,  // prefetch 100 messages at a time
      autoaccept:  false,  // we'll manually accept after processing
    });
  });

  container.on('receiver_open', (ctx) => {
    console.log(`[swim] receiver open on queue: ${queue}`);
  });

  container.on('message', async (ctx) => {
    const msg = ctx.message;
    let xmlStr = null;

    try {
      // Rhea delivers body as Buffer, string, or AMQP value
      if (Buffer.isBuffer(msg.body)) {
        xmlStr = msg.body.toString('utf8');
      } else if (typeof msg.body === 'string') {
        xmlStr = msg.body;
      } else if (msg.body && msg.body.content) {
        xmlStr = msg.body.content.toString('utf8');
      }

      if (!xmlStr) {
        ctx.delivery.accept();
        return;
      }

      // Parse TFMData XML
      const events = await parser.parseTfmMessage(xmlStr);

      for (const event of events) {
        // Check previous status before saving (for change detection)
        const prev = db.getEvent(event.flight, event.date, event.dep_airport);
        const prevStatus = prev ? prev.status : null;

        db.saveEvent(event);

        // Trigger push notifications if status changed
        if (event.status !== prevStatus) {
          notifyWatchers(event, prevStatus).catch(err =>
            console.warn('[swim] notify error:', err.message)
          );
        }
      }

      ctx.delivery.accept();
    } catch (err) {
      console.warn('[swim] message processing error:', err.message);
      // Release message back to queue so it can be redelivered
      ctx.delivery.release({ undeliverable_here: false });
    }
  });

  container.on('connection_error', (ctx) => {
    const err = ctx.connection.get_error();
    console.error('[swim] connection error:', err?.description || err);
  });

  container.on('connection_close', (ctx) => {
    const closeErr = ctx.connection.get_error();
    if (closeErr) console.error('[swim] close reason:', closeErr.description || JSON.stringify(closeErr));
    console.warn('[swim] connection closed — reconnecting in', reconnectDelay / 1000, 's');
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 300000); // max 5 min
      connectSwim();
    }, reconnectDelay);
  });

  container.on('disconnected', (ctx) => {
    const err = ctx.error;
    if (err) console.error('[swim] disconnected with error:', err.message || err);
    else     console.warn('[swim] disconnected');
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 300000);
      connectSwim();
    }, reconnectDelay);
  });

  container.connect({
    id:                  'ca-swim-tfmdata',  // fixed ID so Solace recognises us on reconnect
    host,
    port,
    username,
    password,
    virtual_host:        'TFMS',  // FAA SWIM Message VPN for TFMData
    transport:           'tls',
    reconnect:           false,
    idle_time_out:       60000,
    max_frame_size:      65536,
  });
}

// ── SFDPS connection (actual OOOI gate/runway times) ─────────────────────────

function connectSfdps() {
  const { host: sHost, port: sPort, vpn, username: sUser, password: sPass, queue: sQueue } = config.sfdps;
  console.log(`[sfdps] connecting to ${sHost}:${sPort} vpn=${vpn} as ${sUser}`);

  const container = rhea.create_container();
  let reconnectDelay = 5000;

  container.on('connection_open', (ctx) => {
    console.log('[sfdps] AMQP connection established');
    reconnectDelay = 5000;
    ctx.connection.open_receiver({
      source:        { address: sQueue },
      credit_window: 100,
      autoaccept:    false,
    });
  });

  container.on('receiver_open', (ctx) => {
    console.log(`[sfdps] receiver open on queue: ${sQueue}`);
  });

  container.on('message', async (ctx) => {
    const msg = ctx.message;
    let xmlStr = null;

    try {
      if (Buffer.isBuffer(msg.body))       xmlStr = msg.body.toString('utf8');
      else if (typeof msg.body === 'string') xmlStr = msg.body;
      else if (msg.body?.content)           xmlStr = msg.body.content.toString('utf8');

      if (!xmlStr) { ctx.delivery.accept(); return; }

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

      ctx.delivery.accept();
    } catch (err) {
      console.warn('[sfdps] message processing error:', err.message);
      ctx.delivery.release({ undeliverable_here: false });
    }
  });

  container.on('connection_error', (ctx) => {
    const err = ctx.connection.get_error();
    console.error('[sfdps] connection error:', err?.description || err);
  });

  container.on('connection_close', (ctx) => {
    const closeErr = ctx.connection.get_error();
    if (closeErr) console.error('[sfdps] close reason:', closeErr.description || JSON.stringify(closeErr));
    console.warn('[sfdps] connection closed — reconnecting in', reconnectDelay / 1000, 's');
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 300000);
      connectSfdps();
    }, reconnectDelay);
  });

  container.on('disconnected', (ctx) => {
    const err = ctx.error;
    if (err) console.error('[sfdps] disconnected:', err.message || err);
    else     console.warn('[sfdps] disconnected');
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 300000);
      connectSfdps();
    }, reconnectDelay);
  });

  container.connect({
    id:            'ca-swim-sfdps',  // fixed ID so Solace recognises us on reconnect
    host:          sHost,
    port:          sPort,
    username:      sUser,
    password:      sPass,
    virtual_host:  vpn,          // Solace VPN = FDPS
    transport:     'tls',
    reconnect:     false,
    idle_time_out: 60000,
    max_frame_size: 65536,
  });
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  console.log('[swim] SIGTERM received — shutting down');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[swim] SIGINT received — shutting down');
  process.exit(0);
});
