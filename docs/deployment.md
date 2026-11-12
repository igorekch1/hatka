# Deployment to a VPS

The bot needs no inbound ports and very little resources — the smallest cloud server is enough. The steps below use
**Hetzner Cloud** with Ubuntu 24.04 and Docker; any other provider works the same way after the server is created.

Before you start, go through [setup.md](setup.md) once locally: you will have a working `.env`
(including `TG_SESSION`) to copy to the server.

## 1. Create the server

1. Sign up at [hetzner.com/cloud](https://www.hetzner.com/cloud). Identity verification may be requested.
2. **New Project** → **Add Server**:
   - **Location:** Helsinki or Falkenstein / Nuremberg;
   - **Image:** Ubuntu 24.04;
   - **Type:** the cheapest Shared vCPU plan — Arm (CAX) or x86 (CX), both work;
   - **SSH keys → Add SSH key:** paste your public key (`cat ~/.ssh/id_ed25519.pub`).
3. **Create & Buy** and copy the server's **IPv4** address.

## 2. Connect

On your machine, add a host alias and connect:

```bash
cat >> ~/.ssh/config <<'EOF'

Host hatka
  HostName <SERVER_IP>
  User root
  IdentityFile ~/.ssh/id_ed25519
EOF
ssh hatka
```

## 3. Prepare the server

```bash
apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh
ufw allow OpenSSH && ufw --force enable   # only SSH is open; the bot makes outbound connections only
```

## 4. Get the code

For a private repository, give the server a read-only **deploy key**:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/github_hatka -N ""
cat ~/.ssh/github_hatka.pub
```

GitHub → repository → **Settings → Deploy keys → Add deploy key** (leave *Allow write access* off). Then:

```bash
printf 'Host github.com\n  IdentityFile ~/.ssh/github_hatka\n' >> ~/.ssh/config
git clone git@github.com:igorekch1/hatka.git
cd hatka
```

(For a public repository a plain `git clone https://github.com/igorekch1/hatka.git` is enough.)

## 5. Copy the configuration

From your **local machine**:

```bash
scp .env hatka:~/hatka/.env
```

Check which keys are set on the server without printing the values:

```bash
grep -E '^[A-Z_]+=' .env | sed -E 's/=.+/=✓/; s/=$/= (empty)/'
```

Using a different bot or group in production? Edit `.env` (`nano .env`): new `TELEGRAM_BOT_TOKEN`, empty
`TELEGRAM_CHAT_ID` — you will get it from `/chatid` after the first start.

## 6. Check that the sources accept the server

```bash
docker compose build
docker compose run --rm -e DRY_RUN=1 radar node --disable-warning=ExperimentalWarning src/index.ts --once
```

Expect `lun: получено N` and `domria: получено N`. `✗ … фільтри не задані` lines are fine. If a site answers
`HTTP 403`, it blocks the provider's IP range — recreate the server in another location (or another provider).

## 7. Start

1. **Stop any local instance** with the same bot token or the same `TG_SESSION`:
   `ps aux | grep "src/index.ts" | grep -v grep` must be empty on your machine.
2. On the server:

   ```bash
   docker compose up -d
   docker compose logs -f --tail 50     # Ctrl+C leaves the logs; the bot keeps running
   ```

   Look for `Telegram: слушаю «…»` per channel and the start line with the enabled sources.
3. New group? Write `/chatid` there, put the id into `.env`, then `docker compose up -d`.
4. In the group: reply to *"Фільтри ще не задані"* with your filters, then check `/status`, `/menu`, `/help`.

The container restarts automatically after crashes and server reboots (`restart: unless-stopped`). The SQLite database
lives in `./data` on the host.

## Operations

| Task | Command (in `~/hatka`) |
|---|---|
| Logs | `docker compose logs -f --tail 100` |
| Is it running | `docker compose ps`, or `/status` in the chat |
| Update after pushing new code | `git pull && docker compose up -d --build` |
| Apply `.env` changes | `docker compose up -d` |
| Stop / start | `docker compose down` / `docker compose up -d` |
| Back up the database (from your machine) | `scp hatka:~/hatka/data/radar.db ./radar-backup.db` |
| Re-login to Telegram on the server | `docker compose run --rm -it radar node --disable-warning=ExperimentalWarning scripts/tg-login.ts` |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Permission denied (publickey)` on `ssh hatka` | Wrong key in `~/.ssh/config`, or the key was not added when creating the server |
| `git clone` → `Permission denied` | Deploy key missing or added to another repository |
| Nothing appears in the group | Wrong `TELEGRAM_CHAT_ID`, or the bot is not a member — check the logs |
| `Conflict: terminated by other getUpdates request` | Another instance with the same token is running (often the local one) |
| `⚠️ Telegram-канали не підключені` / `AUTH_KEY_UNREGISTERED` | Telegram revoked the session — re-login (see above) and update `TG_SESSION` |
| `⚠️ <source> не відповідає вже 5 разів поспіль` | The site blocks the server or changed its format; see `docker compose logs` |
| Too many listings | `/filters мін. оцінка 3`, or disable "send listings without a district" |
| Too few listings | `/status` shows the most common rejection reasons for the last 24 h |
