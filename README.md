# 🏠 Hatka — rental radar for Lviv

A Telegram bot that watches every major Ukrainian rental marketplace and a set of Telegram channels, picks out the
long-term apartment listings in Lviv that match your criteria, and posts them to a shared group chat **within about a
minute of publication** — then helps the people in that group coordinate who calls, what they liked and when the
viewings are.

> *Hatka* (хатка) is Ukrainian for "little house".

## The problem

Renting in Lviv is a race. Good apartments are gone within hours, and they are spread across OLX, DIM.RIA,
Rieltor/Lun and dozens of Telegram channels — each with its own filters (or none), duplicates of the same flat posted by
several realtors, and important details (pets allowed? gas stove? underground parking?) buried in free text.
Searching together with someone else adds another layer: who already called this one, which ones did we both like,
when is the viewing?

## What the bot does

- **Aggregates** OLX, DIM.RIA, Lun.ua (which itself mirrors Rieltor, OLX and DIM.RIA) and any Telegram channels you
  are subscribed to — sites are polled every ~60 s, channels arrive instantly as push events.
- **Deduplicates** the same flat across sites and realtors (source URL, phone + area, address, district + area + price).
- **Filters** by price, district, rooms, area, pets and red flags ("daily rent", "for one person only", sales, room shares).
- **Understands free text with an LLM** (Claude Haiku): extracts price, district (from street or residential complex),
  pets policy, amenities and red flags, and checks custom requirements like "not the ground floor".
- **Scores** each flat 0–10 against your weighted wish list and marks the best ones as **🔥 TOP**.
- **Posts a rich card** linking to the *original* listing (not the aggregator), with a Google Maps link and a list of what
  is present and what still needs to be asked on the phone.
- **Turns the group chat into a lightweight CRM**: ❤️ like, 📞 "I'm calling", 📅 viewing scheduled (with a date parsed from
  "tomorrow at 6 pm"), 🚫 rejected, ❌ not suitable; lists of liked flats, top flats and upcoming viewings.
- **Is configured in plain language**: `/filters до 900$, Галицький або Франківський, 2 кімнати, обов'язково посудомийка`
  ("up to $900, Halytskyi or Frankivskyi, 2 rooms, a dishwasher is a must") — the LLM turns it into structured filters,
  shows the diff and offers an undo.
- **Answers questions about itself**: `/help як підняти мін. поріг до 3?` ("how do I raise the minimum score to 3?") is
  answered by Claude from a built-in manual.
- **Tracks flats found manually**: `/add <link>` builds the same card from any listing URL.

## What a card looks like

The bot talks Ukrainian to its users:

```
🔥 ТОП 8.6/10
⭐️ 2к · 62 м² · $850 (≈39 100 грн)
📍 Франківський · ЖК Америка · вулиця Героїв УПА, 73 · 7/16 пов. · На карті
🐕 Собака: можна ✅
✅ підземний паркінг, посудомийна машина, кондиціонер у спальні, газова плита, душ, світла
❌ не вказано: місце під 2 робочі столи
⭐ 8.6/10 · 🕐 2 хв тому · Rieltor · знайдено через Lun
🏢 рієлтор
📞 +380671234567
💬 Світла двокімнатна в новому будинку, кухня-вітальня, можна з тваринами

❤️ Подобається: Олена
📞 Дзвонить: Андрій
📅 Перегляд: сб 14.11 о 18:00 (Андрій)
[🔗 Відкрити на Rieltor]
[❤️ Подобається] [📞 Дзвоню я]
[📅 Записались на перегляд]
[🚫 Відмовили] [❌ Не підходить]
```

## How it works

```
OLX, DIM.RIA, Lun ──┐ polled every ~60 s
                    ├──► normalized Listing ──► dedup ──► age check ──► hard filters ──► LLM parsing ──► score ──► card
Telegram channels ──┘ pushed instantly (MTProto)                                                                │
                                                                                                                ▼
                                       likes · calls · viewings · /top · /liked · /viewings  ◄── Telegram group (Bot API)
```

Details: [docs/architecture.md](docs/architecture.md).

## Engineering highlights

- **Zero-framework, two runtime dependencies.** HTTP, SQLite (`node:sqlite`), the Telegram Bot API and the Anthropic API
  are all used through Node 22 built-ins; TypeScript runs natively via Node's type stripping — no build step.
  The only packages are `telegram` (gramjs, MTProto client for reading channels) and `qrcode-terminal` (QR login).
- **Sequential processing pipeline** — every listing passes through a single queue, so cross-source deduplication never races.
- **Cheap checks before expensive ones** — dedup, age and hard filters run before the LLM call; the model only sees
  listings that can still match. Without an API key the bot degrades to keyword parsing instead of failing.
- **"Miss nothing" bias** — uncertain data (unknown district, pets not mentioned) is let through and flagged ⚠️ rather than dropped.
- **Natural-language configuration with guardrails** — LLM output is validated and clamped (`sanitizeFilters`),
  unknown values are dropped, every change shows a diff and can be undone.
- **Stateless UI on top of chat** — conversational steps (filters, viewing date, `/add`) use `force_reply` prompts tracked in
  SQLite, which works with the bot's group privacy mode on.
- **Time zone–correct date parsing** for viewings ("пт 12:30", "15 листопада о 10") in Europe/Kyiv regardless of the server's zone.
- **Tests on real data** — `node:test` suite including a replay of real OLX and Lun listings captured on 11.11.2026.

## Tech stack

TypeScript · Node.js 22 · SQLite (`node:sqlite`) · Telegram Bot API · MTProto (gramjs) · Anthropic Claude API ·
Docker / Docker Compose · `node:test`

## Quick start

```bash
git clone https://github.com/igorekch1/hatka.git && cd hatka
npm install
cp .env.example .env   # add TELEGRAM_BOT_TOKEN (and ideally ANTHROPIC_API_KEY)
npm start              # then write /chatid in your group, put it into .env, restart
```

On first start the bot asks for filters — reply to its message with what you are looking for, and the search begins.

## Documentation

| | |
|---|---|
| [docs/usage.md](docs/usage.md) | Commands, card buttons, filters, scoring, `/add`, `/help` |
| [docs/setup.md](docs/setup.md) | Telegram bot and group, Anthropic key, Telegram channels, running locally |
| [docs/deployment.md](docs/deployment.md) | Step-by-step deployment to a VPS with Docker, operations and troubleshooting |
| [docs/configuration.md](docs/configuration.md) | Environment variables and the filter model |
| [docs/architecture.md](docs/architecture.md) | Sources, pipeline, deduplication, LLM parsing, scoring, storage |

## Development

```bash
npm test          # unit tests + replay of real listings
npm run typecheck
npm run dry       # poll all sources once and print results, nothing is sent to Telegram
```

## Project structure

```
src/
  index.ts        entry point: polling loops, commands, menu
  pipeline.ts     dedup → filters → LLM → score → send
  sources/        olx, lun, domria (HTTP polling), telegram (MTProto push)
  filter.ts       hard filters, keyword features, scoring
  filters.ts      user filters: natural-language parsing, validation, persistence
  ai.ts           Claude API: listing analysis
  bot.ts          Telegram Bot API: cards, buttons, reply prompts
  render.ts       card and list rendering
  manual.ts       /add — cards from arbitrary listing URLs
  help.ts         /help — answers from the built-in manual
  when.ts         viewing date parsing (Europe/Kyiv)
  db.ts           SQLite storage
scripts/tg-login.ts  one-time Telegram login (QR or code) for reading channels
test/             node:test suites and real-data fixtures
```

## Status and limitations

A personal project, built for and used during an actual apartment search in Lviv.

- OLX currently blocks non-browser clients (HTTP 403 even from residential networks); OLX listings still arrive through Lun
  with a ~30-minute delay, so `olx` is disabled in the default `SOURCES`.
- Only new Telegram posts are seen — channel history is not read.
- The bot's UI language is Ukrainian. Filters and `/help` questions are understood by the LLM in any language; the offline
  fallback parser (used without an API key) understands Ukrainian and Russian only.
