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

function envTruthy(name) {
  const v = process.env[name];
  if (v === undefined || v === '') return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/** UTF-8 decode binary attachment (Solace may return Buffer, Uint8Array, or string). */
function binaryToUtf8(bin) {
  if (bin == null) return '';
  if (typeof bin === 'string') {
    if (bin.includes('<')) return bin;
    return Buffer.from(bin, 'latin1').toString('utf8');
  }
  if (Buffer.isBuffer(bin)) return bin.toString('utf8');
  if (bin instanceof Uint8Array) return Buffer.from(bin).toString('utf8');
  if (Array.isArray(bin)) {
    return Buffer.concat(bin.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x)))).toString('utf8');
  }
  return String(bin);
}

/**
 * Recursively pull string values from SDT MAP (nested FIXM in SDT form).
 */
function sdtContainerToPossibleXml(sdtField) {
  if (!sdtField || !solace.SDTFieldType) return '';
  try {
    const t = sdtField.getType && sdtField.getType();
    const val = typeof sdtField.getValue === 'function' ? sdtField.getValue() : null;

    if (t === solace.SDTFieldType.STRING || t === solace.SDTFieldType.WSTRING) {
      return val != null ? String(val) : '';
    }

    if (t === solace.SDTFieldType.MAP && val && typeof val.getKeys === 'function') {
      let longest = '';
      for (const k of val.getKeys()) {
        const f = val.getField(k);
        const got = sdtContainerToPossibleXml(f);
        if (got.length > longest.length) longest = got;
      }
      return longest;
    }
  } catch {
    /* ignore */
  }
  return '';
}

/**
 * Extract XML/text body from Solace SMF message.
 * FAA FIXM often arrives as SMF XML_PAYLOAD → getXmlContent(), NOT getBinaryAttachment().
 * For MessageType.BINARY, getSdtContainer() returns null by API design unless you skip to structured parse; we try XML + binary + MAP/STREAM SDT.
 */
function messageBodyToString(message) {
  const parts = [];

  // 1) SMF XML chunk (most common for SWIM/FIXM over Solace)
  try {
    if (typeof message.getXmlContent === 'function') {
      const xml = message.getXmlContent();
      if (xml) parts.push(String(xml));
    }
  } catch {
    /* continue */
  }

  try {
    if (typeof message.getXmlContentDecoded === 'function') {
      const xml = message.getXmlContentDecoded();
      if (xml) parts.push(String(xml));
    }
  } catch {
    /* continue */
  }

  // 2) TEXT + SDT string
  try {
    if (message.getType() === solace.MessageType.TEXT) {
      const sdt = message.getSdtContainer();
      if (sdt && typeof sdt.getValue === 'function') {
        const v = sdt.getValue();
        if (v != null) parts.push(String(v));
      }
    }
  } catch {
    /* continue */
  }

  // 3) Binary attachment
  try {
    const bin = message.getBinaryAttachment();
    if (bin != null) {
      const txt = binaryToUtf8(bin);
      if (txt) parts.push(txt);
    }
  } catch {
    /* ignore */
  }

  // 4) MAP / STREAM / non-BINARY SDT (getSdtContainer may work when type is MAP|STREAM|TEXT)
  try {
    const msgType = message.getType();
    if (
      msgType === solace.MessageType.MAP ||
      msgType === solace.MessageType.STREAM ||
      msgType === solace.MessageType.TEXT
    ) {
      const sdt = message.getSdtContainer && message.getSdtContainer();
      if (sdt) {
        if (typeof sdt.getValue === 'function') {
          const v = sdt.getValue();
          if (v != null) parts.push(String(v));
        }
        const nested = sdtContainerToPossibleXml(sdt);
        if (nested) parts.push(nested);
      }
    }
  } catch {
    /* ignore */
  }

  const best = parts.filter(Boolean).sort((a, b) => b.length - a.length)[0] || '';
  return best.trim() ? best : '';
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
  let inboundSeq = 0;
  let emptyBodyWarnCount = 0;

  const logInbound = envTruthy('SWIM_LOG_SMF_INBOUND') || envTruthy('SWIM_LOG_PRE_SAVE');

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
        windowSize: 255,
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
          inboundSeq += 1;
          const msgType = message.getType();
          const xmlStr = messageBodyToString(message);

          if (logInbound) {
            let attachHint = 'none';
            try {
              const b = message.getBinaryAttachment();
              if (b != null) {
                if (typeof b === 'string') attachHint = `string len=${b.length}`;
                else if (Buffer.isBuffer(b)) attachHint = `buffer len=${b.length}`;
                else if (b instanceof Uint8Array) attachHint = `uint8 len=${b.length}`;
                else attachHint = typeof b;
              }
            } catch {
              attachHint = 'err';
            }
            let xmlHint = 0;
            try {
              if (typeof message.getXmlContent === 'function') {
                const x = message.getXmlContent();
                xmlHint = x ? String(x).length : 0;
              }
            } catch {
              xmlHint = -1;
            }
            console.log(
              `${logPrefix} SMF MESSAGE #${inboundSeq} type=${msgType} bodyChars=${xmlStr.length} ` +
                `xmlContent=${xmlHint} binaryAttachment=${attachHint}`
            );
          }

          if (!xmlStr) {
            if (emptyBodyWarnCount < 5) {
              emptyBodyWarnCount += 1;
              console.warn(
                `${logPrefix} SMF MESSAGE #${inboundSeq}: empty body after extraction — type=${msgType}.` +
                  ` Queue depth on the portal can still apply if another consumer shares this queue,` +
                  ` or FIXM is in an unexpected field/encoding.`
              );
            }
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
