'use strict';

const { parseSfdpsMessage } = require('../sfdps-parser');

const FULL_OOOI_XML = `
<fx:Flight xmlns:fx="http://www.fixm.aero/flight/4.2">
  <fx:flightIdentification>
    <fx:aircraftIdentification>UAL1340</fx:aircraftIdentification>
  </fx:flightIdentification>
  <fx:departure>
    <fx:iataDesignator>EWR</fx:iataDesignator>
    <fx:actualOffBlockTime>2026-04-05T14:00:00Z</fx:actualOffBlockTime>
    <fx:actualTakeoffTime>2026-04-05T14:18:00Z</fx:actualTakeoffTime>
  </fx:departure>
  <fx:arrival>
    <fx:iataDesignator>LAX</fx:iataDesignator>
    <fx:actualLandingTime>2026-04-05T17:30:00Z</fx:actualLandingTime>
    <fx:actualInBlockTime>2026-04-05T17:45:00Z</fx:actualInBlockTime>
  </fx:arrival>
</fx:Flight>
`;

const GATE_OUT_ONLY_XML = `
<fx:Flight xmlns:fx="http://www.fixm.aero/flight/4.2">
  <fx:flightIdentification>
    <fx:aircraftIdentification>AAL200</fx:aircraftIdentification>
  </fx:flightIdentification>
  <fx:departure>
    <fx:iataDesignator>DFW</fx:iataDesignator>
    <fx:actualOffBlockTime>2026-04-05T15:00:00Z</fx:actualOffBlockTime>
  </fx:departure>
</fx:Flight>
`;

const AIRBORNE_XML = `
<fx:Flight xmlns:fx="http://www.fixm.aero/flight/4.2">
  <fx:flightIdentification>
    <fx:aircraftIdentification>DAL500</fx:aircraftIdentification>
  </fx:flightIdentification>
  <fx:departure>
    <fx:iataDesignator>ATL</fx:iataDesignator>
    <fx:actualOffBlockTime>2026-04-05T16:00:00Z</fx:actualOffBlockTime>
    <fx:actualTakeoffTime>2026-04-05T16:20:00Z</fx:actualTakeoffTime>
  </fx:departure>
</fx:Flight>
`;

const NO_CALLSIGN_XML = `
<fx:Flight xmlns:fx="http://www.fixm.aero/flight/4.2">
  <fx:departure>
    <fx:iataDesignator>JFK</fx:iataDesignator>
    <fx:actualOffBlockTime>2026-04-05T10:00:00Z</fx:actualOffBlockTime>
  </fx:departure>
</fx:Flight>
`;

const NO_OOOI_XML = `
<fx:Flight xmlns:fx="http://www.fixm.aero/flight/4.2">
  <fx:flightIdentification>
    <fx:aircraftIdentification>UAL999</fx:aircraftIdentification>
  </fx:flightIdentification>
  <fx:departure>
    <fx:iataDesignator>SFO</fx:iataDesignator>
  </fx:departure>
</fx:Flight>
`;

/** Nested completeDateTime (common in FIXM) */
const NESTED_OOOI_XML = `
<fx:Flight xmlns:fx="http://www.fixm.aero/flight/4.2">
  <fx:flightIdentification>
    <fx:aircraftIdentification>UAL777</fx:aircraftIdentification>
  </fx:flightIdentification>
  <fx:departure>
    <fx:iataDesignator>ORD</fx:iataDesignator>
    <fx:actualOffBlockTime><fx:completeDateTime>2026-04-05T18:00:00Z</fx:completeDateTime></fx:actualOffBlockTime>
  </fx:departure>
</fx:Flight>
`;

const ESTIMATED_ONLY_XML = `
<fx:Flight xmlns:fx="http://www.fixm.aero/flight/4.2">
  <fx:flightIdentification>
    <fx:aircraftIdentification>JBU400</fx:aircraftIdentification>
  </fx:flightIdentification>
  <fx:departure>
    <fx:iataDesignator>BOS</fx:iataDesignator>
    <fx:estimatedOffBlockTime>2026-04-06T12:00:00Z</fx:estimatedOffBlockTime>
  </fx:departure>
</fx:Flight>
`;

/** FAA NAS MessageCollection / NasFlightType — attributes, lowercase <flight> */
const NAS_SURVEILLANCE_XML = `
<ns5:MessageCollection xmlns:ns5="http://www.faa.aero/nas/3.0">
  <message xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="ns5:FlightMessageType">
    <flight xsi:type="ns5:NasFlightType" centre="ZBW" source="TH" system="SLC" timestamp="2026-04-21T20:01:27.912Z">
      <arrival xsi:type="ns5:NasArrivalType" arrivalPoint="CYYZ"/>
      <departure xsi:type="ns5:NasDepartureType" departurePoint="CYHZ"/>
      <enRoute xsi:type="ns5:NasEnRouteType">
        <position xsi:type="ns5:NasAircraftPositionType" positionTime="2026-04-21T20:01:26Z" reportSource="SURVEILLANCE">
          <altitude uom="FEET">36000.0</altitude>
        </position>
      </enRoute>
      <flightIdentification xsi:type="ns5:NasFlightIdentificationType" aircraftIdentification="ACA615"/>
    </flight>
  </message>
</ns5:MessageCollection>
`;

describe('parseSfdpsMessage', () => {
  test('parses full OOOI flight and returns one event', () => {
    const events = parseSfdpsMessage(FULL_OOOI_XML);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.flight).toBe('UA1340');
    expect(e.dep_airport).toBe('EWR');
    expect(e.arr_airport).toBe('LAX');
    expect(e.gate_out).toBe('2026-04-05T14:00:00Z');
    expect(e.wheels_off).toBe('2026-04-05T14:18:00Z');
    expect(e.wheels_on).toBe('2026-04-05T17:30:00Z');
    expect(e.gate_in).toBe('2026-04-05T17:45:00Z');
    expect(e.date).toBe('2026-04-05');
  });

  test('derives status Arrived when gate_in is present', () => {
    const [event] = parseSfdpsMessage(FULL_OOOI_XML);
    expect(event.status).toBe('Arrived');
  });

  test('derives status Departed when only gate_out is present', () => {
    const events = parseSfdpsMessage(GATE_OUT_ONLY_XML);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('Departed');
    expect(events[0].flight).toBe('AA200');
  });

  test('derives status Airborne when wheels_off is present but no wheels_on or gate_in', () => {
    const events = parseSfdpsMessage(AIRBORNE_XML);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('Airborne');
    expect(events[0].flight).toBe('DL500');
  });

  test('returns empty array when callsign is missing', () => {
    expect(parseSfdpsMessage(NO_CALLSIGN_XML)).toHaveLength(0);
  });

  test('returns empty array when no OOOI times are present', () => {
    expect(parseSfdpsMessage(NO_OOOI_XML)).toHaveLength(0);
  });

  test('returns empty array for empty string', () => {
    expect(parseSfdpsMessage('')).toHaveLength(0);
  });

  test('converts ICAO callsign to IATA flight number', () => {
    const [uaEvent] = parseSfdpsMessage(FULL_OOOI_XML);
    expect(uaEvent.flight).toBe('UA1340');

    const [aaEvent] = parseSfdpsMessage(GATE_OUT_ONLY_XML);
    expect(aaEvent.flight).toBe('AA200');

    const [dlEvent] = parseSfdpsMessage(AIRBORNE_XML);
    expect(dlEvent.flight).toBe('DL500');
  });

  test('date is derived from earliest OOOI time', () => {
    const [event] = parseSfdpsMessage(FULL_OOOI_XML);
    expect(event.date).toBe('2026-04-05');
  });

  test('parses nested completeDateTime under actualOffBlockTime', () => {
    const events = parseSfdpsMessage(NESTED_OOOI_XML);
    expect(events).toHaveLength(1);
    expect(events[0].flight).toBe('UA777');
    expect(events[0].gate_out).toBe('2026-04-05T18:00:00Z');
    expect(events[0].status).toBe('Departed');
    expect(events[0].dep_airport).toBe('ORD');
  });

  test('parses estimated-only flight and sets status Scheduled', () => {
    const events = parseSfdpsMessage(ESTIMATED_ONLY_XML);
    expect(events).toHaveLength(1);
    expect(events[0].flight).toBe('B6400');
    expect(events[0].gate_out).toBe('2026-04-06T12:00:00Z');
    expect(events[0].status).toBe('Scheduled');
    expect(events[0].date).toBe('2026-04-06');
  });

  test('parses NAS MessageCollection: attribute callsign, departurePoint/arrivalPoint, surveillance time', () => {
    const events = parseSfdpsMessage(NAS_SURVEILLANCE_XML);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.flight).toBe('AC615');
    expect(e.dep_airport).toBe('YHZ');
    expect(e.arr_airport).toBe('YYZ');
    expect(e.status).toBe('Airborne');
    expect(e.wheels_off).toBe('2026-04-21T20:01:26Z');
    expect(e.date).toBe('2026-04-21');
  });
});
