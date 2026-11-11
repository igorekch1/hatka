import { aiEnabled, callClaude, extractJson } from './ai.ts';
import { ALL_DISTRICTS, DEFAULT_FILTERS, FEATURE_LABELS, FILTERS, type Filters } from './config.ts';
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
export function sanitizeFilters(raw: any, base: Filters = DEFAULT_FILTERS): Filters {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = clone(base);
  out.maxPriceUsd = numOr(r.maxPriceUsd, base.maxPriceUsd, 50, 100_000);
  out.minPriceUsd = numOr(r.minPriceUsd, base.minPriceUsd, 0, out.maxPriceUsd);
  if (Array.isArray(r.districts)) {
    const d = [...new Set(r.districts.map((x: unknown) => normalizeDistrict(String(x))).filter(Boolean))] as string[];
    out.districts = d.length ? d : [...ALL_DISTRICTS];
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
  store.setKv('filters', JSON.stringify(FILTERS));
}

export function loadFilters(store: Store) {
  const raw = store.getKv('filters');
  if (!raw) return;
  try {
    Object.assign(FILTERS, sanitizeFilters(JSON.parse(raw), DEFAULT_FILTERS));
  } catch (err) {
    log('Не удалось прочитать сохранённые фильтры, беру стандартные', String(err));
  }
}

const yesNo = (b: boolean) => (b ? 'так' : 'ні');
const range = (a: number | null, b: number | null, unit = '') =>
  a && b ? (a === b ? `${a}${unit}` : `${a}–${b}${unit}`) : a ? `від ${a}${unit}` : b ? `до ${b}${unit}` : 'будь-яка';

/** Человеческое описание фильтров (HTML) */
export function describeFilters(f: Filters = FILTERS): string {
  const wishes = (Object.entries(f.wishes) as Array<[FeatureKey, number]>)
    .sort((a, b) => b[1] - a[1])
    .map(([k, w]) => `${FEATURE_LABELS[k]}${w >= 2 ? ' ‼️' : ''}`);
  const lines = [
    '⚙️ <b>Фільтри пошуку</b>',
    `💵 Ціна: $${f.minPriceUsd}–${f.maxPriceUsd} (≈ ${toUah(f.maxPriceUsd).toLocaleString('uk-UA')} грн макс.)`,
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
  return `Ти допомагаєш налаштувати фільтри пошуку квартир в оренду у Львові. Користувач пише українською або російською,
списком або вільним текстом. Твоє завдання — оновити поточні фільтри відповідно до його повідомлення.

Правила:
- Якщо користувач змінює лише щось одне («підніми бюджет до 1100») — решту залиш як є.
- Якщо надіслав повний перелік вимог — побудуй фільтри заново з нього (чого не згадав — бери з поточних).
- Ціни переводь у долари США. Курс: 1 USD = ${uahPerUsdRate().toFixed(2)} грн, 1 EUR ≈ 1.08 USD.
- districts — лише з: ${ALL_DISTRICTS.join(', ')}. «Центр» = Галицький. «Будь-який район» = всі шість.
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

const DISTRICT_WORDS = /франк\S*|шевченк\S*|гал[иі]ц\S*|зал[іе]зни\S*|лича?к\S*|лычак\S*|сих[іоиo]в\S*|центр\S*/gi;

/** Без ИИ понимаем только простое: цена, районы, комнаты, площадь, оценка, собака */
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

  const ds = [...t.matchAll(DISTRICT_WORDS)].map((m) => (m[0].startsWith('центр') ? 'Галицький' : normalizeDistrict(m[0]))).filter(Boolean) as string[];
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

  return { filters: sanitizeFilters(f, base), changes, via: 'basic' };
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
