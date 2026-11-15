import { Router } from 'express';
import { normalizeRecipient } from './whatsapp.js';
import { formatLocalDateTime, getTimezone, parseLocalDateTime, renderMessage } from './time.js';

const maxMessageLength = 4000;

function asInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function validateMessage(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxMessageLength) {
    throw new Error(`Message must contain 1-${maxMessageLength} characters.`);
  }
  return value.trim();
}

function validateRecipient(value, store) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Enter a recipient.');
  const recipient_jid = normalizeRecipient(value);
  const saved = value.includes('@') ? store.getChat(recipient_jid) : null;
  const recipient_name = saved?.name || (value.includes('@') ? recipient_jid : value.replace(/[\s()+-]/g, ''));
  return { recipient_jid, recipient_name };
}

export function createRoutes({ store, whatsapp, scheduler, auth }) {
  const router = Router();

  router.post('/auth/login', auth.login);
  router.post('/auth/logout', auth.requireAuth, auth.logout);
  router.get('/auth/session', auth.requireAuth, (_req, res) => res.json({ authenticated: true }));
  router.use(auth.requireAuth);

  router.get('/status', (_req, res) => {
    res.json({
      ...whatsapp.getStatus(),
      serverTime: new Date().toISOString(),
      localTime: formatLocalDateTime(),
      timezone: getTimezone(),
    });
  });

  router.post('/logout', async (_req, res, next) => {
    try {
      await whatsapp.logout();
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/sync-chats', async (_req, res, next) => {
    try {
      const count = await whatsapp.syncGroups();
      res.json({ syncedGroups: count });
    } catch (error) {
      next(error);
    }
  });

  router.get('/chats', (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
    res.json(store.listChats(query));
  });

  router.post('/preview', (req, res, next) => {
    try {
      const template = validateMessage(req.body?.messageTemplate);
      res.json({ renderedMessage: renderMessage(template), localTime: formatLocalDateTime() });
    } catch (error) {
      next(error);
    }
  });

  router.post('/cron/validate', (req, res) => {
    const expression = typeof req.body?.cronExpr === 'string' ? req.body.cronExpr.trim() : '';
    res.json({ valid: scheduler.validateCron(expression) });
  });

  router.get('/schedules', (_req, res) => res.json(store.listSchedules()));

  router.post('/schedules', (req, res, next) => {
    try {
      const body = req.body || {};
      const scheduleType = body.scheduleType;
      if (!['once', 'cron'].includes(scheduleType)) throw new Error('Choose a supported schedule type.');
      const { recipient_jid, recipient_name } = validateRecipient(body.recipient, store);
      const message_template = validateMessage(body.messageTemplate);
      const label = typeof body.label === 'string' ? body.label.trim().slice(0, 120) : '';
      const jitter_max_sec = asInteger(body.jitterMaxSec, 0);
      if (jitter_max_sec < 0 || jitter_max_sec > 3600) throw new Error('Delay must be between 0 and 3600 seconds.');

      let run_at_ms = null;
      let cron_expr = null;
      if (scheduleType === 'once') {
        const runAt = parseLocalDateTime(body.runAt);
        if (runAt.getTime() <= Date.now()) throw new Error('Choose a future date and time.');
        run_at_ms = runAt.getTime();
      } else {
        cron_expr = typeof body.cronExpr === 'string' ? body.cronExpr.trim() : '';
        if (!scheduler.validateCron(cron_expr)) throw new Error('Enter a valid five-field cron expression.');
      }

      const schedule = store.createSchedule({
        label,
        recipient_jid,
        recipient_name,
        message_template,
        schedule_type: scheduleType,
        run_at_ms,
        cron_expr,
        jitter_max_sec,
      });
      scheduler.refresh(schedule);
      return res.status(201).json(schedule);
    } catch (error) {
      next(error);
    }
  });

  router.patch('/schedules/:id/toggle', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid schedule id.' });
      const schedule = store.toggleSchedule(id);
      if (!schedule) return res.status(404).json({ error: 'Schedule not found or cannot be toggled.' });
      scheduler.refresh(schedule);
      return res.json(schedule);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/schedules/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid schedule id.' });
    const schedule = store.getSchedule(id);
    if (!schedule) return res.status(404).json({ error: 'Schedule not found.' });
    scheduler.remove(id);
    store.deleteSchedule(id);
    res.json({ ok: true });
  });

  router.post('/schedules/:id/run-now', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid schedule id.' });
      const result = await scheduler.runNow(id);
      if (result.skipped) return res.status(409).json({ error: 'This schedule is already running.' });
      return res.json(result);
    } catch (error) {
      if (error.message === 'Schedule not found.') return res.status(404).json({ error: error.message });
      if (error.message.includes('current state')) return res.status(409).json({ error: error.message });
      if (error.message === 'WhatsApp is not connected.') return res.status(503).json({ error: error.message });
      next(error);
    }
  });

  router.get('/logs', (req, res) => {
    res.json(store.recentLogs(asInteger(req.query.limit, 50)));
  });

  router.use((error, _req, res, _next) => {
    const message = error?.message || 'Unexpected server error.';
    const clientError = message.startsWith('Enter ') ||
      message.startsWith('Choose ') ||
      message.startsWith('Message ') ||
      message.startsWith('Use ') ||
      message.startsWith('Delay ') ||
      message.startsWith('That local time ') ||
      message.startsWith('A valid ') ||
      message.startsWith('A number ');
    res.status(clientError ? 400 : 500).json({ error: message });
  });

  return router;
}