'use strict';

/**
 * Same routing as swim-node-consumer / Java Consumer: AMQP vs Solace SMF by URL scheme.
 */

function schemeOf(urlString) {
  if (!urlString || typeof urlString !== 'string') return '';
  try {
    return new URL(urlString.trim()).protocol.replace(/:$/, '').toLowerCase();
  } catch {
    return '';
  }
}

/** @returns {'amqp-legacy' | 'amqp-url' | 'smf' | 'unknown'} */
function brokerKind(providerUrl, hasLegacyHost) {
  const s = schemeOf(providerUrl);
  if (s === 'amqp' || s === 'amqps') return 'amqp-url';
  if (s === 'tcps' || s === 'tcp' || s === 'wss' || s === 'ws') return 'smf';
  if (s) return 'unknown';
  if (hasLegacyHost) return 'amqp-legacy';
  return 'unknown';
}

module.exports = {
  schemeOf,
  brokerKind,
};
