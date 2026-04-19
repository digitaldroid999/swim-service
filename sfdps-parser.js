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

  return results;
}

function parseFlight(xml) {
  // ── Flight identification ──────────────────────────────────────────────────
  // FIXM: <fx:flightIdentification><fx:aircraftIdentification>UAL1340</...>
  const icaoCallsign = getEl(xml, 'aircraftIdentification');
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

  // ── OOOI times ────────────────────────────────────────────────────────────
  // OUT: gate pushback
  const gateOut  = getEl(xml, 'actualOffBlockTime')
                || getEl(xml, 'gateOutTime')
                || getEl(xml, 'OUT');

  // OFF: wheels up
  const wheelsOff = getEl(xml, 'actualTakeoffTime')
                 || getEl(xml, 'wheelsOffTime')
                 || getEl(xml, 'OFF');

  // ON: touchdown
  const wheelsOn  = getEl(xml, 'actualLandingTime')
                 || getEl(xml, 'wheelsOnTime')
                 || getEl(xml, 'ON');

  // IN: at gate
  const gateIn   = getEl(xml, 'actualInBlockTime')
                || getEl(xml, 'gateInTime')
                || getEl(xml, 'IN');

  // Must have at least one OOOI time to be worth saving
  if (!gateOut && !wheelsOff && !wheelsOn && !gateIn) {
    // Log first few non-matching blocks so we can check format
    if (_rawLogCount <= RAW_LOG_MAX) {
      console.log('[sfdps] no OOOI times found in block, callsign:', icaoCallsign);
    }
    return null;
  }

  // ── Derive status ─────────────────────────────────────────────────────────
  let status = null;
  if (gateIn || wheelsOn) status = 'Arrived';
  else if (wheelsOff)     status = 'Airborne';
  else if (gateOut)       status = 'Departed';

  // ── Derive date key ───────────────────────────────────────────────────────
  // Use UTC date of earliest OOOI time as the DB key
  const oooi = [gateOut, wheelsOff, wheelsOn, gateIn].filter(Boolean);
  const dateStr = utcDate(oooi[0]);
  if (!dateStr) return null;

  console.log(`[sfdps] ${flight} ${depAirport||'???'}→${arrAirport||'???'} OUT:${gateOut||'-'} OFF:${wheelsOff||'-'} ON:${wheelsOn||'-'} IN:${gateIn||'-'}`);

  return {
    flight,
    date:        dateStr,
    dep_airport: depAirport  || null,
    arr_airport: arrAirport  || null,
    status,
    gate_out:    gateOut     || null,
    wheels_off:  wheelsOff   || null,
    wheels_on:   wheelsOn    || null,
    gate_in:     gateIn      || null,
    raw_xml:     xml.slice(0, 4000),  // store first 4k for debug
  };
}

module.exports = { parseSfdpsMessage };
