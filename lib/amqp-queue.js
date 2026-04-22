'use strict';

const rhea = require('rhea');

/**
 * Parse amqp:// or amqps:// for host, port, transport (swim-node-consumer compatible).
 */
function parseAmqpUrl(urlString, username, password) {
  const withCreds =
    urlString.includes('@') || !username
      ? urlString
      : urlString.replace(/^(amqps?:\/\/)/, (_, scheme) => {
          const enc = encodeURIComponent;
          return `${scheme}${enc(username)}:${enc(password)}@`;
        });

  const u = new URL(withCreds);
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'amqp' && scheme !== 'amqps') {
    throw new Error(`Not an AMQP URL: ${scheme}`);
  }
  const host = u.hostname || 'localhost';
  const port = u.port ? parseInt(u.port, 10) : scheme === 'amqps' ? 5671 : 5672;
  return {
    host,
    port,
    transport: scheme === 'amqps' ? 'tls' : 'tcp',
    username: decodeURIComponent(u.username || username || ''),
    password: decodeURIComponent(u.password || password || ''),
  };
}

function messageBodyToString(msg) {
  if (Buffer.isBuffer(msg.body)) return msg.body.toString('utf8');
  if (typeof msg.body === 'string') return msg.body;
  if (msg.body && msg.body.content) return msg.body.content.toString('utf8');
  if (Array.isArray(msg.body)) {
    return Buffer.concat(msg.body.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x)))).toString('utf8');
  }
  return '';
}

/**
 * AMQP 1.0 consumer with manual accept/release (same behavior as previous index.js).
 * A new rhea container is created on each connection attempt (matches prior reconnect logic).
 *
 * @param {object} opts
 * @param {'legacy'|'url'} opts.mode
 * @param {string} [opts.providerUrl] — when mode is url
 * @param {string} opts.host
 * @param {number} opts.port
 * @param {string} opts.username
 * @param {string} opts.password
 * @param {string} opts.queue
 * @param {string} [opts.virtualHost] — Solace AMQP VPN
 * @param {string} opts.connectionId
 * @param {string} opts.logPrefix
 * @param {(xmlStr: string) => Promise<void>} opts.onMessage
 */
function connectAmqpQueue(opts) {
  const {
    mode,
    providerUrl,
    host,
    port,
    username,
    password,
    queue,
    virtualHost,
    connectionId,
    logPrefix,
    onMessage,
  } = opts;

  let connOpts;
  if (mode === 'url') {
    connOpts = parseAmqpUrl(providerUrl, username, password);
  } else {
    connOpts = {
      host,
      port,
      transport: 'tls',
      username,
      password,
    };
  }

  let reconnectDelay = 5000;
  let reconnectTimer = null;

  function scheduleReconnect(reason) {
    if (reconnectTimer) return;
    if (reason) console.warn(`${logPrefix} reconnect scheduled (${reason})`);
    const wait = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 300000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      tryConnect();
    }, wait);
  }

  function tryConnect() {
    // console.log(
    //   `${logPrefix} connecting AMQP ${connOpts.transport}://${connOpts.host}:${connOpts.port} as ${connOpts.username}`
    // );

    const container = rhea.create_container();

    container.on('connection_open', (ctx) => {
      // console.log(`${logPrefix} AMQP connection established`);
      reconnectDelay = 5000;
      ctx.connection.open_receiver({
        source: { address: queue },
        credit_window: 100,
        autoaccept: false,
      });
    });

    container.on('receiver_open', () => {
      // console.log(`${logPrefix} receiver open on queue: ${queue}`);
    });

    container.on('message', async (ctx) => {
      const msg = ctx.message;
      let xmlStr = null;
      try {
        xmlStr = messageBodyToString(msg);
        if (!xmlStr) {
          ctx.delivery.accept();
          return;
        }
        await onMessage(xmlStr);
        ctx.delivery.accept();
      } catch (err) {
        console.warn(`${logPrefix} message processing error:`, err.message);
        ctx.delivery.release({ undeliverable_here: false });
      }
    });

    container.on('connection_error', (ctx) => {
      const err = ctx.connection.get_error && ctx.connection.get_error();
      console.error(`${logPrefix} connection error:`, err?.description || err);
    });

    container.on('connection_close', (ctx) => {
      const closeErr = ctx.connection.get_error && ctx.connection.get_error();
      if (closeErr) console.error(`${logPrefix} close reason:`, closeErr.description || JSON.stringify(closeErr));
      console.warn(`${logPrefix} connection closed — reconnecting in`, reconnectDelay / 1000, 's');
      scheduleReconnect('connection_close');
    });

    container.on('disconnected', (ctx) => {
      const err = ctx.error;
      if (err) console.error(`${logPrefix} disconnected with error:`, err.message || err);
      else console.warn(`${logPrefix} disconnected`);
      scheduleReconnect('disconnected');
    });

    try {
      container.connect({
        id: connectionId,
        host: connOpts.host,
        port: connOpts.port,
        username: connOpts.username,
        password: connOpts.password,
        virtual_host: virtualHost || undefined,
        transport: connOpts.transport,
        reconnect: false,
        idle_time_out: 60000,
        max_frame_size: 65536,
      });
    } catch (e) {
      console.error(`${logPrefix} connect failed:`, e.message);
      scheduleReconnect('connect threw');
    }
  }

  tryConnect();
}

module.exports = {
  connectAmqpQueue,
};
