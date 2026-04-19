'use strict';

const db = require('../db');

const baseEvent = {
  flight:        'UA440',
  date:          '2026-04-05',
  dep_airport:   'EWR',
  arr_airport:   'LAX',
  status:        'Scheduled',
  scheduled_dep: '2026-04-05T19:22:00.000Z',
  scheduled_arr: '2026-04-05T21:53:02.000Z',
  gate_out:      null,
  wheels_off:    null,
  wheels_on:     null,
  gate_in:       null,
  dep_gate:      'C17',
  arr_gate:      null,
  dep_terminal:  'C',
  arr_terminal:  null,
  dep_delay_min: 0,
  arr_delay_min: 0,
  altitude:      null,
  speed:         null,
  latitude:      null,
  longitude:     null,
  position_time: null,
  gufi:          null,
  tail_number:   'N12345',
  aircraft_type: 'B738',
  raw_xml:       '<test/>',
};

describe('db.saveEvent / db.getEvent', () => {
  test('saves and retrieves an event by flight, date, dep_airport', () => {
    db.saveEvent(baseEvent);
    const result = db.getEvent('UA440', '2026-04-05', 'EWR');
    expect(result).not.toBeNull();
    expect(result.flight).toBe('UA440');
    expect(result.dep_airport).toBe('EWR');
    expect(result.arr_airport).toBe('LAX');
    expect(result.status).toBe('Scheduled');
  });

  test('retrieves most recent event when dep_airport is omitted', () => {
    const result = db.getEvent('UA440', '2026-04-05', null);
    expect(result).not.toBeNull();
    expect(result.flight).toBe('UA440');
  });

  test('returns null when no match', () => {
    const result = db.getEvent('XX999', '2026-04-05', 'JFK');
    expect(result).toBeNull();
  });

  test('upsert preserves existing OOOI times when update provides null', () => {
    const withOooi = { ...baseEvent, gate_out: '2026-04-05T19:30:00.000Z', status: 'Departed' };
    db.saveEvent(withOooi);

    // Second upsert: no gate_out but adds wheels_off - COALESCE keeps existing gate_out
    const update = { ...baseEvent, gate_out: null, wheels_off: '2026-04-05T19:45:00.000Z', status: 'Airborne' };
    db.saveEvent(update);

    const result = db.getEvent('UA440', '2026-04-05', 'EWR');
    expect(result.gate_out).toBe('2026-04-05T19:30:00.000Z');
    expect(result.wheels_off).toBe('2026-04-05T19:45:00.000Z');
    expect(result.status).toBe('Airborne');
  });
});

describe('db.addWatch / db.getWatchesForFlight', () => {
  test('adds a watch and retrieves it', () => {
    db.addWatch('test@example.com', 'UA440', '2026-04-05', 'EWR', 'LAX');
    const watches = db.getWatchesForFlight('UA440', '2026-04-05');
    expect(watches.length).toBeGreaterThan(0);
    expect(watches.some(w => w.user_email === 'test@example.com')).toBe(true);
  });

  test('ignores duplicate watches (INSERT OR IGNORE)', () => {
    db.addWatch('dup@example.com', 'DL100', '2026-04-06', 'ATL', 'JFK');
    db.addWatch('dup@example.com', 'DL100', '2026-04-06', 'ATL', 'JFK');
    const watches = db.getWatchesForFlight('DL100', '2026-04-06');
    const mine = watches.filter(w => w.user_email === 'dup@example.com');
    expect(mine).toHaveLength(1);
  });
});

describe('db.pruneOldEvents', () => {
  test('removes events older than 3 days', () => {
    const oldDate = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    db.saveEvent({ ...baseEvent, flight: 'OLD001', date: oldDate, dep_airport: 'ORD' });
    expect(() => db.pruneOldEvents()).not.toThrow();
    const result = db.getEvent('OLD001', oldDate, 'ORD');
    expect(result).toBeNull();
  });
});
