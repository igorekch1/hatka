import assert from 'node:assert/strict';
import { test } from 'node:test';

// Каждый тестовый файл — отдельный процесс, поэтому город можно выбрать до импорта модулей
process.env.CITY = 'kyiv';
delete process.env.OLX_REGION_ID;
delete process.env.OLX_CITY_ID;

const { CITIES, resolveCity } = await import('../src/cities.ts');
const { ALL_DISTRICTS, CONFIG, EMPTY_FILTERS } = await import('../src/config.ts');
const { normalizeDistrict, districtFromMicro } = await import('../src/util.ts');
const { parseFiltersBasic } = await import('../src/filters.ts');
const { mapUrl } = await import('../src/render.ts');
const { lunSource } = await import('../src/sources/lun.ts');
const { domriaSource } = await import('../src/sources/domria.ts');
const { olxSource } = await import('../src/sources/olx.ts');

test('Місто: вибір через CITY і перевизначення OLX', () => {
  assert.equal(CONFIG.city.key, 'kyiv');
  assert.throws(() => resolveCity({ CITY: 'paris' }), /Невідоме місто/);
  assert.equal(resolveCity({}).key, 'lviv', 'за замовчуванням — Львів');
  assert.deepEqual(resolveCity({ CITY: 'odesa', OLX_REGION_ID: '15', OLX_CITY_ID: '42' }).olx, { regionId: 15, cityId: 42 });
  for (const c of Object.values(CITIES)) {
    assert.ok(c.districts.length >= 4, c.key);
    for (const d of c.districts) assert.equal(c.districts.filter((x) => x.match.test(d.name)).length, 1, `${c.key}: «${d.name}» має впізнаватись однозначно`);
  }
});

test('Київ: райони, фільтри, карта', () => {
  assert.equal(ALL_DISTRICTS.length, 10);
  assert.deepEqual(EMPTY_FILTERS.districts, ALL_DISTRICTS);
  assert.equal(normalizeDistrict('Печерский р-н'), 'Печерський');
  assert.equal(normalizeDistrict('Соломʼянський район'), 'Солом’янський');
  assert.equal(normalizeDistrict('Франківський'), undefined, 'львівський район у Києві не існує');
  assert.equal(districtFromMicro('Оболонський'), 'Оболонський');

  const f = parseFiltersBasic('до 800$, Печерський або центр', EMPTY_FILTERS).filters;
  assert.deepEqual(f.districts, ['Печерський', 'Шевченківський']);
  assert.match(mapUrl({ address: 'вул. Хрещатик, 1' } as any)!, new RegExp(encodeURIComponent('Київ')));
});

test('Київ: джерела ходять з номерами міста', async () => {
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ cards: [], items: [] }), { status: 200 });
  }) as any;
  try {
    await lunSource.poll(() => false);
    await domriaSource.poll(() => false);
    assert.match(urls[0], /geoId=10009580/);
    assert.match(urls[1], /state_id=10&city_id=10/);
    await assert.rejects(olxSource.poll(() => false), /OLX_REGION_ID/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
