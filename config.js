'use strict';

// All secrets from environment variables (set in .env on the server)
require('dotenv').config();

function parseTrustStores(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function numOr(v, def) {
  if (v === undefined || v === '') return def;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : def;
}

function swimBlockFromEnv(prefix, defaults) {
  const urlKey = `${prefix}_URL`;
  const url = (process.env[urlKey] || '').trim();

  const sslTrustRaw = process.env[`${prefix}_SSL_TRUST_STORES`];
  const sslTrustStores =
    sslTrustRaw != null && String(sslTrustRaw).length
      ? parseTrustStores(sslTrustRaw)
      : [];

  const sslVal = process.env[`${prefix}_SSL_VALIDATE_CERTIFICATE`];
  const sslValidateCertificate =
    sslVal === undefined || sslVal === '' ? undefined : String(sslVal).toLowerCase() === 'true';

  const reconnectRaw = process.env[`${prefix}_RECONNECT_RETRIES`];
  const reconnectRetries =
    reconnectRaw === undefined || reconnectRaw === '' ? -1 : numOr(reconnectRaw, -1);

  return {
    url,
    host: process.env[`${prefix}_HOST`] || defaults.host,
    port: numOr(process.env[`${prefix}_PORT`], defaults.port),
    username: process.env[`${prefix}_USERNAME`] || '',
    password: process.env[`${prefix}_PASSWORD`] || '',
    queue: process.env[`${prefix}_QUEUE`] || '',
    vpn: process.env[`${prefix}_VPN`] || defaults.vpn,
    clientName: (process.env[`${prefix}_CLIENT_NAME`] || defaults.clientName || '').trim(),
    reconnectRetries,
    sslValidateCertificate,
    sslTrustStores: sslTrustStores.length ? sslTrustStores : undefined,
  };
}

module.exports = {
  swim: swimBlockFromEnv('SWIM', {
    host: 'scds.swim.faa.gov',
    port: 5671,
    vpn: 'TFMS',
    clientName: 'ca-swim-tfmdata',
  }),

  sfdps: swimBlockFromEnv('SWIM_SFDPS', {
    host: 'ems2.swim.faa.gov',
    port: 5671,
    vpn: 'FDPS',
    clientName: 'ca-swim-sfdps',
  }),

  api: {
    port: parseInt(process.env.API_PORT || '3000', 10),
    secret: process.env.API_SECRET || 'change-this-secret',
    /** Set API_LOG=1 to log each /flight and /watch request (and errors always go to stderr). */
    log: /^(1|true|yes)$/i.test(String(process.env.API_LOG || '').trim()),
  },

  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || 'mailto:support@crewassistapp.com',
  },

  db: {
    path: process.env.DB_PATH || './data/swim.db',
  },

  netlify: {
    token: process.env.NETLIFY_TOKEN || '',
    siteId: process.env.NETLIFY_SITE_ID || '',
  },
};
