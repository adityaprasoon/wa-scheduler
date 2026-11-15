import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createDatabase } from '../src/db.js';
import { parseLocalDateTime, renderMessage } from '../src/time.js';

const originalTz = process.env.TZ;
process.env.TZ = 'Asia/Kolkata';

afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('local time handling', () => {
  it('converts an Asia/Kolkata local input to a UTC instant', () => {
    assert.equal(parseLocalDateTime('2026-11-15T09:00').toISOString(), '2026-11-15T03:30:00.000Z');
  });

  it('rejects malformed or impossible local values', () => {
    assert.throws(() => parseLocalDateTime('tomorrow at nine'));
    assert.throws(() => parseLocalDateTime('2026-02-31T09:00'));
  });

  it('renders local template variables and deterministic random choices', () => {
    const message = renderMessage(
      'Hi {{random:team|everyone}}, {{day}} {{date}} at {{time}}',
      new Date('2026-11-15T03:30:00.000Z'),
      'Asia/Kolkata',
      () => 0.99,
    );
    assert.equal(message, 'Hi everyone, Sunday 15 Nov 2026 at 09:00');
  });
});

describe('SQLite run ledger', () => {
  let store;
  afterEach(() => store?.close());

  it('claims a one-off only once and records interrupted sends as unknown', () => {
    store = createDatabase(':memory:');
    const schedule = store.createSchedule({
      label: 'Test',
      recipient_jid: '919876543210@s.whatsapp.net',
      recipient_name: 'Test Contact',
      message_template: 'hello',
      schedule_type: 'once',
      run_at_ms: Date.now(),
      cron_expr: null,
      jitter_max_sec: 0,
    });
    const execution = {
      schedule_id: schedule.id,
      recipient_jid: schedule.recipient_jid,
      recipient_name: schedule.recipient_name,
      rendered_message: 'hello',
      executed_at_ms: Date.now(),
      scheduled_for_ms: schedule.run_at_ms,
    };

    const runId = store.claimExecution(schedule.id, execution, { oneOff: true });
    assert.ok(runId);
    assert.equal(store.claimExecution(schedule.id, execution, { oneOff: true }), null);
    assert.deepEqual(store.recoverInterruptedRuns(), { unknownLogs: 1, failedSchedules: 1 });
    assert.equal(store.getExecution(runId).status, 'unknown');
    assert.equal(store.getSchedule(schedule.id).status, 'failed');
  });
});