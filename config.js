// Crew Assist SWIM Service — Configuration
// All secrets loaded from environment variables (set in .env on the server)
require('dotenv').config();

module.exports = {
  // ── FAA SWIM TFMData credentials ─────────────────────────────────────────
  // TFMData: scheduled times, status, track position
  swim: {
    host:     process.env.SWIM_HOST     || 'scds.swim.faa.gov',
    port:     parseInt(process.env.SWIM_PORT || '5671'),   // AMQPS (TLS)
    username: process.env.SWIM_USERNAME || '',
    password: process.env.SWIM_PASSWORD || '',
    queue:    process.env.SWIM_QUEUE    || '',
  },

  // ── FAA SWIM SFDPS credentials ────────────────────────────────────────────
  // SFDPS (FIXM): actual OOOI gate-out/wheels-off/wheels-on/gate-in times
  sfdps: {
    host:     process.env.SWIM_SFDPS_HOST     || 'ems2.swim.faa.gov',
    port:     parseInt(process.env.SWIM_SFDPS_PORT || '5671'),  // AMQP TLS
    vpn:      process.env.SWIM_SFDPS_VPN      || 'FDPS',
    username: process.env.SWIM_SFDPS_USERNAME || '',
    password: process.env.SWIM_SFDPS_PASSWORD || '',
    queue:    process.env.SWIM_SFDPS_QUEUE    || '',
  },

  // ── API server ────────────────────────────────────────────────────────────
  api: {
    port:   parseInt(process.env.API_PORT || '3000'),
    secret: process.env.API_SECRET || 'change-this-secret',   // Netlify functions use this
  },

  // ── VAPID push notifications ──────────────────────────────────────────────
  vapid: {
    publicKey:  process.env.VAPID_PUBLIC_KEY  || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject:    process.env.VAPID_SUBJECT     || 'mailto:support@crewassistapp.com',
  },

  // ── Database ──────────────────────────────────────────────────────────────
  db: {
    path: process.env.DB_PATH || './data/swim.db',
  },

  // ── Netlify blob store (to read push subscriptions saved by the app) ──────
  netlify: {
    token:  process.env.NETLIFY_TOKEN  || '',
    siteId: process.env.NETLIFY_SITE_ID || '',
  },
};
