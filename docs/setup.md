# Setup

Everything you need before the bot can run — locally or on a server. About 30 minutes.

Requirements for running without Docker: **Node.js 22.18+** (TypeScript runs natively, there is no build step).

## 1. Telegram bot and group

1. In Telegram open **@BotFather** → `/newbot` → choose a name and a username ending in `bot` → copy the **token**.
2. Create a group and add the people who are searching.
3. Add the bot: group → group name → **Add Members** → search for the bot's `@username`.
   If Telegram says the bot can't be added to groups: @BotFather → `/setjoingroups` → your bot → **Enable**.
4. **Make it a supergroup** (needed only for "open card" links in `/liked`, `/top`, `/viewings`): group → **Edit** →
   **Chat History for New Members → Visible**. If that option is missing, switch **Group Type** to Public (any link),
   save, and switch back to Private. Do this *before* reading the chat id — the id changes on conversion.

> Use a separate test bot for local experiments. Two running instances with the same token steal updates from each
> other (`Conflict: terminated by other getUpdates request`).

## 2. Anthropic API key (recommended)

[console.anthropic.com](https://console.anthropic.com) → **Billing** (a few dollars is enough for a long time with
Claude Haiku) → **Limits** (set a monthly cap) → **API Keys** → Create Key.

Without the key the bot still works, but:
- Telegram channel posts are understood poorly (no structured fields; posts without a parseable price are dropped);
- filters can be set only with the simple offline parser;
- `/help` shows a static cheat sheet.

## 3. Configure and run locally

```bash
git clone https://github.com/igorekch1/hatka.git && cd hatka
npm install
cp .env.example .env
```

Fill in `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY` and `CITY` (`lviv`, `kyiv`, `odesa`, `kharkiv` or `dnipro`; all variables:
[configuration.md](configuration.md)), then:

```bash
npm start
```

1. Write `/chatid` in the group — the bot replies with a number like `-1001234567890`.
2. Put it into `.env` as `TELEGRAM_CHAT_ID`, stop the bot (Ctrl+C) and run `npm start` again.
3. The bot posts *"🟢 Радар квартир запущено"* and *"Фільтри ще не задані"* — reply to the latter with your filters.

Check that the sites are reachable from your network:

```bash
npm run dry   # one poll of every source; nothing is sent to Telegram
```

Expect lines like `lun: получено 24`, `domria: получено 18`.

## 4. Telegram channels (optional, very useful)

A regular bot cannot read other people's channels, so channels are read **on behalf of your own account** through
MTProto (the same protocol Telegram's apps use). The account only reads; it never posts.

1. [my.telegram.org](https://my.telegram.org) → **API development tools** → create an app (title and short name: any
   5+ characters, platform: Desktop, URL empty) → copy **api_id** and **api_hash** into `TG_API_ID` / `TG_API_HASH`.
2. Log in once:

   ```bash
   npm run tg-login
   ```

   - **QR (default):** on your phone open Telegram → **Settings → Devices → Link Desktop Device** and scan the QR in the
     terminal. Scan it *from inside Telegram* — the phone's camera app will be refused.
   - **Code (option 2):** the script tells you where Telegram sent the code (app chat "Telegram", SMS, e-mail, call);
     press Enter to request it again another way.
   - If you have two-step verification, the script asks for your cloud password.

   It prints `TG_SESSION=…` — put that line into `.env`.
3. List channels (you must be subscribed): `TG_CHANNELS=@channel_one,@channel_two,https://t.me/channel_three`
4. Restart. The start message lists the channels actually being listened to, and warns about any it could not find.

> ⚠️ `TG_SESSION` is full access to your account. Keep it only in `.env` (git-ignored), never share or commit it.
> Revoke it any time: Telegram → Settings → Devices → terminate the "lviv-flats-radar" session.

Only posts published after the bot starts are seen.

## Next

Deploy to a server so the bot runs 24/7: [deployment.md](deployment.md).
