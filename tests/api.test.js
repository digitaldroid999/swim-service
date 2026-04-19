'use strict';

const request = require('supertest');
const { app } = require('../api');
const db      = require('../db');

const SECRET = 'test-secret';

const testEvent = {
  flight:        'UA440',
  date:          '2026-04-05',
  dep_airport:   'EWR',
  arr_airport:   'LAX',
  status:        'Airborne',
  scheduled_dep: '2026-04-05T19:22:00.000Z',
  scheduled_arr: '2026-04-05T21:53:02.000Z',
  gate_out:      '2026-04-05T19:30:00.000Z',
  wheels_off:    null,
  wheels_on:     null,
  gate_in:       null,
  dep_gate:      'C17',
  arr_gate:      null,
  dep_terminal:  'C',
  arr_terminal:  null,
  dep_delay_min: 5,
  arr_delay_min: 0,
  altitude:      280,
  speed:         298,
  latitude:      33.851,
  longitude:     -84.584,
  position_time: '2026-04-05T20:00:00.000Z',
  gufi:          'GUFI-TEST-001',
  tail_number:   'N12345',
  aircraft_type: 'B738',
  raw_xml:       '<test/>',
};

beforeAll(() => {
  db.saveEvent(testEvent);
});

describe('GET /health', () => {
  test('returns 200 with ok:true', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('crew-assist-swim');
  });
});

describe('GET /flight', () => {
  test('returns 401 without auth header', async () => {
    const res = await request(app).get('/flight?flight=UA440&date=2026-04-05');
    expect(res.status).toBe(401);
  });

  test('returns 401 with wrong secret', async () => {
    const res = await request(app)
      .get('/flight?flight=UA440&date=2026-04-05')
      .set('x-api-secret', 'wrong-secret');
    expect(res.status).toBe(401);
  });

  test('returns 400 when flight param is missing', async () => {
    const res = await request(app)
      .get('/flight?date=2026-04-05')
      .set('x-api-secret', SECRET);
    expect(res.status).toBe(400);
  });

  test('returns 400 when date param is missing', async () => {
    const res = await request(app)
      .get('/flight?flight=UA440')
      .set('x-api-secret', SECRET);
    expect(res.status).toBe(400);
  });

  test('returns 404 when no data found', async () => {
    const res = await request(app)
      .get('/flight?flight=ZZ999&date=2099-01-01')
      .set('x-api-secret', SECRET);
    expect(res.status).toBe(404);
  });

  test('returns normalized flight data', async () => {
    const res = await request(app)
      .get('/flight?flight=UA440&date=2026-04-05&dep=EWR')
      .set('x-api-secret', SECRET);
    expect(res.status).toBe(200);
    expect(res.body.flight).toBe('UA440');
    expect(res.body.status).toBe('Airborne');
    expect(res.body._source).toBe('swim');
    expect(res.body.departure.airport.iata).toBe('EWR');
    expect(res.body.arrival.airport.iata).toBe('LAX');
    expect(res.body.departure.actualTime.utc).toBe('2026-04-05T19:30:00.000Z');
    expect(res.body.departure.delay).toBe(5);
  });

  test('returns aircraft and position data when available', async () => {
    const res = await request(app)
      .get('/flight?flight=UA440&date=2026-04-05&dep=EWR')
      .set('x-api-secret', SECRET);
    expect(res.status).toBe(200);
    expect(res.body.aircraft).not.toBeNull();
    expect(res.body.aircraft.reg).toBe('N12345');
    expect(res.body.position).not.toBeNull();
    expect(res.body.position.lat).toBe(33.851);
    expect(res.body.position.altitude).toBe(280);
  });
});

describe('POST /watch', () => {
  test('returns 401 without auth header', async () => {
    const res = await request(app)
      .post('/watch')
      .send({ userEmail: 'a@b.com', flights: [{ flight: 'UA440', date: '2026-04-05' }] });
    expect(res.status).toBe(401);
  });

  test('returns 400 when userEmail is missing', async () => {
    const res = await request(app)
      .post('/watch')
      .set('x-api-secret', SECRET)
      .send({ flights: [{ flight: 'UA440', date: '2026-04-05' }] });
    expect(res.status).toBe(400);
  });

  test('returns 400 when flights array is missing', async () => {
    const res = await request(app)
      .post('/watch')
      .set('x-api-secret', SECRET)
      .send({ userEmail: 'a@b.com' });
    expect(res.status).toBe(400);
  });

  test('registers a watch and returns added count', async () => {
    const res = await request(app)
      .post('/watch')
      .set('x-api-secret', SECRET)
      .send({
        userEmail: 'crew@airline.com',
        flights: [{ flight: 'UA440', date: '2026-04-05', dep: 'EWR', arr: 'LAX' }],
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.added).toBe(1);
  });

  test('skips entries missing flight or date, added stays 0', async () => {
    const res = await request(app)
      .post('/watch')
      .set('x-api-secret', SECRET)
      .send({
        userEmail: 'crew@airline.com',
        flights: [{ dep: 'EWR' }],
      });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(0);
  });
});
