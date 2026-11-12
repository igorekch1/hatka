# Using the bot

All interaction happens in one Telegram group. The bot's interface is in Ukrainian; quoted UI strings below are given
as they appear in the chat, with a translation where useful.

> **Reply, don't just type.** In groups a Telegram bot (with the default privacy mode) only sees commands and replies to
> its own messages. Whenever the bot asks for something — filters, a viewing date, a link — answer **as a reply** to that
> message. The reply box opens automatically.

## Commands

| Command | What it does |
|---|---|
| `/menu` | Inline menu: filters, top, liked, viewings, add your own, status, pause, help |
| `/filters` | Show current filters. `/filters <text>` changes them right away |
| `/top` | Listings scored 7+ over the last 30 days |
| `/liked` | Everything someone pressed ❤️ on |
| `/viewings` | Scheduled viewings, upcoming first |
| `/add <link> [note]` | Add a flat you found yourself |
| `/help [question]` | Ask anything about the bot in plain words |
| `/status` | Source health and 24-hour statistics (sent / rejected / duplicates, top rejection reasons) |
| `/pause`, `/resume` | Stop / resume notifications (listings are still remembered, so nothing old floods in later) |
| `/chatid` | Print the chat id (needed once during setup) |

## The card

```
🔥 ТОП 8.6/10                                   ← only for score ≥ 7
⭐️ 2к · 62 м² · $850 (≈39 100 грн)              ← ⭐️ = "dream" residential complex
📍 district · complex · address · floor · На карті   ← Google Maps link (coordinates or address)
🐕 Собака: можна ✅                             ← pets policy
✅ amenities that are present
❌ wishes that are absent · не вказано: wishes not mentioned (ask on the phone)
⭐ score · 🕐 age · original site · found via aggregator
🏢 realtor / 👤 owner · no commission
📞 phone
💬 one-line summary by the LLM
```

The open button always points at the **original** listing: a Lun card that mirrors a Rieltor listing opens Rieltor
("🔗 Відкрити на Rieltor").

### Buttons

| Button | Behaviour |
|---|---|
| ❤️ Подобається (Like) | Per person; several people can like the same flat. Press again to remove |
| 📞 Дзвоню я (I'm calling) | Claims the flat; others get an alert if they try to claim it too |
| 📅 Записались на перегляд (Viewing booked) | The bot asks *"Коли перегляд?"* — reply with a date in free form. Press again to change the date, or reply `скасувати` to cancel |
| 🚫 Відмовили (Rejected by the owner) | Toggle |
| ❌ Не підходить (Not suitable) | Toggle |

Viewing dates understood (Europe/Kyiv time): `завтра о 18:00`, `пт 12:30`, `14.11 18:00`, `15 листопада о 10`, `о 6`
(evening is assumed for 1–7 without minutes), `-` for "date unknown yet". Anything unparseable is stored as typed.

## Filters

There are **no default filters**: until filters are set, the bot sends nothing. On first start (and after clearing)
it posts *"Фільтри ще не задані"* ("filters are not set") — reply to that message with your criteria and the search
starts immediately. No extra command is needed.

Write filters as a list or as free text, for example:

```
до 900$, Франківський або Галицький, 2 кімнати від 50 м², з собакою середнього розміру,
обов'язково посудомийка і паркінг, бажано газова плита, не перший поверх
```

or change one thing at a time: `/filters підніми бюджет до 1100`, `/filters додай Личаківський`, `/filters мін. оцінка 3`.

What the LLM extracts:

| Field | Example phrase |
|---|---|
| Max / min price (UAH and EUR converted at the NBU rate) | `до 900$`, `до 40 000 грн` |
| Districts (6 administrative districts of Lviv) | `Франківський або Галицький`, `будь-який район` |
| Send listings without a district | `якщо район не вказано — теж надсилати` |
| Rooms, area | `2 кімнати`, `від 2 кімнат`, `від 50 м²` |
| Medium-sized dog; reject "small dogs only" | `з собакою` |
| Reject "one person only" | `відсікати «лише для однієї особи»` |
| Dream residential complexes (score bonus, ⭐️) | `ЖК мрії: Америка` |
| Weighted wishes (0.5–3) | `обов'язково паркінг`, `бажано світла`, `посудомийка — вага 1.5` |
| Minimum score | `мін. оцінка 3` |
| Anything else → "extra requirements", checked by the LLM per listing | `не перший поверх`, `з балконом` |

After every change the bot shows what changed and the full filter set, with **↩️ Скасувати зміни** (undo).
**🗑 Очистити** clears the filters and stops notifications. Filters apply to new listings only and survive restarts.
Whatever you did not mention is unrestricted (no price → any price, no districts → all districts).

Without an Anthropic API key a simple offline parser understands only price, districts, rooms, area, minimum score and
"with/without a dog".

## Score (0–10)

The share of your weighted wishes that are **confirmed** in the listing, plus +0.5 if the interior is known not to be
all-white and a bonus for dream complexes. Unknown amenities give 0 points but are not penalised. Price, district and
pets do not affect the score — they are filters. Cards with a score of **7+** get the 🔥 header and appear in `/top`.

Because unknown = 0, short listings score low even when they are good — keep `мін. оцінка` (minimum score) at 0–3.

## Adding your own flats

`/add <link>` (or **➕ Додати свою квартиру** in the menu) builds a card from any listing URL — OLX, DIM.RIA,
Rieltor, Lun, a public Telegram post — and marks it ❤️ by whoever added it. Filters are not applied. Text after the link
is used as a note, which helps when the site refuses to serve the page:

```
/add https://www.olx.ua/d/uk/obyavlenie/... 2к, $800, Галицький, 0671234567
```

If the flat is already in the chat (sent by the bot or added before, even with a different `?utm`), no duplicate is
created — the existing card gets your like.

## Asking for help

`/help <question>` or **❓ Допомога** in the menu. Questions are answered by Claude using the built-in manual
(`MANUAL` in `src/help.ts`) and your current filters, always with a ready-to-copy command. Without an API key the bot
shows a short static cheat sheet.
