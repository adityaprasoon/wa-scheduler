# Deployment on a Proxmox LXC

This guide deploys the published GitHub Container Registry image inside a Debian 13 LXC. The image is multi-architecture (`linux/amd64` and `linux/arm64`). SQLite data and WhatsApp pairing credentials are persisted together under `/opt/wa-scheduler/data` on the LXC.

## 1. Prepare the LXC

Create a Debian 13 LXC with outbound internet access and at least 1 GiB RAM. Docker Engine must be installed and working inside the LXC. Docker-in-LXC may require enabling the `nesting` and `keyctl` features in Proxmox; follow the requirements for your LXC type and Docker installation.

Check Docker from inside the LXC:

```sh
docker version
```

The commands below assume they run as a user allowed to control Docker. Add `sudo` where needed.

## 2. Publish the image

Push this repository's default branch to GitHub. The **Publish container image** workflow builds and publishes `ghcr.io/adityaprasoon/wa-scheduler:latest` for amd64 and arm64. A push also publishes an immutable `sha-<commit>` tag. Pushing a `v*` Git tag publishes that version tag too.

Wait for the workflow to finish successfully in the repository's **Actions** tab before pulling the image. The first push may create the GHCR package as private. To pull without authenticating from the LXC, open the package settings on GitHub and change its visibility to **Public**. If it stays private, authenticate Docker in the LXC with a GitHub token that has `read:packages`:

```sh
docker login ghcr.io -u adityaprasoon
```

Enter the token at the password prompt. Do not put the token in shell history or this deployment file.

## 3. Create persistent storage and configuration

The image runs as UID/GID `1000:1000`. Create a host directory writable by that account and a private environment file:

```sh
sudo install -d -o 1000 -g 1000 -m 700 /opt/wa-scheduler/data
sudo install -d -m 700 /opt/wa-scheduler
openssl rand -hex 32
sudo nano /opt/wa-scheduler/.env
sudo chmod 600 /opt/wa-scheduler/.env
```

Copy the random value printed by `openssl` into `APP_PASSWORD`. The environment file should contain:

```dotenv
PORT=8080
TZ=Asia/Kolkata
DATA_DIR=/app/data
APP_PASSWORD=replace-with-the-generated-random-value
COOKIE_SECURE=false
```

Use a unique password. `COOKIE_SECURE=false` is required for direct HTTP access. If serving the app through an HTTPS reverse proxy, set it to `true` and configure the proxy to preserve the incoming `Host` header.

## 4. Pull and start

```sh
docker pull ghcr.io/adityaprasoon/wa-scheduler:latest

docker run -d \
  --name wa-scheduler \
  --restart unless-stopped \
  --init \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  --publish 8080:8080 \
  --env-file /opt/wa-scheduler/.env \
  --mount type=bind,src=/opt/wa-scheduler/data,dst=/app/data \
  ghcr.io/adityaprasoon/wa-scheduler:latest
```

The published port is available on the LXC's network interfaces. Restrict access with the Proxmox/LXC firewall to your home LAN, or publish only on a specific LXC address by changing the port option to `--publish <LXC-IP>:8080:8080`. Do not expose the HTTP port to the public internet.

Check startup and health:

```sh
docker ps
docker logs -f wa-scheduler
docker inspect --format '{{.State.Health.Status}}' wa-scheduler
```

## 5. First WhatsApp pairing

1. From a device on the allowed network, open `http://<LXC-IP>:8080` and sign in with `APP_PASSWORD`.
2. In WhatsApp on the phone, open **Linked devices** → **Link a device**.
3. Scan the QR code shown on the dashboard. Keep the LXC online while pairing completes.
4. Wait for the dashboard to show the WhatsApp connection as connected. Use **Sync groups** if group names do not appear in the recipient list.
5. Create a test schedule for a number you control. **Run now** sends a real message; use it carefully.

Pairing credentials are stored in `/opt/wa-scheduler/data/auth_info`. The SQLite database is `/opt/wa-scheduler/data/scheduler.db`. Both survive container removal and replacement as long as the bind-mounted directory is preserved.

## 6. Restart, update, and back up

Restart the existing container without losing its session or schedules:

```sh
docker restart wa-scheduler
```

To update to the latest default-branch image, pull it, then recreate the container using the same `docker run` options above:

```sh
docker pull ghcr.io/adityaprasoon/wa-scheduler:latest
docker rm -f wa-scheduler
```

For rollback, replace `latest` in the run command with a previously published `sha-<commit>` tag. Do not remove `/opt/wa-scheduler/data` when replacing the container.

Stop the app before a simple filesystem backup so SQLite WAL data is included consistently:

```sh
docker stop wa-scheduler
sudo tar -C /opt/wa-scheduler -czf /path/to/backup/wa-scheduler-data.tar.gz data
docker start wa-scheduler
```

The backup contains WhatsApp session credentials and message history/logs; store it encrypted and restrict access. Restore the directory with owner `1000:1000` and mode `700` before starting the container.

## Notes

- Baileys is an unofficial WhatsApp Web client. It may break after WhatsApp changes and may put the linked account at risk of restrictions.
- Direct HTTP does not encrypt the dashboard password or session cookie in transit. Use only on a trusted LAN; use HTTPS or a private VPN for less-trusted networks.
- One-off times use the configured `TZ`. Recurring cron ticks missed while the service is stopped or WhatsApp is disconnected are skipped.
- A failed send whose outcome is uncertain is logged as `unknown` and is not retried automatically.