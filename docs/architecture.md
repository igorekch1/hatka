# Architecture

A single Node.js process (TypeScript executed natively by Node 22) with an SQLite file next to it.

```
                 ┌──────────── src/sources ────────────┐
  OLX  ──poll──► │ olx.ts     ┐                         │
  Lun  ──poll──► │ lun.ts     ├─► Listing (normalized)  │──► Pipeline (one queue) ──► Bot API ──► group
  DIM.RIA poll─► │ domria.ts  ┘                         │        │       ▲
  TG channels ─► │ telegram.ts (MTProto push)           │        ▼       │ callbacks, commands, replies
                 └──────────────────────────────────────┘      SQLite ◄──┘
```

## Sources

Every source maps its own data into one `Listing` shape (`src/types.ts`): price and currency, rooms, area, floor,
district, address, coordinates, phones, pets policy, amenities (`features`), publication time, the URL of the original
listing and a set of **dedup keys**.

| Source | How | Notes |
|---|---|---|
| **OLX** | Internal JSON API used by the site, newest 40 in "long-term rent, Lviv" | Structured pets field, appliances. Phones are hidden. Currently returns 403 to non-browser clients |
| **Lun.ua** | Lun's own API | Aggregates Rieltor/OLX/DIM.RIA; gives phones, pets, appliances, shelter info and the **original URL** (used for the card link). ~30 min behind the originals |
| **DIM.RIA** | Search returns ids; details are fetched **only for unseen ids** | Often gives a neighbourhood instead of a district → mapped via `MICRODISTRICT_TO_DISTRICT` |
| **Telegram** | gramjs (MTProto) logged in as the user, `NewMessage` events for the listed channels | Instant, no polling. Free text only, so the LLM does most of the work |

Polling uses jittered intervals (±20%) and a browser User-Agent. Five consecutive failures of a source trigger a warning
in the chat; recovery is reported too. The NBU exchange rate is refreshed periodically to convert UAH/EUR prices.

## Pipeline (`src/pipeline.ts`)

All listings go through **one promise queue**, strictly sequentially — deduplication reads and writes the `seen` table,
and concurrent processing would let two copies of the same flat slip through.

1. **Exact dedup** — any of the listing's keys already in `seen` → skip (and link the copy to the original).
2. **Age** — older than `MAX_AGE_HOURS` → skip (bumped ads, first-start flood).
3. **Fuzzy dedup** — fingerprints: phone + area, address + area + price bucket, district + area + price bucket.
   A flat already sent *or rejected* from another site or realtor is not processed again.
4. **No filters set** → reject without spending an LLM call.
5. **Hard filters** (`hardFilter`) — price, district, rooms, area, pets, text red flags (daily rent, sale, room share,
   "one person only", "looking for a flat" posts). "Pets negotiable" in the text overrides a "no pets" checkbox.
6. **LLM analysis** (`src/ai.ts`) — Claude returns strict JSON: is it a long-term rental offer, price, district
   (inferred from street / complex), rooms, area, phones, pets policy, amenities, red flags, whether the custom `extra`
   requirements are met, and a one-line Ukrainian summary. Site data wins over LLM guesses; the LLM only fills gaps.
7. **Hard filters again** on the enriched listing, then **keyword features** as a cheap fallback.
8. **Fingerprint dedup again** — the LLM may have discovered a phone or district that reveals a duplicate.
9. **Score** and `minScore` check, pause check.
10. **Render and send**, with retries (and a retry without the link preview if Telegram fails to fetch it).

Uncertain data is deliberately let through: an unknown district or unknown pets policy produces a flagged card rather
than a rejection — a wasted call is cheaper than a missed flat. If the LLM is unavailable, the listing is processed with
keyword parsing instead of being dropped.

## Scoring (`score` in `src/filter.ts`)

`score = confirmed weight / total weight × 10`, where the total is the sum of the user's wish weights, plus 0.5 for
"interior not all white" and 1.5 for a dream complex. Partial credit: an air conditioner somewhere counts half of
"AC in the bedroom", plain parking a quarter of underground parking. Unknown amenities score 0 without a penalty.
No wishes and no dream complexes → score 0 (nothing to rank by).

## Bot interaction (`src/bot.ts`)

- **Long polling** (`getUpdates`) runs alongside the source loops.
- **Cards** carry inline buttons; the state (likes, who is calling, deal status, viewing time) is stored per message and
  the card is re-rendered with `editMessageText`.
- **Menu buttons** use `m:<command>` callback data and are routed to the same handler as slash commands.
- **Conversational steps** (filters, viewing date, `/add`, `/help`) send a `force_reply` prompt and store
  `pending:<chat>:<message>` in SQLite. The user's reply is matched by `reply_to_message` — this works with the bot's
  group privacy mode enabled, where ordinary messages are invisible to the bot.
- Long lists are split at paragraph boundaries to stay within Telegram's message size limit.

## Natural-language features

| Feature | Module | Approach |
|---|---|---|
| Filters from text | `src/filters.ts` | Claude gets the current filters as JSON plus the user's text and returns the full updated object and a list of changes; the result is sanitised and diffed. Offline regex fallback without a key |
| `/help` | `src/help.ts` | Claude answers from a built-in manual (`MANUAL`) and the current filters; output is restricted to Telegram-safe HTML |
| Viewing dates | `src/when.ts` | Deterministic parser (no LLM): relative days, weekdays, `dd.mm`, Ukrainian/Russian month names, times; computed in Europe/Kyiv independently of the server's time zone |
| `/add` | `src/manual.ts` | DIM.RIA via its API; other sites via `og:` meta tags and visible page text, then the same LLM enrichment; falls back to the user's note if the page is blocked |

## Storage (`src/db.ts`, SQLite via `node:sqlite`)

| Table | Purpose |
|---|---|
| `seen` | Dedup keys and fingerprints → listing id (pruned after 60 days) |
| `listings` | Every processed listing: status (`notified`, `rejected`, `duplicate`, `old`, `manual`, `error`), reason, score |
| `messages` | Sent cards: body, links, likes, caller, deal status, viewing time |
| `kv` | Filters, previous filters (undo), pause flag, pending reply prompts |

Columns added in later versions are created on startup with `ALTER TABLE` if missing, so old databases keep working.

## Testing

`npm test` runs `node:test` suites:

- parsers for every source on captured fixtures;
- hard filters, scoring, rendering and HTML escaping;
- the full pipeline with a fake bot (dedup across sites, age, rejection);
- a **replay of real OLX and Lun listings** captured on 11.11.2026 with the expected set of sent / rejected / duplicate ids;
- filters parsing and sanitising, viewing-date parsing, card state, `/add` with a mocked `fetch`, DB migrations.
