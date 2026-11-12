import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { useSampleFilters } from './profile.ts';
import { parseAiJson } from '../src/ai.ts';
import { Store } from '../src/db.ts';
import { hardFilter, keywordFeatures, mergeAi, score } from '../src/filter.ts';
import { toUsd } from '../src/fx.ts';
import { Pipeline } from '../src/pipeline.ts';
import { renderListing } from '../src/render.ts';
import { mapDomRia } from '../src/sources/domria.ts';
import { mapLunCard } from '../src/sources/lun.ts';
import { mapOlxAd, olxPets } from '../src/sources/olx.ts';
import { mapTelegramPost, parsePriceFromText } from '../src/sources/telegram.ts';
import type { Listing } from '../src/types.ts';
import { canonicalUrlKey, extractPhones, normalizeDistrict } from '../src/util.ts';

useSampleFilters();

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const fresh = (l: Listing): Listing => ({ ...l, publishedAt: new Date() });

test('OLX: парсинг объявления', () => {
  const l = mapOlxAd(fx('olx.json').data[0]);
  assert.equal(l.id, 'olx:940560785');
  assert.equal(l.price, 28000);
  assert.equal(l.currency, 'UAH');
  assert.equal(l.rooms, 2);
  assert.equal(l.area, 45);
  assert.equal(l.district, 'Сихівський');
  assert.equal(l.pets, 'dogs_ok');
  assert.equal(l.features.dishwasher, true);
  assert.equal(l.features.airConditioner, true);
  assert.equal(l.features.gasStove, true);
  assert.equal(l.isOwner, true);
  assert.match(l.photos[0], /image;s=750x1000$/);
  assert.ok(l.dedupKeys.includes('olx-url:11EuPf'));
  assert.ok(!l.text.includes('<br'));
});

test('OLX: животные', () => {
  assert.equal(olxPets(['no']), 'no');
  assert.equal(olxPets(['yes_small_dog']), 'small_dogs_only');
  assert.equal(olxPets(['yes_cat']), 'no_dogs');
  assert.equal(olxPets(['yes_cat', 'yes_big_dog']), 'dogs_ok');
  assert.equal(olxPets(undefined), 'unknown');
});

test('Lun: парсинг карточек', () => {
  const [olxViaLun, lychakiv, america] = fx('lun.json').cards.map(mapLunCard);
  assert.equal(olxViaLun.district, 'Залізничний');
  assert.equal(olxViaLun.pets, 'no');
  assert.ok(olxViaLun.dedupKeys.includes('olx-url:11EtB0'), 'склейка с OLX по ссылке');
  assert.equal(lychakiv.phones[0], '+380981505588');
  assert.equal(lychakiv.features.undergroundParking, true);
  assert.equal(lychakiv.features.gasStove, true);
  assert.equal(lychakiv.complex, 'ЖК Щасливий');
  assert.equal(america.district, 'Франківський');
  assert.equal(america.currency, 'USD');
  assert.equal(america.publishedAt?.toISOString(), '2026-11-11T10:50:00.000Z');
  assert.match(america.photos[0], /lunstatic\.net\/lun-ua\/1200\/900\/images\/offers\/1881557251999999\.jpg$/);
});

test('DIM.RIA: парсинг деталей', () => {
  const l = mapDomRia(fx('domria.json'));
  assert.equal(l.id, 'domria:35136652');
  assert.equal(l.priceUsd, 488);
  assert.equal(l.currency, 'UAH');
  assert.equal(l.district, 'Залізничний', 'микрорайон Привокзальна → Залізничний');
  assert.equal(l.address, 'вул. Залізнична, 9А');
  assert.match(l.photos[0], /348300002fl\.jpg$/);
  assert.equal(l.url, 'https://dom.ria.com/uk/realty-dolgosrochnaya-arenda-kvartira-lvov-privokzalnaya-jeleznodorojnaya-ulitsa-35136652.html');
  assert.equal(canonicalUrlKey(l.url), 'domria:35136652');
});

test('Telegram: цена, телефоны, животные из текста', () => {
  assert.deepEqual(parsePriceFromText('Ціна 18 000 грн + комуналка'), { price: 18000, currency: 'UAH' });
  assert.deepEqual(parsePriceFromText('💵 $750/міс'), { price: 750, currency: 'USD' });
  assert.deepEqual(parsePriceFromText('800 у.о.'), { price: 800, currency: 'USD' });
  assert.deepEqual(parsePriceFromText('дзвонити після 18\n700 $/міс'), { price: 700, currency: 'USD' });
  assert.deepEqual(extractPhones('тел. 067 123 45 67 або +38(093)765-43-21'), ['+380671234567', '+380937654321']);
  const p = mapTelegramPost({
    channel: 'orenda_lviv', messageId: 42, date: new Date(), link: 'https://t.me/orenda_lviv/42',
    text: 'Здається 2к квартира, Франківський р-н, ЖК Америка. 900$. Без тварин. 0671234567',
  });
  assert.equal(p.district, 'Франківський');
  assert.equal(p.pets, 'no');
  assert.equal(p.price, 900);
  assert.equal(p.previewUrl, 'https://t.me/orenda_lviv/42');
});

test('Районы нормализуются', () => {
  assert.equal(normalizeDistrict('Франковский р-н'), 'Франківський');
  assert.equal(normalizeDistrict('Шевченківський район'), 'Шевченківський');
  assert.equal(normalizeDistrict('Галицкий'), 'Галицький');
  assert.equal(normalizeDistrict('Лычаковский'), 'Личаківський');
  assert.equal(normalizeDistrict('Іншій'), undefined);
});

test('Жёсткий фильтр', () => {
  const base = mapLunCard(fx('lun.json').cards[2]);
  const usd = (l: Listing) => ({ ...l, priceUsd: toUsd(l.price, l.currency) });
  assert.deepEqual(hardFilter(usd(base)), { ok: true });
  assert.equal(hardFilter(usd({ ...base, price: 1200 })).ok, false);
  assert.equal(hardFilter(usd({ ...base, district: 'Сихівський' })).ok, false);
  assert.equal(hardFilter(usd({ ...base, district: undefined })).ok, true, 'неизвестный район пропускаем');
  assert.equal(hardFilter(usd({ ...base, pets: 'small_dogs_only' })).ok, false);
  assert.equal(hardFilter(usd({ ...base, text: 'Квартира подобово' })).ok, false);
  assert.equal(hardFilter(usd({ ...base, text: 'Здається лише для однієї особи' })).ok, false);
  assert.equal(hardFilter(usd({ ...base, text: 'Власники будуть раді орендарям без тварин' })).ok, false);
  const seeker = { ...base, source: 'telegram' as const, text: 'Шукаю 2к квартиру у Франківському районі до 900$' };
  assert.equal(hardFilter(usd(seeker)).ok, false);
});

test('Оценка: ЖК Америка с паркингом и посудомойкой выше обычной', () => {
  const cards = fx('lun.json').cards.map(mapLunCard).map(keywordFeatures);
  const america = cards[2];
  const plain = keywordFeatures({ ...cards[0], features: {} });
  assert.ok(score(america) >= 7, `ожидали ≥7, получили ${score(america)}`);
  assert.ok(score(plain) < score(america));
  assert.ok(score(america) <= 10);
});

test('ИИ: разбор ответа и слияние', () => {
  const ai = parseAiJson(`Вот JSON: {"is_rental_offer": true, "price": 35000, "currency": "UAH", "district": "Шевченківський",
    "complex": null, "rooms": 2, "area": 58, "phones": ["+380501112233"], "pets": "dogs_ok", "only_one_person": false,
    "features": {"dishwasher": true, "gasStove": false, "shower": null}, "red_flags": ["оплата за 2 міс наперед"],
    "summary": "Светлая двушка у Оперного"}`);
  assert.equal(ai.pets, 'dogs_ok');
  assert.equal(ai.features.shower, undefined);
  const tg = mapTelegramPost({ channel: 'c', messageId: 1, date: new Date(), link: 'https://t.me/c/1/1', text: 'Квартира біля Оперного, дзвоніть' });
  const merged = mergeAi(tg, ai, toUsd);
  assert.equal(merged.district, 'Шевченківський');
  assert.equal(merged.phones[0], '+380501112233');
  assert.equal(merged.features.gasStove, false);
  assert.ok(merged.priceUsd! > 600 && merged.priceUsd! < 900);
});

test('Сообщение в Telegram собирается и экранируется', () => {
  const l = keywordFeatures({ ...mapLunCard(fx('lun.json').cards[2]), priceUsd: 850, title: '<script>' });
  const html = renderListing(l, score(l));
  assert.match(html, /⭐️ <b>2к · 62 м² · \$850<\/b>/);
  assert.match(html, /Франківський · ЖК Америка/);
  assert.match(html, /Собака: можна/);
  assert.match(html, /\+380671234567/);
  assert.ok(!html.includes('<script>'));
});

test('Конвейер: присылает подходящую, отсеивает лишнее, склеивает дубли', async () => {
  const sent: string[] = [];
  const fakeBot = { sendListing: async (id: string) => { sent.push(id); }, sendText: async () => {} };
  const store = new Store(':memory:');
  const p = new Pipeline(store, fakeBot as any);

  const [zaliznychnyi, lychakiv, america] = fx('lun.json').cards.map(mapLunCard).map(fresh);
  const olx = fresh(mapOlxAd(fx('olx.json').data[0]));

  await p.enqueue(america);
  await p.enqueue(zaliznychnyi);
  await p.enqueue(lychakiv);
  await p.enqueue(olx); // Сихівський
  await p.enqueue(america); // повторный опрос — не дублируем

  // То же объявление, пришедшее напрямую с другой площадки с тем же телефоном и площадью
  const copy: Listing = { ...america, id: 'domria:1', source: 'domria', externalId: '1', dedupKeys: ['domria:1'] };
  await p.enqueue(copy);

  // Старое объявление — не присылаем
  await p.enqueue({ ...america, id: 'lun:old', dedupKeys: ['lun:old'], phones: [], address: undefined, publishedAt: new Date(Date.now() - 6 * 3600_000) });

  assert.deepEqual(sent, ['lun:4731499999']);
  assert.equal(store.getStatus('lun:4731405563'), 'rejected');
  assert.equal(store.getStatus('domria:1'), 'duplicate');
  assert.equal(store.getStatus('lun:old'), 'old');
});
