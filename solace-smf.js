// Solace SMF (tcps:// / wss://) queue consumer — replaces AMQP (rhea) for FAA SWIM SCDS.
const solace = require('solclientjs');

let factoryInitialized = false;

function initFactory() {
  if (factoryInitialized) return;
  const factoryProps = new solace.SolclientFactoryProperties();
  factoryProps.profile = solace.SolclientFactoryProfiles.version10;
  solace.SolclientFactory.init(factoryProps);
  factoryInitialized = true;
}

function messageToXmlString(message) {
  try {
    if (message.getType() === solace.MessageType.TEXT) {
      const sdt = message.getSdtContainer();
      if (sdt && typeof sdt.getValue === 'function') {
        const v = sdt.getValue();
        if (v != null) return String(v);
      }
    }
  } catch (_) {
    /* try binary path */
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
  } catch (_) {
    /* ignore */
  }

  return null;
}

/**
 * Binds to an existing Solace queue over SMF (Session URL: tcps://… or wss://…).
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.vpnName
 * @param {string} opts.userName
 * @param {string} opts.password
 * @param {string} opts.queueName
 * @param {string} [opts.clientName]
 * @param {string} opts.logPrefix
 * @param {(xml: string) => Promise<void>} opts.onXml
 * @param {() => void} [opts.onSessionUp]  reset backoff when session is up
 * @param {() => void} opts.onDisconnect  session/consumer lost — schedule reconnect
 * @returns {{ disconnect: () => void }}
 */
function connectQueueConsumer(opts) {
  initFactory();

  const {
    url,
    vpnName,
    userName,
    password,
    queueName,
    clientName = '',
    logPrefix,
    onXml,
    onSessionUp,
    onDisconnect,
  } = opts;

  let session = null;
  let messageConsumer = null;
  let intentionalDisconnect = false;
  let disconnectNotified = false;

  function notifyDisconnect() {
    if (intentionalDisconnect || disconnectNotified) return;
    disconnectNotified = true;
    cleanup();
    onDisconnect();
  }

  function disposeConsumer() {
    if (!messageConsumer) return;
    try {
      messageConsumer.disconnect();
    } catch (_) {
      /* ignore */
    }
    try {
      messageConsumer.dispose();
    } catch (_) {
      /* ignore */
    }
    messageConsumer = null;
  }

  function disposeSession() {
    if (!session) return;
    try {
      session.disconnect();
    } catch (_) {
      /* ignore */
    }
    try {
      session.dispose();
    } catch (_) {
      /* ignore */
    }
    session = null;
  }

  function cleanup() {
    disposeConsumer();
    disposeSession();
  }

  function disconnect() {
    intentionalDisconnect = true;
    cleanup();
  }

  session = solace.SolclientFactory.createSession({
    url,
    vpnName,
    userName,
    password,
    clientName: clientName || undefined,
    reconnectRetries: 0,
    connectTimeoutInMsecs: 60000,
    maxWebPayload: 10 * 1024 * 1024,
    sendBufferMaxSize: 1024 * 1024,
  });

  session.on(solace.SessionEventCode.UP_NOTICE, () => {
    if (intentionalDisconnect) return;
    if (typeof onSessionUp === 'function') onSessionUp();

    messageConsumer = session.createMessageConsumer({
      queueDescriptor: { name: queueName, type: solace.QueueType.QUEUE },
      acknowledgeMode: solace.MessageConsumerAcknowledgeMode.CLIENT,
      createIfMissing: false,
    });

    messageConsumer.on(solace.MessageConsumerEventName.UP, () => {
      // console.log(`[${logPrefix}] queue bound: ${queueName}`);
    });

    messageConsumer.on(solace.MessageConsumerEventName.CONNECT_FAILED_ERROR, (err) => {
      console.error(
        `[${logPrefix}] queue consumer bind failed:`,
        err && err.message ? err.message : err
      );
      notifyDisconnect();
    });

    messageConsumer.on(solace.MessageConsumerEventName.DOWN_ERROR, (err) => {
      console.warn(
        `[${logPrefix}] consumer down (error):`,
        err && err.message ? err.message : err
      );
      notifyDisconnect();
    });

    messageConsumer.on(solace.MessageConsumerEventName.MESSAGE, (message) => {
      (async () => {
        const xmlStr = messageToXmlString(message);
        if (!xmlStr) {
          message.acknowledge();
          return;
        }
        try {
          await onXml(xmlStr);
          message.acknowledge();
        } catch (err) {
          console.warn(`[${logPrefix}] message processing error:`, err.message);
        }
      })();
    });

    try {
      messageConsumer.connect();
    } catch (err) {
      console.error(`[${logPrefix}] messageConsumer.connect failed:`, err.message);
      notifyDisconnect();
    }
  });

  session.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, (sessionEvent) => {
    console.error(
      `[${logPrefix}] SMF session connect failed:`,
      sessionEvent && sessionEvent.infoStr ? sessionEvent.infoStr : sessionEvent
    );
    notifyDisconnect();
  });

  session.on(solace.SessionEventCode.DISCONNECTED, () => {
    if (intentionalDisconnect) return;
    console.warn(`[${logPrefix}] SMF session disconnected`);
    notifyDisconnect();
  });

  try {
    session.connect();
  } catch (err) {
    console.error(`[${logPrefix}] session.connect failed:`, err.message);
    notifyDisconnect();
  }

  return { disconnect };
}

module.exports = {
  connectQueueConsumer,
  messageToXmlString,
};
