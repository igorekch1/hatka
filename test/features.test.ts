import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { DEFAULT_FILTERS, FILTERS } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { hardFilter } from '../src/filter.ts';
import { applyFilters, describeFilters, loadFilters, parseFiltersBasic, sanitizeFilters } from '../src/filters.ts';
import { openLabel } from '../src/bot.ts';
import { renderLikedList, renderStatusLines, renderViewings, sourceLine } from '../src/render.ts';
import type { Listing } from '../src/types.ts';
import { kyivTime, parseViewingTime } from '../src/when.ts';

const listing = (over: Partial<Listing> = {}): Listing => ({
  id: 'x:1', source: 'olx', externalId: '1', url: 'https://x', text: 'Здається квартира', photos: [], phones: [],
  pets: 'dogs_ok', features: {}, dedupKeys: [], priceUsd: 800, district: 'Франківський', ...over,
});

test('Фільтри: простий розбір без ШІ', () => {
  const r = parseFiltersBasic('до 900$, Галицький і Шевченківський, 2к від 50 м²', DEFAULT_FILTERS);
  assert.equal(r.filters.maxPriceUsd, 900);
  assert.deepEqual(r.filters.districts, ['Галицький', 'Шевченківський']);
  assert.equal(r.filters.minRooms, 2);
  assert.equal(r.filters.maxRooms, 2);
  assert.equal(r.filters.minArea, 50);
  assert.ok(r.changes.length >= 3);
  // Решта лишилась як була
  assert.deepEqual(r.filters.wishes, DEFAULT_FILTERS.wishes);

  const uah = parseFiltersBasic('бюджет до 40000 грн', DEFAULT_FILTERS);
  assert.ok(uah.filters.maxPriceUsd > 700 && uah.filters.maxPriceUsd < 1100);
  assert.equal(parseFiltersBasic('будь-який район', DEFAULT_FILTERS).filters.districts.length, 6);
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
});

test('Фільтри: застосування, збереження і вплив на відбір', () => {
  const store = new Store(':memory:');
  try {
    assert.equal(hardFilter(listing({ priceUsd: 950 })).ok, true);
    applyFilters(store, { ...DEFAULT_FILTERS, maxPriceUsd: 900, minRooms: 2 });
    assert.equal(hardFilter(listing({ priceUsd: 950 })).ok, false);
    assert.equal(hardFilter(listing({ rooms: 1 })).ok, false);
    assert.equal(hardFilter(listing({ rooms: 2 })).ok, true);
    // Після «перезапуску» підтягуються з бази
    Object.assign(FILTERS, structuredClone(DEFAULT_FILTERS));
    loadFilters(store);
    assert.equal(FILTERS.maxPriceUsd, 900);
  } finally {
    Object.assign(FILTERS, structuredClone(DEFAULT_FILTERS));
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
