import { chmod, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createApp } from './app.js';
import { createDatabase } from './db.js';
import { createScheduler } from './scheduler.js';
import { getTimezone } from './time.js';
import { createWhatsApp } from './whatsapp.js';

process.env.TZ ||= 'Asia/Kolkata';

const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');

const dataDir = resolve(process.env.DATA_DIR || 'data');
await mkdir(dataDir, { recursive: true, mode: 0o700 });
await chmod(dataDir, 0o700);

const store = createDatabase(join(dataDir, 'scheduler.db'));
const whatsapp = createWhatsApp({ store, dataDir });
const scheduler = createScheduler({ store, whatsapp, timezone: getTimezone() });
const app = createApp({ store, whatsapp, scheduler });

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`WA Scheduler listening on 0.0.0.0:${port} (${getTimezone()})`);
});

scheduler.start();
void whatsapp.start();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down.`);
  await new Promise((resolveClose) => server.close(resolveClose));
  await scheduler.stop();
  await whatsapp.stop();
  store.close();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));