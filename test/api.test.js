import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { createScheduler } from '../src/scheduler.js';

process.env.TZ = 'Asia/Kolkata';

describe('authenticated API', () => {
  let server;
  let baseUrl;
  let store;
  let sessionCookie;

  before(async () => {
    store = createDatabase(':memory:');
    const whatsapp = {
      getStatus: () => ({ connectionState: 'connecting', qrDataUrl: null, connectedUser: null }),
      isConnected: () => false,
      syncGroups: async () => 0,
      logout: async () => {},
      sendWhatsAppMessage: async () => 'test-message-id',
    };
    const scheduler = createScheduler({ store, whatsapp });
    const app = createApp({ store, whatsapp, scheduler, appPassword: 'a-test-password-long-enough' });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'a-test-password-long-enough' }),
    });
    sessionCookie = login.headers.get('set-cookie').split(';')[0];
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    store?.close();
  });

  it('protects status and rejects cross-origin mutations', async () => {
    assert.equal((await fetch(`${baseUrl}/api/status`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/status`, { headers: { cookie: sessionCookie } })).status, 200);
    const rejected = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: sessionCookie, origin: 'http://attacker.invalid', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(rejected.status, 403);
  });

  it('validates cron schedules and stores one-off times as UTC instants', async () => {
    const tomorrow = new Date(Date.now() + 60 * 60 * 1000);
    const runAt = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}T${String(tomorrow.getHours()).padStart(2, '0')}:${String(tomorrow.getMinutes()).padStart(2, '0')}`;
    const created = await fetch(`${baseUrl}/api/schedules`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        recipient: '+919876543210',
        messageTemplate: 'Hello {{day}}',
        scheduleType: 'once',
        runAt,
        jitterMaxSec: 0,
      }),
    });
    assert.equal(created.status, 201);
    const schedule = await created.json();
    assert.equal(schedule.recipient_jid, '919876543210@s.whatsapp.net');
    assert.ok(schedule.run_at_ms > Date.now());

    const invalidCron = await fetch(`${baseUrl}/api/schedules`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: '+919876543210', messageTemplate: 'Hi', scheduleType: 'cron', cronExpr: 'not cron' }),
    });
    assert.equal(invalidCron.status, 400);
  });
});