# WA Scheduler

A single-user WhatsApp Web scheduler for a private home network. It uses Baileys to link a personal WhatsApp account, SQLite for schedules and logs, and a password-protected local dashboard.

## Important

Baileys is an unofficial WhatsApp Web client. It is not supported as an API for personal accounts, may stop working after WhatsApp changes, and may expose the linked account to restriction. Use it only if you accept that risk. The auth files in `data/auth_info` can operate the linked account; protect them like credentials and never share the QR code.

The dashboard is exposed to the LAN and requires `APP_PASSWORD`. Plain HTTP does not encrypt the password or session cookie in transit. For untrusted Wi-Fi or remote access, put it behind a TLS-enabled reverse proxy or use a private VPN, set `COOKIE_SECURE=true`, and do not forward port 8080 to the public internet.

## Run with Docker

For the published GHCR image and first-time WhatsApp pairing steps, see [deployment.md](deployment.md).

1. Copy `.env.example` to `.env` and set `APP_PASSWORD` to a unique random value of at least 16 characters. For example, generate one with `openssl rand -base64 32`.
2. Set `PUID` and `PGID` in `.env` to the numeric owner of the `data` directory. Create that directory with owner-only permissions.
3. Start the service with `docker compose up -d --build`.
4. Open `http://<docker-host>:8080`, sign in, and scan the QR code from WhatsApp's Linked devices screen.

The SQLite database and Baileys credentials are stored in `./data`. Back up this directory securely; avoid copying only the SQLite main file while the service is running because WAL mode may have pending data. Use a SQLite-aware backup or stop the container before copying it.

## Scheduling behavior

- One-off times are entered in the configured `TZ` timezone and stored as UTC instants. A due one-off waits while WhatsApp is disconnected and runs after reconnection.
- Cron expressions use five fields and the configured timezone. Missed recurring ticks are skipped while the service is stopped or disconnected.
- The extra delay defaults to zero. A send that fails after the request begins is recorded as `unknown` and is not retried automatically, to avoid duplicate messages.
- `Sent to WhatsApp` means Baileys accepted the send operation; it does not confirm delivery or reading by the recipient.
- Message variables are `{{date}}`, `{{day}}`, `{{time}}`, and `{{random:option1|option2}}`.

Phone numbers must include their country code. Saved contacts and groups are populated from WhatsApp sync and the explicit group-sync action; availability depends on what the linked client provides.

## Local development

Requires Node.js 22 or newer. Copy `.env.example` to `.env`, set `APP_PASSWORD`, then run `npm install` and `node --env-file=.env src/index.js`. The service listens on all interfaces for LAN use. Run `npm test` for the focused timezone, database, scheduler, and API tests.