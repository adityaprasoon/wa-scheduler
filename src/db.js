import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function createDatabase(filePath = process.env.DB_PATH || resolve('data/scheduler.db')) {
  if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });

  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('individual', 'group')),
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL DEFAULT '',
      recipient_jid TEXT NOT NULL,
      recipient_name TEXT NOT NULL,
      message_template TEXT NOT NULL,
      schedule_type TEXT NOT NULL CHECK (schedule_type IN ('once', 'cron')),
      run_at_ms INTEGER,
      cron_expr TEXT,
      jitter_max_sec INTEGER NOT NULL DEFAULT 0 CHECK (jitter_max_sec BETWEEN 0 AND 3600),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'processing', 'completed', 'failed')),
      last_run_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      CHECK (
        (schedule_type = 'once' AND run_at_ms IS NOT NULL AND cron_expr IS NULL) OR
        (schedule_type = 'cron' AND run_at_ms IS NULL AND cron_expr IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS execution_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id INTEGER,
      recipient_jid TEXT NOT NULL,
      recipient_name TEXT NOT NULL,
      rendered_message TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'error', 'unknown')),
      error_message TEXT,
      executed_at_ms INTEGER NOT NULL,
      scheduled_for_ms INTEGER,
      whatsapp_message_id TEXT,
      FOREIGN KEY(schedule_id) REFERENCES schedules(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_due_schedules
      ON schedules(schedule_type, status, run_at_ms);
    CREATE INDEX IF NOT EXISTS idx_execution_logs_recent
      ON execution_logs(executed_at_ms DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_schedule_time
      ON execution_logs(schedule_id, scheduled_for_ms)
      WHERE schedule_id IS NOT NULL AND scheduled_for_ms IS NOT NULL;
  `);

  const statements = {
    upsertChat: db.prepare(`
      INSERT INTO chats (jid, name, type, updated_at_ms)
      VALUES (@jid, @name, @type, @updated_at_ms)
      ON CONFLICT(jid) DO UPDATE SET
        name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE chats.name END,
        type = excluded.type,
        updated_at_ms = excluded.updated_at_ms
    `),
    listChats: db.prepare(`
      SELECT jid, name, type FROM chats
      WHERE @query = '' OR name LIKE @pattern OR jid LIKE @pattern
      ORDER BY type, lower(name)
      LIMIT 100
    `),
    insertSchedule: db.prepare(`
      INSERT INTO schedules (
        label, recipient_jid, recipient_name, message_template, schedule_type,
        run_at_ms, cron_expr, jitter_max_sec, created_at_ms
      ) VALUES (
        @label, @recipient_jid, @recipient_name, @message_template, @schedule_type,
        @run_at_ms, @cron_expr, @jitter_max_sec, @created_at_ms
      )
    `),
    getSchedule: db.prepare('SELECT * FROM schedules WHERE id = ?'),
    getChat: db.prepare('SELECT jid, name, type FROM chats WHERE jid = ?'),
    listSchedules: db.prepare(`
      SELECT * FROM schedules
      ORDER BY CASE status
        WHEN 'active' THEN 0 WHEN 'processing' THEN 1 WHEN 'paused' THEN 2
        WHEN 'failed' THEN 3 ELSE 4 END,
        created_at_ms DESC
    `),
    insertExecution: db.prepare(`
      INSERT INTO execution_logs (
        schedule_id, recipient_jid, recipient_name, rendered_message, status,
        executed_at_ms, scheduled_for_ms
      ) VALUES (
        @schedule_id, @recipient_jid, @recipient_name, @rendered_message, 'sending',
        @executed_at_ms, @scheduled_for_ms
      )
    `),
    getExecution: db.prepare('SELECT * FROM execution_logs WHERE id = ?'),
    updateExecution: db.prepare(`
      UPDATE execution_logs
      SET status = @status, error_message = @error_message,
          executed_at_ms = @executed_at_ms, whatsapp_message_id = @whatsapp_message_id
      WHERE id = @id
    `),
    updateOnceStatus: db.prepare(`
      UPDATE schedules SET status = @status, last_run_at_ms = @last_run_at_ms WHERE id = @id
    `),
    updateLastRun: db.prepare('UPDATE schedules SET last_run_at_ms = ? WHERE id = ?'),
    deleteSchedule: db.prepare('DELETE FROM schedules WHERE id = ?'),
    toggleSchedule: db.prepare(`
      UPDATE schedules SET status = CASE status WHEN 'active' THEN 'paused' ELSE 'active' END
      WHERE id = ? AND status IN ('active', 'paused')
    `),
    recentLogs: db.prepare(`
      SELECT * FROM execution_logs ORDER BY executed_at_ms DESC LIMIT ?
    `),
    dueOnce: db.prepare(`
      SELECT * FROM schedules
      WHERE schedule_type = 'once' AND status = 'active' AND run_at_ms <= ?
      ORDER BY run_at_ms
    `),
    getProcessingOnce: db.prepare(`
      SELECT id FROM schedules WHERE schedule_type = 'once' AND status = 'processing'
    `),
  };

  const claimTransaction = db.transaction((scheduleId, execution, options) => {
    const schedule = statements.getSchedule.get(scheduleId);
    if (!schedule) return null;

    const allowed = schedule.status === 'active' || (options.allowPaused && schedule.status === 'paused');
    if (!allowed) return null;

    if (execution.scheduled_for_ms !== null) {
      const existing = db.prepare(`
        SELECT id FROM execution_logs WHERE schedule_id = ? AND scheduled_for_ms = ?
      `).get(scheduleId, execution.scheduled_for_ms);
      if (existing) return null;
    }

    if (options.oneOff) {
      const update = db.prepare(`
        UPDATE schedules SET status = 'processing' WHERE id = ? AND status IN ('active', 'paused')
      `).run(scheduleId);
      if (update.changes !== 1) return null;
    }

    const result = statements.insertExecution.run(execution);
    return Number(result.lastInsertRowid);
  });

  return {
    db,
    close: () => db.close(),
    upsertChats(chats) {
      const upsert = db.transaction((items) => {
        for (const chat of items) statements.upsertChat.run({ ...chat, updated_at_ms: Date.now() });
      });
      upsert(chats);
    },
    listChats(query = '') {
      const value = query.trim();
      return statements.listChats.all({ query: value, pattern: `%${value}%` });
    },
    createSchedule(schedule) {
      const result = statements.insertSchedule.run({
        ...schedule,
        created_at_ms: Date.now(),
      });
      return statements.getSchedule.get(Number(result.lastInsertRowid));
    },
    getSchedule: (id) => statements.getSchedule.get(id),
    getChat: (jid) => statements.getChat.get(jid),
    listSchedules: () => statements.listSchedules.all(),
    dueOnce: (now = Date.now()) => statements.dueOnce.all(now),
    claimExecution(scheduleId, execution, options = {}) {
      return claimTransaction(scheduleId, execution, {
        oneOff: false,
        allowPaused: false,
        ...options,
      });
    },
    finishExecution({ id, status, error_message = null, whatsapp_message_id = null }) {
      statements.updateExecution.run({
        id,
        status,
        error_message,
        whatsapp_message_id,
        executed_at_ms: Date.now(),
      });
    },
    finishOnce(id, status) {
      statements.updateOnceStatus.run({ id, status, last_run_at_ms: Date.now() });
    },
    updateLastRun(id, at = Date.now()) {
      statements.updateLastRun.run(at, id);
    },
    toggleSchedule(id) {
      return statements.toggleSchedule.run(id).changes === 1 ? statements.getSchedule.get(id) : null;
    },
    deleteSchedule(id) {
      return statements.deleteSchedule.run(id).changes === 1;
    },
    recentLogs(limit = 50) {
      return statements.recentLogs.all(Math.min(Math.max(Number(limit) || 50, 1), 200));
    },
    recoverInterruptedRuns() {
      const recover = db.transaction(() => {
        const now = Date.now();
        const unknownLogs = db.prepare(`
          UPDATE execution_logs SET status = 'unknown',
            error_message = 'Service restarted while the send outcome was unknown.',
            executed_at_ms = ?
          WHERE status = 'sending'
        `).run(now).changes;
        const failedSchedules = statements.getProcessingOnce.all();
        for (const { id } of failedSchedules) {
          statements.updateOnceStatus.run({ id, status: 'failed', last_run_at_ms: now });
        }
        return { unknownLogs, failedSchedules: failedSchedules.length };
      });
      return recover();
    },
    getExecution: (id) => statements.getExecution.get(id),
  };
}