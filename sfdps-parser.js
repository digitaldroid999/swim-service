// Crew Assist SWIM Service — SFDPS FIXM Parser
//
// FAA SFDPS provides FIXM 4.2 + NAS-extension XML messages with actual
// OOOI (Out/Off/On/In) gate and runway times for NAS flights.
//
// Key elements we extract (namespace-agnostic regex):
//   aircraftIdentification  → ICAO callsign e.g. "UAL1340"
//   iataDesignator          → IATA airport code (under departure/arrival)
//   actualOffBlockTime      → OUT  (gate pushback)
//   actualTakeoffTime       → OFF  (wheels up)
//   actualLandingTime       → ON   (touchdown)
//   actualInBlockTime       → IN   (at gate)
//
// We log the first few raw messages so the format can be verified.

// ── ICAO airline (3-letter) → IATA (2-letter) ────────────────────────────────
const AIRLINE = {
  UAL:'UA', AAL:'AA', DAL:'DL', SWA:'WN', ASA:'AS', JBU:'B6',
  FFT:'F9', NKS:'NK', HAL:'HA', SUN:'SY', VRD:'VX',
  SKW:'OO', ENY:'9E', AWI:'ZW', RPA:'YX', PDT:'OE', QXE:'QX',
  MES:'YV', CPZ:'C5', GJS:'G7', EGF:'AA', FLG:'AA', SQA:'UA',
  UAX:'UA', TSC:'UA', CHQ:'WN', TRS:'WN', SWQ:'WN', SPR:'NK',
  GTI:'GT', FDX:'FX', UPS:'5X', ABX:'GB', ATN:'8C', NCB:'N8',
  ACA:'AC', WJA:'WS', TCA:'TS', JZA:'QK',
  AMX:'AM', VIV:'Y4', TAI:'TA',
  BWA:'BW', CMP:'CM', LRC:'LR', TAB:'TA', HAV:'CU',
  AVA:'AV', TAM:'JJ', LAN:'LA', GLO:'G3', AZU:'AD',
  ARG:'AR', LAT:'LA', PUA:'PU', AEA:'A6',
  BAW:'BA', VIR:'VS', KLM:'KL', AFR:'AF', DLH:'LH',
  SWR:'LX', AUA:'OS', IBE:'IB', EIN:'EI', AZA:'AZ',
  TAP:'TP', FIN:'AY', SAS:'SK', NAX:'DY', VLG:'VY',
  EZY:'U2', RYR:'FR', TUI:'X3', CTN:'OU', CSA:'OK',
  LOT:'LO', MAL:'MP', WZZ:'W6', BEL:'SN', VKG:'DY',
  UAE:'EK', ETD:'EY', QTR:'QR', THY:'TK', ELY:'LY',
  RJA:'RJ', GFA:'GF', OMA:'WY', KAC:'KU', MSR:'MS',
  SVA:'SV', MEA:'ME', IAW:'IA',
  ETH:'ET', KQA:'KQ', SAA:'SA', CAW:'WB', RWD:'WB',
  ANA:'NH', JAL:'JL', SIA:'SQ', MAS:'MH', THA:'TG',
  VNA:'VN', PAL:'PR', CPA:'CX', CSN:'CZ', CCA:'CA',
  CES:'MU', KAL:'KE', AAR:'OZ', AIC:'AI', TGW:'VZ',
  QFA:'QF', ANZ:'NZ', VAU:'VA',
};

// Convert ICAO callsign → IATA  e.g. "UAL1340" → "UA1340"
function icaoToIata(callsign) {
  if (!callsign) return null;
  const cs = callsign.trim().toUpperCase();
  // Try 3-letter prefix
  const prefix3 = cs.slice(0, 3);
  if (AIRLINE[prefix3]) return AIRLINE[prefix3] + cs.slice(3);
  // Try 2-letter prefix (already IATA)
  const prefix2 = cs.slice(0, 2);
  const num = cs.slice(2);
  if (/^\d+/.test(num)) return cs; // already looks like IATA
  return cs;
}

// ── Raw message debug log (first N messages) ─────────────────────────────────
let _rawLogCount = 0;
const RAW_LOG_MAX = 5;

// ── Namespace-agnostic XML helpers ────────────────────────────────────────────
//
// All three helpers use `<(?:[^>\s:]*:)?${localName}` to open-tag match.
// The namespace-prefix group `(?:[^>\s:]*:)?` stops at the first colon, so
// localName must match exactly the local part of the element name — no suffix
// matching. For example getEl(xml,'ON') will NOT match <fx:aircraftIdentification>.

// Get the text content of the first matching element (any namespace prefix)
function getEl(xml, localName) {
  const re = new RegExp(`<(?:[^>\\s:]*:)?${localName}(?:\\s[^>]*)?>\\s*([^<\\s][^<]*?)\\s*<`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

// Get attribute value from first matching element
function getAttr(xml, localName, attrName) {
  const re = new RegExp(`<(?:[^>\\s:]*:)?${localName}(?:\\s[^>]*)?\\s${attrName}="([^"]*)"`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

// Extract a block of XML between opening/closing tags (namespace-agnostic)
function getBlock(xml, localName) {
  const open  = new RegExp(`<(?:[^>\\s:]*:)?${localName}[\\s>]`, 'i');
  const start = xml.search(open);
  if (start === -1) return null;
  // Find the tag name actually used (with its prefix)
  const tagMatch = xml.slice(start).match(/^<([^\s>]+)/);
  if (!tagMatch) return null;
  const tagName = tagMatch[1];
  const closeTag = `</${tagName}>`;
  const end = xml.indexOf(closeTag, start);
  if (end === -1) return null;
  return xml.slice(start, end + closeTag.length);
}

/** Keep original token if it parses as a date (FIXM allows slight format variants) */
function normalizeIsoFragment(s) {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) return null;
  return t;
}

/**
 * FIXM often nests timestamps, e.g.
 *   <actualOffBlockTime><completeDateTime>2026-04-05T14:00:00Z</completeDateTime></actualOffBlockTime>
 * or uses attributes: dateTime="..." / time="..."
 * Direct text body is also supported (legacy tests).
 */
function getIsoTime(xml, localName) {
  const direct = getEl(xml, localName);
  const n = normalizeIsoFragment(direct || '');
  if (n && !Number.isNaN(Date.parse(n))) return n;

  const block = getBlock(xml, localName);
  if (block) {
    const inner =
      getEl(block, 'completeDateTime')
      || getEl(block, 'dateTime')
      || getEl(block, 'timestamp')
      || getEl(block, 'timeValue')
      || getEl(block, 'characterString');
    const n2 = normalizeIsoFragment(inner || '');
    if (n2 && !Number.isNaN(Date.parse(n2))) return n2;

    const attrT =
      getAttr(block, localName, 'dateTime')
      || getAttr(block, localName, 'time')
      || getAttr(block, 'AbstractTime', 'dateTime');
    const n3 = normalizeIsoFragment(attrT || '');
    if (n3 && !Number.isNaN(Date.parse(n3))) return n3;
  }

  const onOpen =
    getAttr(xml, localName, 'dateTime')
    || getAttr(xml, localName, 'time')
    || getAttr(xml, localName, 'timeValue');
  const n4 = normalizeIsoFragment(onOpen || '');
  if (n4 && !Number.isNaN(Date.parse(n4))) return n4;

  const selfClose = new RegExp(
    `<(?:[^>\\s:]*:)?${localName}[^>]*?(?:dateTime|time|timeValue)="([^"]+)"[^>]*/\\s*>`,
    'i'
  );
  const m = xml.match(selfClose);
  if (m) {
    const n5 = normalizeIsoFragment(m[1]);
    if (n5 && !Number.isNaN(Date.parse(n5))) return n5;
  }
  return null;
}

// ── Date helper ───────────────────────────────────────────────────────────────
// Derive YYYY-MM-DD from an ISO UTC string (used as the "date" key in the DB)
function utcDate(isoStr) {
  if (!isoStr) return null;
  try {
    return new Date(isoStr).toISOString().slice(0, 10);
  } catch { return null; }
}

// ── Main parse function ───────────────────────────────────────────────────────
function parseSfdpsMessage(xmlStr) {

  console.log(`[SFDPS] parsing message : ${xmlStr}`);
  
  // Log first few raw messages for format verification
  if (_rawLogCount < RAW_LOG_MAX) {
    _rawLogCount++;
    console.log(`[sfdps] RAW MESSAGE #${_rawLogCount}:\n`, xmlStr.slice(0, 2000));
  }

  const results = [];

  // SFDPS may wrap multiple flight records — split on <fx:Flight> or <nas:Flight>
  // Try to find all Flight blocks; fall back to treating the whole message as one
  const flightRe = /<[^>\s]*:?Flight[\s>]/gi;
  let match;
  const positions = [];
  while ((match = flightRe.exec(xmlStr)) !== null) {
    positions.push(match.index);
  }

  // Build list of XML blocks to parse
  let blocks = [];
  if (positions.length === 0) {
    blocks = [xmlStr]; // no Flight tag — try whole message
  } else {
    for (let i = 0; i < positions.length; i++) {
      const start = positions[i];
      const end   = i + 1 < positions.length ? positions[i + 1] : xmlStr.length;
      blocks.push(xmlStr.slice(start, end));
    }
  }

  for (const block of blocks) {
    const event = parseFlight(block);
    if (event) results.push(event);
  }

  if (
    results.length === 0 &&
    /^(1|true|yes|on)$/i.test(String(process.env.SWIM_LOG_SFDPS_ZERO || '').trim())
  ) {
    const hasId =
      /aircraftIdentification/i.test(xmlStr) || /<\s*[^:>\s]+:aircraftIdentification\b/i.test(xmlStr);
    const hasTime = /actualOffBlockTime|completeDateTime|estimatedOffBlockTime|dateTime="/i.test(
      xmlStr
    );
    console.log(
      `[sfdps] parse yielded 0 events — xmlLen=${xmlStr.length} aircraftId-ish=${hasId} time-ish=${hasTime}`
    );
  }

  return results;
}

function parseFlight(xml) {
  // ── Flight identification ──────────────────────────────────────────────────
  // FIXM: <fx:flightIdentification><fx:aircraftIdentification>UAL1340</...>
  const icaoCallsign =
    getEl(xml, 'aircraftIdentification')
    || getEl(xml, 'aircraftId')
    || getEl(xml, 'callsign');
  if (!icaoCallsign) return null; // can't identify without callsign

  const flight = icaoToIata(icaoCallsign);
  if (!flight) return null;

  // ── Airport codes ──────────────────────────────────────────────────────────
  // Look for iataDesignator inside departure/arrival blocks
  const depBlock = getBlock(xml, 'departure');
  const arrBlock = getBlock(xml, 'arrival');

  let depAirport = depBlock ? getEl(depBlock, 'iataDesignator') : null;
  let arrAirport = arrBlock ? getEl(arrBlock, 'iataDesignator') : null;

  // Also try icaoDesignator and strip K prefix for US airports
  if (!depAirport && depBlock) {
    const icao = getEl(depBlock, 'icaoDesignator') || getEl(depBlock, 'aerodrome');
    if (icao && icao.length === 4 && icao[0] === 'K') depAirport = icao.slice(1);
    else if (icao && icao.length === 3) depAirport = icao;
  }
  if (!arrAirport && arrBlock) {
    const icao = getEl(arrBlock, 'icaoDesignator') || getEl(arrBlock, 'aerodrome');
    if (icao && icao.length === 4 && icao[0] === 'K') arrAirport = icao.slice(1);
    else if (icao && icao.length === 3) arrAirport = icao;
  }

  // ── OOOI times (actual) ────────────────────────────────────────────────────
  const gateOut =
    getIsoTime(xml, 'actualOffBlockTime')
    || getIsoTime(xml, 'gateOutTime')
    || getIsoTime(xml, 'OUT');

  const wheelsOff =
    getIsoTime(xml, 'actualTakeoffTime')
    || getIsoTime(xml, 'wheelsOffTime')
    || getIsoTime(xml, 'OFF');

  const wheelsOn =
    getIsoTime(xml, 'actualLandingTime')
    || getIsoTime(xml, 'wheelsOnTime')
    || getIsoTime(xml, 'ON');

  const gateIn =
    getIsoTime(xml, 'actualInBlockTime')
    || getIsoTime(xml, 'gateInTime')
    || getIsoTime(xml, 'IN');

  // Estimated / filed times when no actuals yet (common on first SFDPS updates)
  let gateOutE =
    getIsoTime(xml, 'estimatedOffBlockTime')
    || getIsoTime(xml, 'scheduledOffBlockTime')
    || getIsoTime(xml, 'coordinatedOffBlockTime');
  let wheelsOffE =
    getIsoTime(xml, 'estimatedTakeoffTime')
    || getIsoTime(xml, 'scheduledTakeOffTime')
    || getIsoTime(xml, 'scheduledTakeoffTime');
  let wheelsOnE =
    getIsoTime(xml, 'estimatedLandingTime')
    || getIsoTime(xml, 'scheduledLandingTime');
  let gateInE =
    getIsoTime(xml, 'estimatedInBlockTime')
    || getIsoTime(xml, 'scheduledInBlockTime');

  // Use actual when present, else estimated for each field stored in DB
  const gateOutFinal = gateOut || gateOutE;
  const wheelsOffFinal = wheelsOff || wheelsOffE;
  const wheelsOnFinal = wheelsOn || wheelsOnE;
  const gateInFinal = gateIn || gateInE;

  // Must have at least one usable time (actual or estimated) to persist
  if (!gateOutFinal && !wheelsOffFinal && !wheelsOnFinal && !gateInFinal) {
    if (_rawLogCount <= RAW_LOG_MAX) {
      console.log('[sfdps] no actual/estimated OOOI times in block, callsign:', icaoCallsign);
    }
    return null;
  }

  // ── Derive status (actual OOOI drives lifecycle; estimated-only → Scheduled) ──
  let status = 'Scheduled';
  if (gateIn || wheelsOn) status = 'Arrived';
  else if (wheelsOff) status = 'Airborne';
  else if (gateOut) status = 'Departed';

  // ── Derive date key: earliest time among stored fields ─────────────────────
  function earliestIsoString(vals) {
    const parsed = vals
      .filter(Boolean)
      .map((v) => ({ v, t: Date.parse(v) }))
      .filter((x) => !Number.isNaN(x.t));
    if (!parsed.length) return null;
    parsed.sort((a, b) => a.t - b.t);
    return parsed[0].v;
  }

  const dateBasis = earliestIsoString([
    gateOutFinal,
    wheelsOffFinal,
    wheelsOnFinal,
    gateInFinal,
  ]);
  const dateStr = utcDate(dateBasis);
  if (!dateStr) return null;

  console.log(
    `[sfdps] ${flight} ${depAirport || '???'}→${arrAirport || '???'} OUT:${gateOutFinal || '-'} OFF:${wheelsOffFinal || '-'} ON:${wheelsOnFinal || '-'} IN:${gateInFinal || '-'}`
  );

  return {
    flight,
    date: dateStr,
    dep_airport: depAirport || null,
    arr_airport: arrAirport || null,
    status,
    gate_out: gateOutFinal || null,
    wheels_off: wheelsOffFinal || null,
    wheels_on: wheelsOnFinal || null,
    gate_in: gateInFinal || null,
    raw_xml: xml.slice(0, 4000),
  };
}

module.exports = { parseSfdpsMessage };
