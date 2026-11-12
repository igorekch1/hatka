import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { useSampleFilters } from './profile.ts';
import { Store } from '../src/db.ts';
import { Pipeline } from '../src/pipeline.ts';
import { mapLunCard } from '../src/sources/lun.ts';
import { mapOlxAd } from '../src/sources/olx.ts';
import type { Listing } from '../src/types.ts';

useSampleFilters();

// Реальные объявления, снятые с OLX и Lun 11.11.2026 (без ИИ-разбора)
const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/live/${f}`, import.meta.url), 'utf8'));
const recent = (l: Listing): Listing =>
  ({ ...l, publishedAt: l.publishedAt && l.publishedAt.getFullYear() < 2026 ? l.publishedAt : new Date() });

test('Живые данные 11.11.2026: отбор и склейка', async () => {
  const sent: string[] = [];
  const store = new Store(':memory:');
  const p = new Pipeline(store, { sendListing: async (id: string) => { sent.push(id); } } as any);
  const items = [...load('olx-2026-11-11.json').data.map(mapOlxAd), ...load('lun-2026-11-11.json').cards.map(mapLunCard)];
  for (const l of items.map(recent)) await p.enqueue(l);

  assert.deepEqual(sent.sort(), [
    'lun:4731405201', // Галицький, $500
    'lun:4731405481', // Шевченківський, ЖК Семицвіт, $750
    'lun:4731406371', // Франківський, ЖК Парус Park, $700
    'olx:939185557', //  Галицький, $750, «тварини до обговорення» сильнее галочки «ні»
    'olx:940557420', //  Франківський, 900 EUR
    'olx:940562014', //  Франківський, $413
  ].sort());
  assert.equal(store.getStatus('olx:940561065'), 'rejected'); // только маленькие собаки
  assert.equal(store.getStatus('lun:4731405649'), 'duplicate'); // та же квартира, что olx:940561065
  assert.equal(store.getStatus('olx:937774812'), 'rejected'); // продажа паркоместа
  assert.equal(store.getStatus('olx:753400338'), 'old'); // объявление 2022 года, поднятое в топ
});
