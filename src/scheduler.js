import cron from 'node-cron';
import { renderMessage } from './time.js';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createScheduler({ store, whatsapp, timezone = process.env.TZ || 'Asia/Kolkata', pollMs = 3000 }) {
  const tasks = new Map();
  const inFlight = new Map();
  let pollTimer;
  let polling = false;

  async function perform(schedule, { scheduledForMs = null, oneOff = false, manual = false } = {}) {
    if (inFlight.has(schedule.id)) return { skipped: true };
    if (!whatsapp.isConnected()) {
      if (manual) throw new Error('WhatsApp is not connected.');
      return { skipped: true };
    }

    const promise = (async () => {
      const renderedMessage = renderMessage(schedule.message_template, new Date(), timezone);
      const logId = store.claimExecution(schedule.id, {
        schedule_id: schedule.id,
        recipient_jid: schedule.recipient_jid,
        recipient_name: schedule.recipient_name,
        rendered_message: renderedMessage,
        executed_at_ms: Date.now(),
        scheduled_for_ms: scheduledForMs,
      }, { oneOff, allowPaused: manual });
      if (!logId) return { skipped: true };

      try {
        if (schedule.jitter_max_sec > 0) {
          await wait(Math.floor(Math.random() * (schedule.jitter_max_sec + 1) * 1000));
        }
        const messageId = await whatsapp.sendWhatsAppMessage(schedule.recipient_jid, renderedMessage);
        store.finishExecution({ id: logId, status: 'sent', whatsapp_message_id: messageId });
        if (oneOff) store.finishOnce(schedule.id, 'completed');
        else store.updateLastRun(schedule.id);
        return { sent: true, logId };
      } catch (error) {
        store.finishExecution({ id: logId, status: 'unknown', error_message: error.message });
        if (oneOff) store.finishOnce(schedule.id, 'failed');
        else store.updateLastRun(schedule.id);
        console.warn(`Message outcome unknown for schedule ${schedule.id}:`, error.message);
        return { sent: false, logId, unknown: true };
      }
    })();

    inFlight.set(schedule.id, promise);
    try {
      return await promise;
    } finally {
      if (inFlight.get(schedule.id) === promise) inFlight.delete(schedule.id);
    }
  }

  async function pollOnceSchedules() {
    if (polling || !whatsapp.isConnected()) return;
    polling = true;
    try {
      for (const schedule of store.dueOnce()) {
        await perform(schedule, {
          oneOff: true,
          scheduledForMs: schedule.run_at_ms,
        });
      }
    } finally {
      polling = false;
    }
  }

  function stopTask(id) {
    tasks.get(id)?.stop();
    tasks.delete(id);
  }

  function register(schedule) {
    stopTask(schedule.id);
    if (schedule.schedule_type !== 'cron' || schedule.status !== 'active') return;
    if (!cron.validate(schedule.cron_expr)) {
      console.warn(`Skipping invalid cron expression for schedule ${schedule.id}.`);
      return;
    }

    const task = cron.schedule(schedule.cron_expr, () => {
      const current = store.getSchedule(schedule.id);
      if (!current || current.status !== 'active') return;
      const scheduledForMs = Math.floor(Date.now() / 60_000) * 60_000;
      void perform(current, { scheduledForMs }).catch((error) => {
        console.warn(`Cron execution failed for schedule ${schedule.id}:`, error.message);
      });
    }, { timezone });
    tasks.set(schedule.id, task);
  }

  function start() {
    store.recoverInterruptedRuns();
    for (const schedule of store.listSchedules()) register(schedule);
    if (!pollTimer) {
      pollTimer = setInterval(() => void pollOnceSchedules(), pollMs);
      pollTimer.unref?.();
    }
  }

  async function stop() {
    clearInterval(pollTimer);
    pollTimer = undefined;
    for (const id of tasks.keys()) stopTask(id);
    await Promise.allSettled([...inFlight.values()]);
  }

  function refresh(schedule) {
    register(schedule);
    return schedule;
  }

  function remove(id) {
    stopTask(id);
  }

  async function runNow(id) {
    const schedule = store.getSchedule(id);
    if (!schedule) throw new Error('Schedule not found.');
    if (!['active', 'paused'].includes(schedule.status)) {
      throw new Error('This schedule cannot be run in its current state.');
    }
    return perform(schedule, { oneOff: schedule.schedule_type === 'once', manual: true });
  }

  return { start, stop, refresh, remove, runNow, validateCron: cron.validate };
}