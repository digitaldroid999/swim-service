'use strict';

const { parseTfmMessage } = require('../parser');

const TRACK_XML = `
<fltdOutput>
  <fdm:fltdMessage acid="UAL440" depArpt="KEWR" arrArpt="KLAX"
    msgType="trackInformation" sourceTimeStamp="2026-04-05T19:22:00Z">
    <nxce:igtd>2026-04-05T19:22:00Z</nxce:igtd>
    <nxcm:eta etaType="ESTIMATED" timeValue="2026-04-05T21:53:02Z"/>
    <nxcm:speed>298</nxcm:speed>
    <nxce:simpleAltitude>280</nxce:simpleAltitude>
    <nxce:latitudeDMS degrees="33" direction="NORTH" minutes="51" seconds="02"/>
    <nxce:longitudeDMS degrees="084" direction="WEST" minutes="35" seconds="00"/>
  </fdm:fltdMessage>
</fltdOutput>
`;

const FLIGHT_CREATE_XML = `
<fltdOutput>
  <fdm:fltdMessage acid="DAL300" depArpt="KATL" arrArpt="KJFK"
    msgType="flightCreate" sourceTimeStamp="2026-04-05T10:00:00Z">
    <nxce:igtd>2026-04-06T14:00:00Z</nxce:igtd>
  </fdm:fltdMessage>
</fltdOutput>
`;

const CANCELLATION_XML = `
<fltdOutput>
  <fdm:fltdMessage acid="SWA100" depArpt="KMDW" arrArpt="KORD"
    msgType="cancellation" sourceTimeStamp="2026-04-05T09:00:00Z">
    <nxce:igtd>2026-04-05T09:30:00Z</nxce:igtd>
  </fdm:fltdMessage>
</fltdOutput>
`;

const GA_TAIL_XML = `
<fltdOutput>
  <fdm:fltdMessage acid="N12345" depArpt="KBOS" arrArpt="KJFK"
    msgType="trackInformation" sourceTimeStamp="2026-04-05T12:00:00Z">
    <nxce:igtd>2026-04-05T12:00:00Z</nxce:igtd>
  </fdm:fltdMessage>
</fltdOutput>
`;

const FLIGHT_MODIFY_XML = `
<fltdOutput>
  <fdm:fltdMessage acid="QXE2077" airline="QXE" arrArpt="KSEA" depArpt="KBOI"
    fdTrigger="FD_FLIGHT_MODIFY_MSG" flightRef="144749879" major="ASA"
    msgType="FlightModify" sourceTimeStamp="2026-04-21T18:15:01Z">
    <fdm:ncsmFlightModify>
      <nxcm:qualifiedAircraftId aircraftCategory="JET" userCategory="AIR TAXI">
        <nxce:aircraftId>QXE2077</nxce:aircraftId>
        <nxce:igtd>2026-04-21T22:15:00Z</nxce:igtd>
        <nxce:departurePoint><nxce:airport>KBOI</nxce:airport></nxce:departurePoint>
        <nxce:arrivalPoint><nxce:airport>KSEA</nxce:airport></nxce:arrivalPoint>
      </nxcm:qualifiedAircraftId>
      <nxcm:airlineData>
        <nxcm:flightStatusAndSpec><nxcm:flightStatus>PLANNED</nxcm:flightStatus></nxcm:flightStatusAndSpec>
      </nxcm:airlineData>
    </fdm:ncsmFlightModify>
  </fdm:fltdMessage>
</fltdOutput>
`;

const MULTI_MSG_XML = `
<fltdOutput>
  <fdm:fltdMessage acid="UAL440" depArpt="KEWR" arrArpt="KLAX"
    msgType="trackInformation" sourceTimeStamp="2026-04-05T19:22:00Z">
    <nxce:igtd>2026-04-05T19:22:00Z</nxce:igtd>
  </fdm:fltdMessage>
  <fdm:fltdMessage acid="AAL100" depArpt="KDFW" arrArpt="KLAX"
    msgType="flightCreate" sourceTimeStamp="2026-04-05T08:00:00Z">
    <nxce:igtd>2026-04-05T13:00:00Z</nxce:igtd>
  </fdm:fltdMessage>
</fltdOutput>
`;

describe('parseTfmMessage', () => {
  test('parses trackInformation and sets status Airborne', async () => {
    const events = await parseTfmMessage(TRACK_XML);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.flight).toBe('UA440');
    expect(e.dep_airport).toBe('EWR');
    expect(e.arr_airport).toBe('LAX');
    expect(e.status).toBe('Airborne');
  });

  test('parses scheduled times from igtd and eta', async () => {
    const [event] = await parseTfmMessage(TRACK_XML);
    expect(event.scheduled_dep).toBe('2026-04-05T19:22:00.000Z');
    expect(event.scheduled_arr).toBe('2026-04-05T21:53:02.000Z');
  });

  test('parses position data (altitude, speed, lat, lon)', async () => {
    const [event] = await parseTfmMessage(TRACK_XML);
    expect(event.altitude).toBe(280);
    expect(event.speed).toBe(298);
    // 33 deg 51 min 2 sec North
    expect(event.latitude).toBeCloseTo(33.851, 2);
    // 84 deg 35 min 0 sec West
    expect(event.longitude).toBeCloseTo(-84.583, 2);
  });

  test('strips K-prefix to convert ICAO airport codes to IATA', async () => {
    const [event] = await parseTfmMessage(TRACK_XML);
    expect(event.dep_airport).toBe('EWR');
    expect(event.arr_airport).toBe('LAX');
  });

  test('flightCreate maps to Scheduled status and uses igtd for date', async () => {
    const [event] = await parseTfmMessage(FLIGHT_CREATE_XML);
    expect(event.status).toBe('Scheduled');
    expect(event.flight).toBe('DL300');
    expect(event.date).toBe('2026-04-06');
  });

  test('cancellation maps to Cancelled status', async () => {
    const [event] = await parseTfmMessage(CANCELLATION_XML);
    expect(event.status).toBe('Cancelled');
    expect(event.flight).toBe('WN100');
  });

  test('skips GA tail numbers (N-prefix)', async () => {
    const events = await parseTfmMessage(GA_TAIL_XML);
    expect(events).toHaveLength(0);
  });

  test('returns empty array for empty string', async () => {
    expect(await parseTfmMessage('')).toHaveLength(0);
  });

  test('parses multiple fltdMessages in one XML', async () => {
    const events = await parseTfmMessage(MULTI_MSG_XML);
    expect(events).toHaveLength(2);
    const flights = events.map(e => e.flight).sort();
    expect(flights).toContain('UA440');
    expect(flights).toContain('AA100');
  });

  test('FlightModify extracts TFM metadata and aircraft category', async () => {
    const [e] = await parseTfmMessage(FLIGHT_MODIFY_XML);
    expect(e.flight).toBe('QX2077');
    expect(e.faa_flight_ref).toBe('144749879');
    expect(e.tfm_msg_type).toBe('FlightModify');
    expect(e.tfm_fd_trigger).toBe('FD_FLIGHT_MODIFY_MSG');
    expect(e.ncsm_flight_status).toBe('PLANNED');
    expect(e.aircraft_category).toBe('JET');
    expect(e.airline_icao).toBe('QXE');
    expect(e.aircraft_type).toBe('JET');
  });
});
