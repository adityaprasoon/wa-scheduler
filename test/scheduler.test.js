import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createScheduler } from '../src/scheduler.js';

describe('schedule execution', () => {
  let store;
  afterEach(() => store?.close());

  it('runs a one-off once and records the result without retrying', async () => {
    store = createDatabase(':memory:');
    let sendCount = 0;
    const whatsapp = {
      isConnected: () => true,
      sendWhatsAppMessage: async () => {
        sendCount += 1;
        return 'message-123';
      },
    };
    const scheduler = createScheduler({ store, whatsapp });
    const schedule = store.createSchedule({
      label: '',
      recipient_jid: '919876543210@s.whatsapp.net',
      recipient_name: 'Test Contact',
      message_template: 'Today is {{day}}',
      schedule_type: 'once',
      run_at_ms: Date.now() + 60_000,
      cron_expr: null,
      jitter_max_sec: 0,
    });

    assert.deepEqual(await scheduler.runNow(schedule.id), { sent: true, logId: 1 });
    assert.equal(sendCount, 1);
    assert.equal(store.getSchedule(schedule.id).status, 'completed');
    assert.equal(store.recentLogs()[0].status, 'sent');
    await assert.rejects(() => scheduler.runNow(schedule.id), /current state/);
  });
});