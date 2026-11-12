import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { EMPTY_FILTERS, FILTERS, FILTERS_STATE } from '../src/config.ts';
import { SAMPLE_FILTERS, useSampleFilters } from './profile.ts';
import { Store } from '../src/db.ts';
import { hardFilter, score } from '../src/filter.ts';
import { applyFilters, clearFilters, describeFilters, filtersSnapshot, loadFilters, parseFiltersBasic, restoreSnapshot, sanitizeFilters } from '../src/filters.ts';
import { Pipeline } from '../src/pipeline.ts';
import { openLabel } from '../src/bot.ts';
import { cardTitle, mapUrl, renderLikedList, renderListing, renderStatusLines, renderTopList, renderViewings, sourceLine } from '../src/render.ts';
import { addManual } from '../src/manual.ts';
import { answerHelp, sanitizeHtml } from '../src/help.ts';
import type { Listing } from '../src/types.ts';
import { kyivTime, parseViewingTime } from '../src/when.ts';

useSampleFilters();

const listing = (over: Partial<Listing> = {}): Listing => ({
  id: 'x:1', source: 'olx', externalId: '1', url: 'https://x', text: 'Здається квартира', photos: [], phones: [],
  pets: 'dogs_ok', features: {}, dedupKeys: [], priceUsd: 800, district: 'Франківський', ...over,
});

test('Фільтри: простий розбір без ШІ', () => {
  const r = parseFiltersBasic('до 900$, Галицький і Шевченківський, 2к від 50 м²', SAMPLE_FILTERS);
  assert.equal(r.filters.maxPriceUsd, 900);
  assert.deepEqual(r.filters.districts, ['Галицький', 'Шевченківський']);
  assert.equal(r.filters.minRooms, 2);
  assert.equal(r.filters.maxRooms, 2);
  assert.equal(r.filters.minArea, 50);
  assert.ok(r.changes.length >= 3);
  // Решта лишилась як була
  assert.deepEqual(r.filters.wishes, SAMPLE_FILTERS.wishes);

  const uah = parseFiltersBasic('бюджет до 40000 грн', SAMPLE_FILTERS);
  assert.ok(uah.filters.maxPriceUsd > 700 && uah.filters.maxPriceUsd < 1100);
  assert.equal(parseFiltersBasic('будь-який район', SAMPLE_FILTERS).filters.districts.length, 6);
});

test('Фільтри: санітизація відповіді ШІ', () => {
  const f = sanitizeFilters({
    maxPriceUsd: 1200, districts: ['Франковский', 'Марс'], minRooms: 3, maxRooms: 1,
    wishes: { dishwasher: 9, gasStove: 0, unknownKey: 2 }, dreamComplexes: ['ЖК «Америка»'], extra: 'не перший поверх',
  });
  assert.equal(f.maxPriceUsd, 1200);
  assert.deepEqual(f.districts, ['Франківський']);
  assert.deepEqual([f.minRooms, f.maxRooms], [1, 3]);
  assert.deepEqual(f.wishes, { dishwasher: 3 });
  assert.deepEqual(f.dreamComplexes, ['америка']);
  assert.match(describeFilters(f), /не перший поверх/);
  assert.deepEqual(sanitizeFilters({ districts: ['Марс'] }, SAMPLE_FILTERS).districts, SAMPLE_FILTERS.districts, 'невідомий район не перетворюється на «всі»');
});

test('Фільтри: застосування, збереження і вплив на відбір', () => {
  const store = new Store(':memory:');
  try {
    assert.equal(hardFilter(listing({ priceUsd: 950 })).ok, true);
    applyFilters(store, { ...SAMPLE_FILTERS, maxPriceUsd: 900, minRooms: 2 });
    assert.equal(hardFilter(listing({ priceUsd: 950 })).ok, false);
    assert.equal(hardFilter(listing({ rooms: 1 })).ok, false);
    assert.equal(hardFilter(listing({ rooms: 2 })).ok, true);
    // Після «перезапуску» підтягуються з бази
    Object.assign(FILTERS, structuredClone(EMPTY_FILTERS));
    FILTERS_STATE.configured = false;
    loadFilters(store);
    assert.equal(FILTERS_STATE.configured, true);
    assert.equal(FILTERS.maxPriceUsd, 900);
  } finally {
    useSampleFilters();
  }
});

test('Дата перегляду', () => {
  const now = kyivTime(2026, 11, 11, 13, 0); // середа 11.11.2026 13:00 за Києвом
  assert.equal(parseViewingTime('завтра о 18:00', now).label, 'чт 12.11 о 18:00');
  assert.equal(parseViewingTime('пт 12:30', now).label, 'пт 13.11 о 12:30');
  assert.equal(parseViewingTime('14.11 18:30', now).label, 'сб 14.11 о 18:30');
  assert.equal(parseViewingTime('15 листопада о 10', now).label, 'нд 15.11 о 10:00');
  assert.equal(parseViewingTime('о 6', now).label, 'ср 11.11 о 18:00');
  assert.equal(parseViewingTime('10:00', now).label, 'чт 12.11 о 10:00', 'час уже минув — значить завтра');
  assert.equal(parseViewingTime('ср 10:00', now).label, 'ср 18.11 о 10:00', 'середа вже минула — наступна');
  assert.equal(parseViewingTime('в суботу', now).label, 'сб 14.11');
  assert.equal(parseViewingTime('завтра о 18:00', now).at, kyivTime(2026, 11, 12, 18, 0));
  assert.deepEqual(parseViewingTime('-', now), {});
  assert.deepEqual(parseViewingTime('після роботи', now), { label: 'після роботи' });
});

test('Картка: лайки, перегляд, відмова; списки', () => {
  const store = new Store(':memory:');
  const chat = '-1001234567890';
  store.saveMessage({ chatId: chat, messageId: 10, listingId: 'a', body: '🏠 <b>2к · $800</b>\n📍 Франківський\n…', openUrl: 'https://a' });
  store.saveMessage({ chatId: chat, messageId: 11, listingId: 'b', body: '🏠 <b>1к · $600</b>\n📍 Галицький', openUrl: 'https://b' });
  store.updateMessage(chat, 10, { liked_by: JSON.stringify(['Олена']), claimed_by: 'Андрій' });
  const at = kyivTime(2026, 11, 14, 18, 0);
  store.updateMessage(chat, 10, { deal_status: 'viewing', deal_by: 'Андрій', viewing_at: at, viewing_note: 'сб 14.11 о 18:00' });
  store.updateMessage(chat, 11, { deal_status: 'refused', deal_by: 'Олена' });

  const row = store.getMessage(chat, 10)!;
  const status = renderStatusLines(row);
  assert.match(status, /Подобається: Олена/);
  assert.match(status, /Дзвонить: Андрій/);
  assert.match(status, /Перегляд: сб 14\.11 о 18:00/);
  assert.match(renderStatusLines(store.getMessage(chat, 11)!), /Відмовили/);

  assert.equal(store.listLiked(chat).length, 1);
  const liked = renderLikedList(store.listLiked(chat));
  assert.match(liked, /2к · \$800 — 📍 Франківський/);
  assert.match(liked, /t\.me\/c\/1234567890\/10/);
  const views = renderViewings(store.listViewings(chat), kyivTime(2026, 11, 11, 12, 0));
  assert.match(views, /Перегляди \(1\)/);
  assert.match(views, /сб 14\.11 о 18:00/);
});

test('База: міграція старої таблиці messages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-'));
  const path = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE messages (chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, listing_id TEXT NOT NULL,
      body TEXT NOT NULL, open_url TEXT, preview_url TEXT, claimed_by TEXT, skipped_by TEXT, PRIMARY KEY (chat_id, message_id));
      INSERT INTO messages VALUES ('c', 1, 'l', 'body', 'u', NULL, 'Андрій', NULL);`);
    old.close();
    const store = new Store(path);
    const row = store.getMessage('c', 1)!;
    assert.equal(row.claimed_by, 'Андрій');
    assert.equal(row.liked_by, null);
    store.updateMessage('c', 1, { liked_by: '["Олена"]' });
    assert.equal(store.listLiked('c').length, 1);
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Першоджерело: Lun веде на OLX/Rieltor, підпис це показує', () => {
  const olxViaLun = listing({ source: 'lun', origin: 'olx.ua', url: 'https://www.olx.ua/d/uk/obyavlenie/x-ID11EtB0.html' });
  assert.equal(sourceLine(olxViaLun), 'OLX · знайдено через Lun');
  assert.equal(openLabel(olxViaLun.url), '🔗 Відкрити на OLX');
  assert.equal(sourceLine(listing({ source: 'lun', url: 'https://rieltor.ua/lvov/flats-rent/view/1/' })), 'Rieltor · знайдено через Lun');
  assert.equal(sourceLine(listing({ source: 'olx', url: 'https://www.olx.ua/d/x.html' })), 'OLX');
  assert.equal(sourceLine(listing({ source: 'telegram', origin: 'Оренда Львів', url: 'https://t.me/orenda/1' })), 'Telegram (Оренда Львів)');
  assert.equal(openLabel('https://t.me/orenda/1'), '🔗 Відкрити пост у Telegram');
});

test('Картка: ❌ яких «хотілок» немає і посилання на карту', () => {
  const l = listing({
    features: { dishwasher: true, gasStove: false, airConditioner: true },
    lat: 49.8, lon: 24.01, address: 'вул. Героїв УПА, 73',
  });
  const html = renderListing(l, score(l));
  assert.match(html, /✅ посудомийна машина, кондиціонер/);
  assert.match(html, /❌ газова плита · не вказано: підземний паркінг, кондиціонер у спальні, душ/);
  assert.match(html, /<a href="https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=49\.8,24\.01">На карті<\/a>/);
  assert.equal(mapUrl(listing({ address: 'вул. Стрийська, 1' })), 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('вул. Стрийська, 1, Львів'));
  assert.equal(mapUrl(listing()), undefined, 'лише район — без карти');
  assert.ok(!cardTitle(html).includes('На карті'));
});

const RIELTOR_HTML = `<html><head><title>Оренда</title>
<meta property="og:title" content="1-кімнатна квартира, Кульпарківська 64-А">
<meta name="description" content="Оголошення №13212890: Кульпарківська вул., 64-А, Франківський р-н, Львів">
<meta property="og:description" content="700 $/міс - 1 кімната - З ремонтом - 5 поверх 14-пов. - 52 / 40 / 12 м²">
<script>var x = {"latitude": 49.8123, "longitude": 24.0011}</script></head>
<body><nav>Меню 0800123456</nav><div>Затишна квартира, є посудомийна машина. Можна з тваринами.</div></body></html>`;

test('/add: збирає картку зі сторінки і ставить «Подобається»', async () => {
  const store = new Store(':memory:');
  const sent: Array<{ id: string; body: string; likedBy?: string }> = [];
  const fakeBot = {
    sendListing: async (id: string, body: string, _u: string, _p?: string, init: { likedBy?: string } = {}) => {
      sent.push({ id, body, likedBy: init.likedBy });
      store.saveMessage({ chatId: '-100500', messageId: 77, listingId: id, body, openUrl: _u });
      store.updateMessage('-100500', 77, { liked_by: JSON.stringify([init.likedBy]) });
      return 77;
    },
    likeCard: async (row: any, who: string) => { sent.push({ id: 'like:' + row.message_id, body: '', likedBy: who }); },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(RIELTOR_HTML, { status: 200 })) as any;
  try {
    const url = 'https://rieltor.ua/lvov/flats-rent/view/13212890/';
    await addManual(store, fakeBot as any, `${url} дзвонити після 18`, '-100500', 'Олена');
    assert.equal(sent.length, 1);
    const card = sent[0];
    assert.equal(card.likedBy, 'Олена');
    assert.match(card.body, /\$700/);
    assert.match(card.body, /Франківський/);
    assert.match(card.body, /query=49\.8123,24\.0011/);
    assert.match(card.body, /Додано вручну \(Олена\)/);
    assert.match(card.body, /Rieltor · додано вручну/);
    assert.ok(!card.body.includes('0800123456'), 'телефони з меню сайту не беремо');
    assert.ok(store.isSeen('rieltor:13212890'), 'бот не надішле її вдруге');

    // Та сама квартира ще раз (з ?utm) — нова картка не створюється, лише лайк
    const r = await addManual(store, fakeBot as any, `${url}?utm_source=x`, '-100500', 'Андрій');
    assert.equal(sent.length, 2);
    assert.deepEqual([sent[1].id, sent[1].likedBy], ['like:77', 'Андрій']);
    assert.match(String(r), /вже є в чаті/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/add: сторінка не відкрилась — картка з нотатки', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('', { status: 403 })) as any;
  const bodies: string[] = [];
  const fakeBot = { sendListing: async (_id: string, body: string) => { bodies.push(body); return 1; } };
  try {
    await addManual(new Store(':memory:'), fakeBot as any, 'https://www.olx.ua/d/uk/obyavlenie/x-ID11Ew94.html 2к $800 Галицький р-н 0671234567', '-1', 'Олена');
    assert.match(bodies[0], /\$800/);
    assert.match(bodies[0], /Галицький/);
    assert.match(bodies[0], /\+380671234567/);
    assert.match(bodies[0], /Сторінка не відкрилась/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Топ: шапка «🔥 ТОП» від 7 балів і список /top', () => {
  const top = listing({ features: { undergroundParking: true, dishwasher: true, acInBedroom: true, gasStove: true, shower: true }, complex: 'ЖК Америка' });
  const s = score(top);
  assert.ok(s >= 7, `очікували ≥7, отримали ${s}`);
  const html = renderListing(top, s);
  assert.ok(html.startsWith(`🔥 <b>ТОП ${s}/10</b>\n`));
  assert.ok(!renderListing(listing(), score(listing())).includes('ТОП'));
  assert.ok(!cardTitle(html).includes('ТОП'), 'у списках заголовок без шапки');

  const store = new Store(':memory:');
  store.saveListing('a', 'olx', 'https://a', 'notified', { score: s });
  store.saveListing('b', 'olx', 'https://b', 'notified', { score: 4 });
  store.saveMessage({ chatId: '-1001', messageId: 1, listingId: 'a', body: html, openUrl: 'https://a' });
  store.saveMessage({ chatId: '-1001', messageId: 2, listingId: 'b', body: '🏠 <b>1к</b>\n📍 Галицький', openUrl: 'https://b' });
  const rows = store.listTop('-1001', 7);
  assert.deepEqual(rows.map((r) => r.listing_id), ['a']);
  const list = renderTopList(rows);
  assert.ok(list.includes('оцінка 7+ (1)'));
  assert.ok(list.includes(`<b>${s}/10</b> · `));
});

test('Help: без ШІ — коротка довідка; HTML від моделі чиститься', async () => {
  const r = await answerHelp('як підняти мін. поріг до 3?');
  assert.match(String(r), /\/filters мін\. оцінка 3/);
  assert.equal(sanitizeHtml('Напишіть <code>/filters мін. оцінка 3</code> <script>x</script> **важливо**'),
    'Напишіть <code>/filters мін. оцінка 3</code> &lt;script&gt;x&lt;/script&gt; <b>важливо</b>');
});

test('Без фільтрів бот нічого не надсилає; перший /filters вмикає пошук; очистити/скасувати', async () => {
  const store = new Store(':memory:');
  const sent: string[] = [];
  const p = new Pipeline(store, { sendListing: async (id: string) => { sent.push(id); } } as any);
  try {
    clearFilters(store);
    assert.match(describeFilters(), /Фільтри ще не задані/);
    await p.enqueue(listing({ id: 'olx:1', dedupKeys: ['olx:1'], publishedAt: new Date() }));
    assert.deepEqual(sent, []);
    assert.equal(store.getStatus('olx:1'), 'rejected');

    // Перший текст фільтрів будується від «порожніх»: не згадане — без обмежень
    const first = parseFiltersBasic('до 900$, Галицький', EMPTY_FILTERS).filters;
    assert.equal(first.maxPriceUsd, 900);
    assert.equal(first.dogFriendly, false);
    assert.deepEqual(first.wishes, {});
    const before = filtersSnapshot();
    assert.equal(before, 'null');
    applyFilters(store, first);
    assert.equal(FILTERS_STATE.configured, true);
    await p.enqueue(listing({ id: 'olx:2', dedupKeys: ['olx:2'], district: 'Галицький', priceUsd: 800, publishedAt: new Date() }));
    assert.deepEqual(sent, ['olx:2']);

    // «Скасувати» після першого задання повертає стан «не задані»
    restoreSnapshot(store, before);
    assert.equal(FILTERS_STATE.configured, false);
    assert.equal(store.getKv('filters'), undefined);
  } finally {
    useSampleFilters();
  }
});

test('Оцінка без «хотілок» — 0, а не ТОП', () => {
  try {
    Object.assign(FILTERS, structuredClone(EMPTY_FILTERS));
    assert.equal(score(listing({ features: { allWhiteInterior: false, dishwasher: true } })), 0);
  } finally {
    useSampleFilters();
  }
});
