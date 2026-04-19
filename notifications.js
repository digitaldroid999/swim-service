// Crew Assist SWIM Service — Push Notifications
// Sends VAPID web push when a watched flight changes status.
// Reads push subscriptions from Netlify Blobs (same store push_subscribe.js writes to).

const webpush = require('web-push');
const https   = require('https');
const config  = require('./config');
const db      = require('./db');

// Configure VAPID once at startup
let vapidReady = false;
function initVapid() {
  if (!config.vapid.publicKey || !config.vapid.privateKey) {
    console.warn('[push] VAPID keys not set — push notifications disabled');
    return;
  }
  webpush.setVapidDetails(
    config.vapid.subject,
    config.vapid.publicKey,
    config.vapid.privateKey,
  );
  vapidReady = true;
  console.log('[push] VAPID ready');
}

// Called by index.js whenever a flight event is saved and status changed.
// Looks up watchers for this flight and sends pushes if status changed.
async function notifyWatchers(event, previousStatus) {
  if (!vapidReady) return;
  if (event.status === previousStatus) return;
  if (!event.flight || !event.date) return;

  // Only push for meaningful status transitions
  const notifyStatuses = ['Taxiing', 'Departed', 'Landing', 'Arrived', 'Cancelled', 'Diverted'];
  if (!notifyStatuses.includes(event.status)) return;

  const watches = db.getWatchesForFlight(event.flight, event.date);
  if (!watches.length) return;

  const payload = buildPayload(event);

  for (const watch of watches) {
    // Don't re-notify for the same status
    if (watch.last_notified === event.status) continue;

    try {
      const sub = await getSubscription(watch.user_email);
      if (!sub) continue;

      await webpush.sendNotification(sub, JSON.stringify(payload));
      db.updateWatchNotified(watch.id, event.status);
      console.log(`[push] sent ${event.status} for ${event.flight} to ${watch.user_email}`);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expired — nothing to do, Netlify side will clean up
        console.log(`[push] expired subscription for ${watch.user_email}`);
      } else {
        console.warn(`[push] send error for ${watch.user_email}:`, err.message);
      }
    }
  }
}

function buildPayload(event) {
  const statusEmoji = {
    Taxiing:   '🛫',
    Departed:  '✈️',
    Landing:   '🛬',
    Arrived:   '🏁',
    Cancelled: '❌',
    Diverted:  '⚠️',
  };
  const emoji = statusEmoji[event.status] || '✈️';
  const route = [event.dep_airport, event.arr_airport].filter(Boolean).join(' → ');

  let body = `${event.status}`;
  if (route) body += ` · ${route}`;
  if (event.status === 'Departed' && event.dep_delay_min > 0)
    body += ` (${event.dep_delay_min} min late)`;
  if (event.status === 'Arrived' && event.arr_delay_min > 0)
    body += ` (${event.arr_delay_min} min late)`;
  if (event.status === 'Arrived' && event.arr_gate)
    body += ` · Gate ${event.arr_gate}`;

  return {
    title: `${emoji} ${event.flight}`,
    body,
    data: {
      flight:     event.flight,
      date:       event.date,
      status:     event.status,
      dep:        event.dep_airport,
      arr:        event.arr_airport,
      gate_out:   event.gate_out,
      wheels_off: event.wheels_off,
      wheels_on:  event.wheels_on,
      gate_in:    event.gate_in,
      dep_gate:   event.dep_gate,
      arr_gate:   event.arr_gate,
      dep_delay:  event.dep_delay_min,
      arr_delay:  event.arr_delay_min,
    },
    url: 'https://flightcrewassist.com/app.html',
  };
}

// Fetch push subscription from Netlify Blobs REST API
async function getSubscription(userEmail) {
  const { token, siteId } = config.netlify;
  if (!token || !siteId) return null;

  return new Promise((resolve) => {
    const url = `https://api.netlify.com/api/v1/sites/${siteId}/blobs/push-subscriptions/${encodeURIComponent(userEmail)}`;
    const req = https.get(url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.subscription || null);
          } catch { resolve(null); }
        } else {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
  });
}

module.exports = { initVapid, notifyWatchers };
