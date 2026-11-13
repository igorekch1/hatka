import { aiEnabled, callClaude, extractJson } from './ai.ts';
import { ALL_DISTRICTS, CONFIG, EMPTY_FILTERS, FEATURE_LABELS, FILTERS, FILTERS_STATE, NO_PRICE_LIMIT, type Filters } from './config.ts';
import type { Store } from './db.ts';
import { toUah, toUsd, uahPerUsdRate } from './fx.ts';
import type { FeatureKey } from './types.ts';
import { escapeHtml as e, log, normalizeDistrict } from './util.ts';

/* ──────────────────────────────────────────────────────────────────────────
 * Фильтры, которые меняют из бота (/filters). Хранятся в kv под ключом «filters».
 * ────────────────────────────────────────────────────────────────────────── */

const FEATURE_KEYS = Object.keys(FEATURE_LABELS) as FeatureKey[];

const clone = (f: Filters): Filters => structuredClone(f);

const numOr = (v: unknown, d: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;

const posOrNull = (v: unknown, d: number | null) =>
  v === null ? null : typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d;

/** Приводит что угодно (ответ ИИ, JSON из базы) к корректным фильтрам; чего нет — берёт из base */
export function sanitizeFilters(raw: any, base: Filters = EMPTY_FILTERS): Filters {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = clone(base);
  out.maxPriceUsd = r.maxPriceUsd === null ? NO_PRICE_LIMIT : numOr(r.maxPriceUsd, base.maxPriceUsd, 50, NO_PRICE_LIMIT);
  out.minPriceUsd = numOr(r.minPriceUsd, base.minPriceUsd, 0, out.maxPriceUsd);
  if (Array.isArray(r.districts)) {
    const d = [...new Set(r.districts.map((x: unknown) => normalizeDistrict(String(x))).filter(Boolean))] as string[];
    // Ни одного известного района (опечатка, «Марс») — оставляем прежние, а не «все»
    out.districts = d.length ? d : base.districts;
  }
  if (typeof r.allowUnknownDistrict === 'boolean') out.allowUnknownDistrict = r.allowUnknownDistrict;
  if ('minRooms' in r) out.minRooms = posOrNull(r.minRooms, base.minRooms);
  if ('maxRooms' in r) out.maxRooms = posOrNull(r.maxRooms, base.maxRooms);
  if (out.minRooms && out.maxRooms && out.minRooms > out.maxRooms) [out.minRooms, out.maxRooms] = [out.maxRooms, out.minRooms];
  if ('minArea' in r) out.minArea = posOrNull(r.minArea, base.minArea);
  for (const k of ['dogFriendly', 'rejectSmallDogsOnly', 'rejectOnlyOnePerson'] as const)
    if (typeof r[k] === 'boolean') out[k] = r[k];
  if (Array.isArray(r.dreamComplexes))
    out.dreamComplexes = [...new Set(
      r.dreamComplexes
        .filter((x: unknown) => typeof x === 'string')
        .map((x: string) => x.toLowerCase().replace(/^\s*жк\s*/, '').replace(/[«»"']/g, '').trim())
        .filter(Boolean),
    )] as string[];
  if (r.wishes && typeof r.wishes === 'object') {
    const w: Filters['wishes'] = {};
    for (const k of FEATURE_KEYS) {
      if (k === 'allWhiteInterior') continue;
      const v = r.wishes[k];
      if (typeof v === 'number' && v > 0) w[k] = Math.min(3, Math.round(v * 2) / 2);
    }
    out.wishes = w;
  }
  out.minScore = numOr(r.minScore, base.minScore, 0, 10);
  if (typeof r.extra === 'string') out.extra = r.extra.trim().slice(0, 500);
  return out;
}

/** Меняет фильтры на месте (их читают фильтр, оценка и промпт ИИ) и сохраняет в базу */
export function applyFilters(store: Store, f: Filters) {
  Object.assign(FILTERS, clone(f));
  FILTERS_STATE.configured = true;
  store.setKv('filters', JSON.stringify(FILTERS));
}

/** Стирает фильтры: бот перестаёт присылать объявления, пока их снова не зададут */
export function clearFilters(store: Store) {
  Object.assign(FILTERS, clone(EMPTY_FILTERS));
  FILTERS_STATE.configured = false;
  store.delKv('filters');
}

/** Снимок для «↩️ Скасувати»: JSON фильтров или "null", если их не было */
export const filtersSnapshot = () => (FILTERS_STATE.configured ? JSON.stringify(FILTERS) : 'null');

export function restoreSnapshot(store: Store, snap: string) {
  const v = JSON.parse(snap);
  if (v === null) clearFilters(store);
  else applyFilters(store, sanitizeFilters(v, EMPTY_FILTERS));
}

export function loadFilters(store: Store) {
  const raw = store.getKv('filters');
  if (!raw) return;
  try {
    Object.assign(FILTERS, sanitizeFilters(JSON.parse(raw), EMPTY_FILTERS));
    FILTERS_STATE.configured = true;
  } catch (err) {
    log('Не удалось прочитать сохранённые фильтры — считаю, что их нет', String(err));
  }
}

const yesNo = (b: boolean) => (b ? 'так' : 'ні');
const range = (a: number | null, b: number | null, unit = '') =>
  a && b ? (a === b ? `${a}${unit}` : `${a}–${b}${unit}`) : a ? `від ${a}${unit}` : b ? `до ${b}${unit}` : 'будь-яка';

/** Человеческое описание фильтров (HTML) */
export function describeFilters(f: Filters = FILTERS, configured = FILTERS_STATE.configured): string {
  if (!configured)
    return '⚙️ <b>Фільтри ще не задані</b> — тому я поки нічого не надсилаю.';
  const wishes = (Object.entries(f.wishes) as Array<[FeatureKey, number]>)
    .sort((a, b) => b[1] - a[1])
    .map(([k, w]) => `${FEATURE_LABELS[k]}${w >= 2 ? ' ‼️' : ''}`);
  const lines = [
    '⚙️ <b>Фільтри пошуку</b>',
    f.maxPriceUsd >= NO_PRICE_LIMIT
      ? `💵 Ціна: від $${f.minPriceUsd}, без верхньої межі`
      : `💵 Ціна: $${f.minPriceUsd}–${f.maxPriceUsd} (≈ ${toUah(f.maxPriceUsd).toLocaleString('uk-UA')} грн макс.)`,
    `📍 Райони: ${e(f.districts.length === ALL_DISTRICTS.length ? 'всі' : f.districts.join(', '))}` +
      (f.allowUnknownDistrict ? ' · без вказаного району теж надсилати' : ''),
    `🚪 Кімнат: ${range(f.minRooms, f.maxRooms)} · 📐 Площа: ${f.minArea ? `від ${f.minArea} м²` : 'будь-яка'}`,
    f.dogFriendly
      ? `🐕 З собакою середнього розміру: так${f.rejectSmallDogsOnly ? ' (відсікати «лише маленькі»)' : ''}`
      : '🐕 Тварини: не важливо',
    `👫 Відсікати «лише для однієї особи»: ${yesNo(f.rejectOnlyOnePerson)}`,
    `⭐ ЖК мрії: ${f.dreamComplexes.length ? e(f.dreamComplexes.map((c) => c[0].toUpperCase() + c.slice(1)).join(', ')) : '—'}`,
    `✨ Бажано: ${wishes.length ? e(wishes.join(', ')) : '—'}`,
    `🎯 Мін. оцінка: ${f.minScore}/10`,
  ];
  if (f.extra) lines.push(`📝 Додатково (перевіряє ШІ): <i>${e(f.extra)}</i>`);
  return lines.join('\n');
}

/* ─── Разбор текста ────────────────────────────────────────────────────── */

export type FilterUpdate = { filters: Filters; changes: string[]; via: 'ai' | 'basic' };

function filtersPrompt(): string {
  return `Ти допомагаєш налаштувати фільтри пошуку квартир в оренду ${CONFIG.city.nameIn}. Користувач пише українською або російською,
списком або вільним текстом. Твоє завдання — оновити поточні фільтри відповідно до його повідомлення.

Правила:
- Якщо користувач змінює лише щось одне («підніми бюджет до 1100») — решту залиш як є.
- Чого користувач не згадав — лиши як у поточних. «Без обмеження ціни» = maxPriceUsd ${NO_PRICE_LIMIT}.
- Якщо надіслав повний перелік вимог — побудуй фільтри заново з нього (чого не згадав — бери з поточних).
- Ціни переводь у долари США. Курс: 1 USD = ${uahPerUsdRate().toFixed(2)} грн, 1 EUR ≈ 1.08 USD.
- districts — лише з: ${ALL_DISTRICTS.join(', ')}.${CONFIG.city.centerDistrict ? ` «Центр» = ${CONFIG.city.centerDistrict}.` : ''} «Будь-який район» = всі.
- wishes — «хотілки» з вагою 0.5..3 (3 — дуже важливо, 1 — звичайно, 0.5 — бажано). Ключі: ${FEATURE_KEYS.filter((k) => k !== 'allWhiteInterior').map((k) => `${k} (${FEATURE_LABELS[k]})`).join(', ')}.
- Якщо щось не вкладається в поля (поверх, «не перший поверх», «новобудова», «балкон», «без комісії», «з меблями» тощо) — допиши це коротко в extra
  (ШІ перевірятиме кожне оголошення на відповідність extra). Якщо користувач просить прибрати такі вимоги — прибери з extra.
- minRooms/maxRooms/minArea: null — без обмежень. «2к» = minRooms 2, maxRooms 2. «від 2 кімнат» = minRooms 2, maxRooms null.

Поверни ТІЛЬКИ JSON без markdown:
{
  "filters": {
    "maxPriceUsd": number, "minPriceUsd": number,
    "districts": string[], "allowUnknownDistrict": boolean,
    "minRooms": number | null, "maxRooms": number | null, "minArea": number | null,
    "dogFriendly": boolean,          // шукаємо житло, де можна собаку середнього розміру
    "rejectSmallDogsOnly": boolean,  // відсікати «лише маленькі собаки»
    "rejectOnlyOnePerson": boolean,  // відсікати «лише для однієї особи»
    "dreamComplexes": string[],      // назви ЖК мрії, у нижньому регістрі, без «ЖК»
    "wishes": { "<ключ>": number },
    "minScore": number,              // 0..10
    "extra": string
  },
  "changes": string[]                // що саме змінилось, коротко українською, по пункту на зміну
}`;
}

async function parseWithAi(text: string, base: Filters): Promise<FilterUpdate> {
  const raw = await callClaude(
    filtersPrompt(),
    `Поточні фільтри:\n${JSON.stringify(base, null, 2)}\n\nПовідомлення користувача:\n${text.slice(0, 3000)}`,
    1200,
  );
  const j = extractJson(raw);
  const filters = sanitizeFilters(j.filters ?? j, base);
  const changes = Array.isArray(j.changes) ? j.changes.filter((c: unknown) => typeof c === 'string').slice(0, 15) : [];
  return { filters, changes, via: 'ai' };
}


/** Без ИИ: цена, районы, комнаты, площадь, оценка, собака, «хотелки» с весами, ЖК мечты и флаги отсева */
export function parseFiltersBasic(text: string, base: Filters): FilterUpdate {
  const f = clone(base);
  const changes: string[] = [];
  const t = text.toLowerCase().replace(/ /g, ' ');

  const price = t.match(/(?:до|max|макс\S*|бюджет\S*|не\s+дорожче|не\s+дороже)\s*[:\-]?\s*(\$|€)?\s*(\d[\d\s]{1,6})\s*(\$|usd|дол\S*|у\.?\s?о\.?|грн|uah|₴|€|eur|євро|евро|k|к)?/i);
  if (price) {
    let n = Number(price[2].replace(/\s/g, ''));
    const cur = (price[1] ?? price[3] ?? '').toLowerCase();
    if (/^(k|к)$/.test(cur)) n *= 1000;
    const usd = /грн|uah|₴/.test(cur) || n >= 5000 ? toUsd(n, 'UAH') : /€|eur|євро|евро/.test(cur) ? toUsd(n, 'EUR') : n;
    if (usd) {
      f.maxPriceUsd = usd;
      changes.push(`ціна до $${usd}`);
    }
  }

  // Районы города в порядке упоминания; «центр» — центральный район из профиля
  const ds = CONFIG.city.districts
    .map((d) => ({ name: d.name, at: t.search(new RegExp(d.match.source, 'i')) }))
    .filter((d) => d.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((d) => d.name);
  if (CONFIG.city.centerDistrict && /(?<![а-яіїєґ])центр/.test(t) && !ds.includes(CONFIG.city.centerDistrict)) ds.push(CONFIG.city.centerDistrict);
  if (/будь-?\s?як\S*\s+район|всі\s+район|все\s+район|любой\s+район/.test(t)) {
    f.districts = [...ALL_DISTRICTS];
    changes.push('райони: всі');
  } else if (ds.length) {
    f.districts = [...new Set(ds)];
    changes.push(`райони: ${f.districts.join(', ')}`);
  }

  const roomsRange = t.match(/(\d)\s*[-–]\s*(\d)\s*(?:-?\s*к(?![а-яіїєґa-z])|-?\s*кімн|-?\s*комн|-?\s*х)/);
  const roomsFrom = t.match(/від\s*(\d)\s*(?:-?\s*х\s*)?(?:кімн|к(?![а-яіїєґa-z]))|от\s*(\d)\s*(?:-?\s*х\s*)?(?:комн|к(?![а-яіїєґa-z]))/);
  const roomsOne = t.match(/(?<![\d-])(\d)\s*-?\s*(?:к(?![а-яіїєґa-z])|кімн|комн|х\s*кімн|х\s*комн)/);
  if (roomsRange) {
    f.minRooms = Number(roomsRange[1]);
    f.maxRooms = Number(roomsRange[2]);
    changes.push(`кімнат: ${f.minRooms}–${f.maxRooms}`);
  } else if (roomsFrom) {
    f.minRooms = Number(roomsFrom[1] ?? roomsFrom[2]);
    f.maxRooms = null;
    changes.push(`кімнат: від ${f.minRooms}`);
  } else if (roomsOne) {
    f.minRooms = f.maxRooms = Number(roomsOne[1]);
    changes.push(`кімнат: ${f.minRooms}`);
  }

  const area = t.match(/(?:від|от|min|мін\S*|не\s+менше|не\s+меньше)\s*(\d{2,3})\s*(?:м|кв)/);
  if (area) {
    f.minArea = Number(area[1]);
    changes.push(`площа від ${f.minArea} м²`);
  }

  const sc = t.match(/оцінк\S*\s*(?:від|не\s+нижче)?\s*(\d+(?:[.,]\d)?)|оценк\S*\s*(?:от|не\s+ниже)?\s*(\d+(?:[.,]\d)?)/);
  if (sc) {
    f.minScore = Math.min(10, Number((sc[1] ?? sc[2]).replace(',', '.')));
    changes.push(`мін. оцінка ${f.minScore}`);
  }

  if (/без\s+(собак|тварин|животн)|тварин\S*\s+не\s+(треба|потрібн)/.test(t)) {
    f.dogFriendly = false;
    changes.push('тварини: не важливо');
  } else if (/собак|тварин|животн/.test(t) && !base.dogFriendly) {
    f.dogFriendly = true;
    changes.push('з собакою');
  }

  const minPrice = t.match(/мін\S*\.?\s*ціна\s*[:\-]?\s*\$?\s*(\d{2,5})|мин\S*\.?\s*цена\s*[:\-]?\s*\$?\s*(\d{2,5})|(?:ціна|цена)\s+від\s*\$?\s*(\d{2,5})/);
  if (minPrice) {
    f.minPriceUsd = Number(minPrice[1] ?? minPrice[2] ?? minPrice[3]);
    changes.push(`мін. ціна $${f.minPriceUsd}`);
  }

  if (/(лише|тільки|только)\s+маленьк/.test(t)) {
    f.rejectSmallDogsOnly = true;
    changes.push('відсікати «лише маленькі собаки»');
  }
  if (/(однієї|одної|одной|одного)\s+(особи|людини|человека|особы)/.test(t)) {
    f.rejectOnlyOnePerson = true;
    changes.push('відсікати «лише для однієї особи»');
  }
  if (/район\S*\s+не\s+(вказан|указан)\S*[^,.;\n]{0,10}(теж|також|тоже|все\s+одно)\s+(надсил|присыл)/.test(t)) {
    f.allowUnknownDistrict = true;
    changes.push('без вказаного району теж надсилати');
  } else if (/район\S*\s+не\s+(вказан|указан)\S*[^,.;\n]{0,10}не\s+(надсил|присыл)/.test(t)) {
    f.allowUnknownDistrict = false;
    changes.push('без вказаного району не надсилати');
  }

  const dream = t.match(/жк\s+(?:мрії|мечты)\s*[:\-—]?\s*([^,;\n]+)/);
  if (dream) {
    f.dreamComplexes = dream[1].split(/\s+(?:і|та|або|и|или)\s+|\//).map((x) => x.replace(/[«»"']/g, '').trim()).filter(Boolean);
    changes.push(`ЖК мрії: ${f.dreamComplexes.join(', ')}`);
  }

  // «Хотелки»: в каждой части текста (через запятую/строку) ищем удобства и вес рядом с ними
  const found = parseWishes(t);
  if (Object.keys(found).length) {
    f.wishes = { ...f.wishes, ...found };
    changes.push(`бажано: ${Object.entries(found).map(([k, w]) => `${FEATURE_LABELS[k as FeatureKey]} ${w}`).join(', ')}`);
  }

  return { filters: sanitizeFilters(f, base), changes, via: 'basic' };
}

const WISH_PATTERNS: Array<[FeatureKey, RegExp]> = [
  ['undergroundParking', /підземн\S*\s+паркін|подземн\S*\s+паркин/],
  ['parking', /паркінг|паркинг|парковк|паркомісц|машиномісц/],
  ['dishwasher', /посудомий|посудомо/],
  ['acInBedroom', /кондиц\S*\s+(у|в)\s+спальн/],
  ['airConditioner', /кондиц/],
  ['gasStove', /газов\S*\s+(плит|варильн)|газ(?![а-яіїєґ])/],
  ['shower', /душов|(?<![а-яіїєґ])душ(?![а-яіїєґ])/],
  ['twoDesks', /(2|два|дві|двох)\s+(робоч|рабоч)|під\s+(2|два)\s+стол|под\s+(2|два)\s+стол|кабінет|кабинет/],
  ['bright', /світл|светл|сонячн|солнечн/],
];

/** «підземний паркінг 2, посудомийка (1.5), обов'язково душ» → { undergroundParking: 2, dishwasher: 1.5, shower: 2 } */
export function parseWishes(t: string): Partial<Record<FeatureKey, number>> {
  const out: Partial<Record<FeatureKey, number>> = {};
  for (const part of t.split(/[,;\n]/)) {
    if (/(?<![а-яіїєґ])без\s/.test(part)) continue;
    const keys: FeatureKey[] = [];
    for (const [k, re] of WISH_PATTERNS) {
      if (!re.test(part)) continue;
      // Подземный паркинг уже включает «паркинг», кондиционер в спальне — «кондиционер»
      if (k === 'parking' && keys.includes('undergroundParking')) continue;
      if (k === 'airConditioner' && keys.includes('acInBedroom')) continue;
      keys.push(k);
    }
    if (!keys.length) continue;
    const num = part.match(/(?:вага|вес)?\s*[(:—-]?\s*(\d(?:[.,]\d)?)\s*\)?\s*$/)?.[1];
    const weight = num
      ? Number(num.replace(',', '.'))
      : /обов.?язков|обязательн|дуже\s+важлив|очень\s+важн|must/.test(part)
        ? 2
        : /бажано|желательно|було\s+б\s+добре/.test(part)
          ? 0.5
          : 1;
    for (const k of keys) out[k] = weight;
  }
  return out;
}

export async function parseFilters(text: string, base: Filters = FILTERS): Promise<FilterUpdate> {
  if (aiEnabled()) {
    try {
      return await parseWithAi(text, clone(base));
    } catch (err) {
      log('ИИ не смог разобрать фильтры, пробую простой разбор', String(err));
    }
  }
  return parseFiltersBasic(text, clone(base));
}

export const sameFilters = (a: Filters, b: Filters) => JSON.stringify(a) === JSON.stringify(b);
