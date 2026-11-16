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

    const updatedTime = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const updatedRunAt = `${updatedTime.getFullYear()}-${String(updatedTime.getMonth() + 1).padStart(2, '0')}-${String(updatedTime.getDate()).padStart(2, '0')}T${String(updatedTime.getHours()).padStart(2, '0')}:${String(updatedTime.getMinutes()).padStart(2, '0')}`;
    const updated = await fetch(`${baseUrl}/api/schedules/${schedule.id}`, {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'Updated label',
        recipient: '+919876543210',
        messageTemplate: 'Updated {{day}}',
        scheduleType: 'once',
        runAt: updatedRunAt,
        jitterMaxSec: 30,
      }),
    });
    assert.equal(updated.status, 200);
    const updatedSchedule = await updated.json();
    assert.equal(updatedSchedule.label, 'Updated label');
    assert.equal(updatedSchedule.message_template, 'Updated {{day}}');
    assert.equal(updatedSchedule.jitter_max_sec, 30);
    assert.ok(updatedSchedule.run_at_ms > schedule.run_at_ms);

    const executionId = store.claimExecution(schedule.id, {
      schedule_id: schedule.id,
      recipient_jid: updatedSchedule.recipient_jid,
      recipient_name: updatedSchedule.recipient_name,
      rendered_message: 'In progress',
      executed_at_ms: Date.now(),
      scheduled_for_ms: null,
    });
    const duringExecution = await fetch(`${baseUrl}/api/schedules/${schedule.id}`, {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        recipient: '+919876543210',
        messageTemplate: 'Cannot update during send',
        scheduleType: 'once',
        runAt: updatedRunAt,
      }),
    });
    assert.equal(duringExecution.status, 409);
    store.finishExecution({ id: executionId, status: 'sent' });

    const invalidUpdate = await fetch(`${baseUrl}/api/schedules/${schedule.id}`, {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: '+919876543210', messageTemplate: 'Hi', scheduleType: 'cron', cronExpr: 'not cron' }),
    });
    assert.equal(invalidUpdate.status, 400);
    assert.equal(store.getSchedule(schedule.id).message_template, 'Updated {{day}}');

    const invalidCron = await fetch(`${baseUrl}/api/schedules`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: '+919876543210', messageTemplate: 'Hi', scheduleType: 'cron', cronExpr: 'not cron' }),
    });
    assert.equal(invalidCron.status, 400);
  });
});