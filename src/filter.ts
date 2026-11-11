import { DREAM_COMPLEX_BONUS, FILTERS, NOT_ALL_WHITE_WEIGHT } from './config.ts';
import { textPets } from './sources/telegram.ts';
import type { AiVerdict, FeatureKey, Listing } from './types.ts';
import { isAllowedDistrict, normalizeDistrict } from './util.ts';

export type Verdict = { ok: true } | { ok: false; reason: string };

const ONE_PERSON = 'лише для однієї особи';

const REJECT_TEXT: Array<[RegExp, string]> = [
  [/подобов|посуточ|погодинн|почасов/i, 'подобова оренда'],
  [/(^|\s)(продається|продается|продам|продаж)(?=[\s,.!:]|$)/i, 'продаж, а не оренда'],
  [/підселен|подселен|ліжко-?місц|койко-?мест|кімнату\s+в\s+квартир|комнату\s+в\s+квартир/i, 'підселення/кімната'],
  [/(для|на)\s+(однієї|одной|одного|1)\s+(особи|людини|человека|дівчини|девушки|чол)/i, ONE_PERSON],
];

const PETS_NEGOTIABLE = /(тварин\S*|животн\S*)\s+(до\s+обговор|обговорю|за\s+домовл|по\s+договор|обсужда)/i;

const SEEKER = /^\s*(шукаю|шукаємо|ищу|ищем|потрібна|потрібно|нужна)(?=[\s,.!:]|$)/i;

/** «Тварини до обговорення» сильнее галочки «без тварин» на сайте */
export function adjustPets(l: Listing): Listing {
  if (['no', 'no_dogs', 'small_dogs_only'].includes(l.pets) && PETS_NEGOTIABLE.test(l.text)) return { ...l, pets: 'some' };
  return l;
}

/**
 * Жёсткий фильтр — дешёвый, до ИИ. Отсекает то, что точно не подходит,
 * и пропускает всё сомнительное (неизвестный район/животные) дальше.
 */
export function hardFilter(l: Listing): Verdict {
  const f = FILTERS;
  if (l.priceUsd !== undefined && l.priceUsd > f.maxPriceUsd) return { ok: false, reason: `дорожче $${f.maxPriceUsd}` };
  if (l.priceUsd !== undefined && l.priceUsd < f.minPriceUsd)
    return { ok: false, reason: `дешевше $${f.minPriceUsd}` };

  const allowed = isAllowedDistrict(l.district);
  if (allowed === false) return { ok: false, reason: `район: ${l.district}` };

  if (l.rooms !== undefined && f.minRooms && l.rooms < f.minRooms) return { ok: false, reason: `кімнат менше ${f.minRooms}` };
  if (l.rooms !== undefined && f.maxRooms && l.rooms > f.maxRooms) return { ok: false, reason: `кімнат більше ${f.maxRooms}` };
  if (l.area !== undefined && f.minArea && l.area < f.minArea) return { ok: false, reason: `площа менше ${f.minArea} м²` };

  // Галочка на сайте «без тварин», но в тексте «тварини до обговорення» — не отсекаем, пусть решает звонок
  const negotiable = PETS_NEGOTIABLE.test(l.text);
  if (f.dogFriendly && !negotiable) {
    if (l.pets === 'no') return { ok: false, reason: 'без тварин' };
    if (l.pets === 'no_dogs') return { ok: false, reason: 'собак не можна' };
    if (l.pets === 'small_dogs_only' && f.rejectSmallDogsOnly) return { ok: false, reason: 'лише маленькі собаки' };
    if (textPets(l.text) === 'no') return { ok: false, reason: 'без тварин (у тексті)' };
  }

  for (const [re, reason] of REJECT_TEXT) {
    if (reason === ONE_PERSON && !f.rejectOnlyOnePerson) continue;
    if (re.test(l.text)) return { ok: false, reason };
  }
  if (l.source === 'telegram' && SEEKER.test(l.text)) return { ok: false, reason: 'пост-запит, а не пропозиція' };
  return { ok: true };
}

const KEYWORDS: Array<[FeatureKey, RegExp]> = [
  // «кондиц» покрывает и укр. «кондиціонер», и рус. «кондиционер»
  ['dishwasher', /посудоми|посудомо/i],
  ['airConditioner', /кондиц/i],
  ['acInBedroom', /кондиц\S*\s+(у|в)\s+спальн|спальн\S*[^.]{0,40}кондиц/i],
  ['gasStove', /газов\S*\s+(плит|варильн|поверхн)/i],
  ['shower', /душов|душ-?кабін|душ-?кабин|тропічн\S*\s+душ|тропическ\S*\s+душ|(?<![а-яіїєґ])душ(?![а-яіїєґ])/i],
  ['undergroundParking', /підземн\S*\s+паркінг|подземн\S*\s+паркинг/i],
  ['parking', /паркінг|паркинг|парковк|паркомісц|машиномісц|машиномест/i],
  ['bright', /світл|светл|сонячн|солнечн/i],
];

/** Дешёвое распознавание «хотелок» по ключевым словам — работает и без ИИ */
export function keywordFeatures(l: Listing): Listing {
  const features = { ...l.features };
  for (const [k, re] of KEYWORDS) if (features[k] === undefined && re.test(l.text)) features[k] = true;
  return { ...l, features };
}

/** Дополняет объявление тем, что понял ИИ (не перетирая точные данные с сайта) */
export function mergeAi(l: Listing, ai: AiVerdict, toUsd: (p?: number, c?: any) => number | undefined): Listing {
  const out: Listing = { ...l, features: { ...l.features } };
  if (out.price === undefined && ai.price) {
    out.price = ai.price;
    out.currency = ai.currency ?? undefined;
  }
  if (out.priceUsd === undefined) out.priceUsd = toUsd(out.price, out.currency);
  if (!out.district) out.district = normalizeDistrict(ai.district);
  if (!out.complex && ai.complex) out.complex = ai.complex;
  if (out.rooms === undefined && ai.rooms) out.rooms = ai.rooms;
  if (out.area === undefined && ai.area) out.area = ai.area;
  if (out.phones.length === 0 && ai.phones.length) out.phones = ai.phones;
  // По животным — структурированное поле сайта точнее, кроме «unknown/some»
  if (out.pets === 'unknown' || out.pets === 'some') out.pets = ai.pets;
  for (const [k, v] of Object.entries(ai.features) as Array<[FeatureKey, boolean | null]>) {
    if (typeof v === 'boolean' && out.features[k] === undefined) out.features[k] = v;
  }
  return out;
}

export function aiFilter(ai: AiVerdict): Verdict {
  if (!ai.isRentalOffer) return { ok: false, reason: 'ШІ: не пропозиція довгострокової оренди' };
  if (ai.onlyOnePerson && FILTERS.rejectOnlyOnePerson) return { ok: false, reason: 'ШІ: лише для однієї особи' };
  if (FILTERS.extra && ai.extraOk === false)
    return { ok: false, reason: `ШІ: ${ai.extraReason || 'не відповідає додатковим вимогам'}` };
  return { ok: true };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function isDreamComplex(l: Listing): boolean {
  const hay = `${l.complex ?? ''} ${l.title ?? ''} ${l.text}`.toLowerCase();
  return FILTERS.dreamComplexes.some(
    (c) => new RegExp(`жк\\s*«?"?${escapeRe(c)}`, 'i').test(hay) || (l.complex ?? '').toLowerCase().includes(c),
  );
}

/** Оценка 0..10 по «хотелкам». Неизвестное не штрафуется. */
export function score(l: Listing): number {
  const w = FILTERS.wishes;
  const dream = FILTERS.dreamComplexes.length ? DREAM_COMPLEX_BONUS : 0;
  const total = Object.values(w).reduce((a, b) => a + (b ?? 0), 0) + NOT_ALL_WHITE_WEIGHT + dream;
  if (total <= 0) return 0;
  let got = 0;
  for (const [k, v] of Object.entries(w) as Array<[FeatureKey, number]>) {
    if (l.features[k] === true) got += v;
  }
  // Подземный паркинг включает «просто парковку» — не считаем дважды; кондиционер где-то — половина балла
  if (l.features.acInBedroom !== true && l.features.airConditioner === true && !w.airConditioner) got += (w.acInBedroom ?? 0) / 2;
  if (l.features.undergroundParking !== true && l.features.parking === true && !w.parking) got += (w.undergroundParking ?? 0) / 4;
  if (l.features.allWhiteInterior === false) got += NOT_ALL_WHITE_WEIGHT;
  if (isDreamComplex(l)) got += dream;
  return Math.min(10, Math.round((got / total) * 100) / 10);
}
