'use strict';

const solace = require('solclientjs');

let factoryInitialized = false;

function initFactory() {
  if (factoryInitialized) return;
  const factoryProps = new solace.SolclientFactoryProperties();
  factoryProps.profile = solace.SolclientFactoryProfiles.version10;
  solace.SolclientFactory.init(factoryProps);
  factoryInitialized = true;
}

function messageBodyToString(message) {
  try {
    if (message.getType() === solace.MessageType.TEXT) {
      const sdt = message.getSdtContainer();
      if (sdt && typeof sdt.getValue === 'function') {
        const v = sdt.getValue();
        if (v != null) return String(v);
      }
    }
  } catch {
    /* binary path */
  }

  const bin = message.getBinaryAttachment();
  if (bin != null) {
    if (Buffer.isBuffer(bin)) return bin.toString('utf8');
    if (bin instanceof Uint8Array) return Buffer.from(bin).toString('utf8');
    if (typeof bin === 'string') return bin;
  }

  try {
    const sdt = message.getSdtContainer && message.getSdtContainer();
    if (sdt && typeof sdt.getValue === 'function') {
      const v = sdt.getValue();
      if (v != null) return String(v);
    }
  } catch {
    /* ignore */
  }

  return '';
}

/**
 * Solace SMF queue consumer (same stack as swim-node-consumer smf-consumer).
 * CLIENT acknowledge: ack after successful processing; no ack on error (redelivery).
 *
 * @param {object} opts
 * @param {string} opts.providerUrl — tcps://host:port etc.
 * @param {string} opts.vpn
 * @param {string} opts.username
 * @param {string} opts.password
 * @param {string} opts.queue
 * @param {string} [opts.clientName]
 * @param {number} [opts.reconnectRetries] default -1 (infinite)
 * @param {boolean} [opts.sslValidateCertificate]
 * @param {string[]} [opts.sslTrustStores]
 * @param {string} opts.logPrefix
 * @param {(xmlStr: string) => Promise<void>} opts.onMessage
 */
function connectSmfQueue(opts) {
  initFactory();

  const {
    providerUrl,
    vpn,
    username,
    password,
    queue,
    clientName,
    reconnectRetries = -1,
    sslValidateCertificate,
    sslTrustStores,
    logPrefix,
    onMessage,
  } = opts;

  let reconnectDelay = 5000;
  let reconnectTimer = null;
  let intentionalStop = false;
  let session = null;
  let messageConsumer = null;

  console.log(`${logPrefix} connecting SMF ${providerUrl} vpn=${vpn} queue=${queue} user=${username}`);

  function cleanup() {
    if (messageConsumer) {
      try {
        messageConsumer.disconnect();
      } catch {
        /* ignore */
      }
      try {
        messageConsumer.dispose();
      } catch {
        /* ignore */
      }
      messageConsumer = null;
    }
    if (session) {
      try {
        session.disconnect();
      } catch {
        /* ignore */
      }
      try {
        session.dispose();
      } catch {
        /* ignore */
      }
      session = null;
    }
  }

  function scheduleReconnect(reason) {
    if (intentionalStop) return;
    if (reconnectTimer) return;
    cleanup();
    const wait = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 300000);
    console.warn(`${logPrefix} ${reason} — reconnecting in`, wait / 1000, 's');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectInternal();
    }, wait);
  }

  function connectInternal() {
    const sessionProps = {
      url: providerUrl,
      vpnName: vpn,
      userName: username,
      password,
      clientName: clientName || undefined,
      reconnectRetries,
      connectTimeoutInMsecs: 60000,
      maxWebPayload: 10 * 1024 * 1024,
      sendBufferMaxSize: 1024 * 1024,
    };

    if (sslValidateCertificate !== undefined) {
      sessionProps.sslValidateCertificate = sslValidateCertificate;
    }
    if (sslTrustStores && sslTrustStores.length > 0) {
      sessionProps.sslTrustStores = sslTrustStores;
    }

    session = solace.SolclientFactory.createSession(sessionProps);

    session.on(solace.SessionEventCode.UP_NOTICE, () => {
      reconnectDelay = 5000;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      messageConsumer = session.createMessageConsumer({
        queueDescriptor: { name: queue, type: solace.QueueType.QUEUE },
        acknowledgeMode: solace.MessageConsumerAcknowledgeMode.CLIENT,
        createIfMissing: false,
      });

      messageConsumer.on(solace.MessageConsumerEventName.UP, () => {
        console.log(`${logPrefix} SMF queue bound: ${queue}`);
      });

      messageConsumer.on(solace.MessageConsumerEventName.CONNECT_FAILED_ERROR, (err) => {
        console.error(
          `${logPrefix} queue consumer bind failed:`,
          err && err.message ? err.message : err
        );
        scheduleReconnect('consumer bind failed');
      });

      messageConsumer.on(solace.MessageConsumerEventName.DOWN_ERROR, (err) => {
        console.warn(`${logPrefix} consumer down:`, err && err.message ? err.message : err);
        scheduleReconnect('consumer down');
      });

      messageConsumer.on(solace.MessageConsumerEventName.MESSAGE, (message) => {
        (async () => {
          const xmlStr = messageBodyToString(message);
          if (!xmlStr) {
            try {
              message.acknowledge();
            } catch {
              /* ignore */
            }
            return;
          }
          try {
            await onMessage(xmlStr);
            message.acknowledge();
          } catch (err) {
            console.warn(`${logPrefix} message processing error:`, err.message);
            /* do not acknowledge — allow redelivery */
          }
        })();
      });

      try {
        messageConsumer.connect();
      } catch (err) {
        console.error(`${logPrefix} messageConsumer.connect failed:`, err.message);
        scheduleReconnect('consumer connect failed');
      }
    });

    session.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, (sessionEvent) => {
      const info = sessionEvent && sessionEvent.infoStr ? sessionEvent.infoStr : sessionEvent;
      console.error(`${logPrefix} SMF session connect failed:`, info);
      scheduleReconnect('session connect failed');
    });

    session.on(solace.SessionEventCode.DISCONNECTED, () => {
      if (intentionalStop) return;
      console.warn(`${logPrefix} SMF session disconnected`);
      scheduleReconnect('session disconnected');
    });

    try {
      session.connect();
    } catch (err) {
      console.error(`${logPrefix} session.connect failed:`, err.message);
      scheduleReconnect('session.connect threw');
    }
  }

  connectInternal();

  return {
    disconnect() {
      intentionalStop = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      cleanup();
    },
  };
}

module.exports = {
  connectSmfQueue,
};
