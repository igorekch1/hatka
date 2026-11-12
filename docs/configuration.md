# Configuration

## Environment variables

Set in `.env` (git-ignored). Copy [`.env.example`](../.env.example) to start.

| Variable | Required | Default | Description |
|---|---|---|---|
| `CITY` | no | `lviv` | City profile: `lviv`, `kyiv`, `odesa`, `kharkiv`, `dnipro` (see [Cities](#cities)) |
| `OLX_REGION_ID`, `OLX_CITY_ID` | no | from profile | OLX location ids; needed for OLX outside Lviv |
| `TELEGRAM_BOT_TOKEN` | yes | — | Token from @BotFather |
| `TELEGRAM_CHAT_ID` | yes | — | Group id; get it with `/chatid`. While empty, the bot only answers `/chatid` |
| `ANTHROPIC_API_KEY` | recommended | — | Enables LLM parsing of listings, natural-language filters and `/help` |
| `ANTHROPIC_MODEL` | no | `claude-haiku-5-5` | Model used for all LLM calls |
| `TG_API_ID`, `TG_API_HASH` | for channels | — | From my.telegram.org → API development tools |
| `TG_SESSION` | for channels | — | Session string printed by `npm run tg-login`. **Secret** |
| `TG_CHANNELS` | for channels | — | Comma-separated `@username` or `t.me/...` links; you must be subscribed |
| `SOURCES` | no | `olx,lun,domria,telegram` | Enabled sources. OLX currently blocks non-browser clients — use `lun,domria,telegram` |
| `POLL_SECONDS` | no | `60` | Polling interval for sites (DIM.RIA is polled 1.5× less often), ±20% jitter |
| `MAX_AGE_HOURS` | no | `3` | Older listings are ignored (protects from "bumped" ads and from a flood on first start) |
| `FX_FALLBACK_UAH_PER_USD` | no | `46` | Exchange rate if the National Bank of Ukraine API is unavailable |
| `DB_PATH` | no | `./data/radar.db` | SQLite file. In Docker it is `/data/radar.db` on a mounted volume |
| `DRY_RUN` | no | — | `1` = print cards to the console instead of sending (used by `npm run dry`) |
| `USER_AGENT` | no | desktop Chrome | User-Agent for HTTP requests to the sites |

## Filters

Filters are **not** configured in files — they are set from the chat (`/filters`, see [usage.md](usage.md)), validated
and stored in SQLite (`kv` table, key `filters`). Until they are set, the bot sends nothing.

The model (`Filters` in `src/config.ts`):

| Field | Type | Meaning |
|---|---|---|
| `maxPriceUsd` / `minPriceUsd` | number | Price range in USD; `100000` means "no limit". `minPriceUsd` defaults to 150 as a scam guard |
| `districts` | string[] | Allowed administrative districts of the configured city |
| `allowUnknownDistrict` | boolean | Let listings without a detectable district through (flagged) |
| `minRooms`, `maxRooms`, `minArea` | number \| null | `null` = no limit |
| `dogFriendly` | boolean | Reject "no pets" / "no dogs" (unless the text says pets are negotiable) |
| `rejectSmallDogsOnly` | boolean | Reject "small dogs only" |
| `rejectOnlyOnePerson` | boolean | Reject "for one person only" |
| `dreamComplexes` | string[] | Residential complexes that get a score bonus and the ⭐️ mark |
| `wishes` | `{ feature: weight }` | Weighted amenities (0.5–3): `undergroundParking`, `parking`, `dishwasher`, `airConditioner`, `acInBedroom`, `gasStove`, `shower`, `twoDesks`, `bright` |
| `minScore` | 0–10 | Listings scoring lower are not sent |
| `extra` | string | Free-text requirements the LLM checks for every listing ("not the ground floor") |

Every value coming from the LLM goes through `sanitizeFilters`: numbers are clamped, unknown districts and features are
dropped (an unrecognised district list keeps the previous one), inverted ranges are swapped.

## Constants

In `src/config.ts`:

- `TOP_SCORE = 7` — score from which a card gets the 🔥 header and appears in `/top`;
- `DREAM_COMPLEX_BONUS = 1.5`, `NOT_ALL_WHITE_WEIGHT = 0.5` — fixed score components;

## Cities

`CITY` picks a profile from `src/cities.ts`:

| `CITY` | City | Lun `geoId` | DIM.RIA `state_id/city_id` | OLX ids | Districts | Neighbourhood table |
|---|---|---|---|---|---|---|
| `lviv` | Львів | 10012684 | 5 / 5 | 5 / 176 | 6 | yes |
| `kyiv` | Київ | 10009580 | 10 / 10 | set via env | 10 | — |
| `odesa` | Одеса | 10016589 | 12 / 12 | set via env | 4 (post-2020) | — |
| `kharkiv` | Харків | 10024345 | 7 / 7 | set via env | 9 | — |
| `dnipro` | Дніпро | 10006463 | 11 / 11 | set via env | 8 | — |

Lun and DIM.RIA ids were verified against the live APIs (they return listings of that city). OLX ids could not be
verified because OLX blocks API clients; they are known for Lviv only.

**Adding a city:**

1. **Lun:** open `https://lun.ua/rent/<city>/flats` — the page source contains `?geo_id=<id>&section_id=2`.
2. **DIM.RIA:** for regional centres `state_id` and `city_id` are usually the same number; check that
   `https://dom.ria.com/node/searchEngine/v2/?category=1&realty_type=2&operation=3&state_id=<id>&city_id=<id>&limit=5`
   returns listings of that city.
3. **Districts:** list the administrative districts with a `match` regex covering Ukrainian and Russian spellings and
   former names; set `centerDistrict`; optionally add `microdistricts`.
4. Add the profile to `CITIES` and run `npm test` — a test checks that every district name is recognised unambiguously.

Changing `CITY` for an existing database: saved filters keep only districts that exist in the new city (if none
remain, all districts are allowed) — re-check them with `/filters`.
