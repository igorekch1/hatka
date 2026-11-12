import { ALL_DISTRICTS, CONFIG, FILTERS, NO_PRICE_LIMIT } from './config.ts';
import type { AiVerdict, Currency, Features, Listing, PetsPolicy } from './types.ts';
import { log } from './util.ts';

/** Промпт собирается на каждый вызов — фильтры меняются из бота на лету */
function systemPrompt(): string {
  const f = FILTERS;
  const who = [
    `Ти аналізуєш оголошення про оренду квартир ${CONFIG.city.nameIn}.`,
    f.rejectOnlyOnePerson ? 'Житло шукають щонайменше двоє дорослих.' : '',
    f.dogFriendly ? 'У орендарів є собака середнього розміру (НЕ маленька), тож «лише маленькі собаки» не підходить.' : '',
  ].filter(Boolean).join(' ');
  const extra = f.extra.trim()
    ? `\nДодаткові вимоги орендарів (перевір їх у полі extra_ok): «${f.extra.trim()}»`
    : '';
  return `${who}
${f.maxPriceUsd < NO_PRICE_LIMIT ? `Бюджет до $${f.maxPriceUsd}. ` : ''}${f.districts.length < ALL_DISTRICTS.length ? `Потрібні райони: ${f.districts.join(', ')}.` : ''}${extra}

Поверни ТІЛЬКИ JSON без пояснень і без markdown, рівно з такими полями:
{
  "is_rental_offer": boolean,      // true лише якщо це ПРОПОЗИЦІЯ довгострокової оренди цілої квартири ${CONFIG.city.nameIn}.
                                   // false: пошук квартири («шукаю»), подобова оренда, продаж, кімната/підселення, реклама.
  "price": number | null,          // місячна оренда без комуналки
  "currency": "USD" | "UAH" | "EUR" | null,
  "district": ${ALL_DISTRICTS.map((d) => `"${d}"`).join(' | ')} | null,
                                   // адміністративний район міста ${CONFIG.city.name}; визнач за вулицею/мікрорайоном/ЖК, якщо прямо не вказано; null якщо не впевнений
  "complex": string | null,        // назва ЖК, якщо є («ЖК Америка»)
  "rooms": number | null,
  "area": number | null,
  "phones": string[],              // телефони з тексту у форматі +380XXXXXXXXX
  "pets": "dogs_ok" | "small_dogs_only" | "no_dogs" | "no" | "some" | "unknown",
                                   // dogs_ok — можна собак середнього розміру або будь-яких тварин без обмежень
                                   // small_dogs_only — лише маленькі собаки / до 10 кг; no_dogs — котика можна, собак ні
                                   // no — без тварин; some — «можна з деякими/обговорюється»; unknown — не сказано
  "only_one_person": boolean,      // true якщо здають тільки одній людині / тільки дівчині тощо
  "features": {                    // true — точно є, false — точно немає, null — не сказано
    "dishwasher": boolean | null,
    "airConditioner": boolean | null,
    "acInBedroom": boolean | null,
    "gasStove": boolean | null,    // газова плита (не електрична/індукційна)
    "shower": boolean | null,      // повноцінний душ/душова кабіна (не лише ванна)
    "undergroundParking": boolean | null,
    "parking": boolean | null,
    "bright": boolean | null,
    "twoDesks": boolean | null,    // є місце під два робочих столи / кабінет / окрема кімната для роботи
    "allWhiteInterior": boolean | null
  },
  "extra_ok": boolean | null,      // false — оголошення ТОЧНО порушує додаткові вимоги; true — відповідає; null — вимог немає або не зрозуміло з тексту
  "extra_reason": string,          // якщо extra_ok=false — дуже коротко чому, українською; інакше ""
  "red_flags": string[],           // коротко українською: «без дітей і тварин», «лише на 6 міс», «комісія 100%», «оплата за 3 міс наперед» тощо
  "summary": string                // одне коротке речення українською: головне про квартиру
}`;
}

const PETS: PetsPolicy[] = ['dogs_ok', 'small_dogs_only', 'no_dogs', 'no', 'some', 'unknown'];
const CURR: Currency[] = ['USD', 'UAH', 'EUR'];

/** Вытаскивает первый JSON-объект из ответа модели */
export function extractJson(raw: string): any {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('У відповіді ШІ немає JSON');
  return JSON.parse(raw.slice(start, end + 1));
}

export function parseAiJson(raw: string): AiVerdict {
  const j = extractJson(raw);
  const features: Features = {};
  for (const [k, v] of Object.entries(j.features ?? {})) if (typeof v === 'boolean') (features as any)[k] = v;
  return {
    isRentalOffer: j.is_rental_offer !== false,
    price: typeof j.price === 'number' && j.price > 0 ? j.price : null,
    currency: CURR.includes(j.currency) ? j.currency : null,
    district: typeof j.district === 'string' ? j.district : null,
    complex: typeof j.complex === 'string' && j.complex.trim() ? j.complex.trim() : null,
    rooms: typeof j.rooms === 'number' ? j.rooms : null,
    area: typeof j.area === 'number' ? j.area : null,
    phones: Array.isArray(j.phones) ? j.phones.filter((p: unknown) => typeof p === 'string') : [],
    pets: PETS.includes(j.pets) ? j.pets : 'unknown',
    onlyOnePerson: j.only_one_person === true,
    features,
    redFlags: Array.isArray(j.red_flags) ? j.red_flags.filter((s: unknown) => typeof s === 'string').slice(0, 5) : [],
    summary: typeof j.summary === 'string' ? j.summary.slice(0, 300) : '',
    extraOk: typeof j.extra_ok === 'boolean' ? j.extra_ok : null,
    extraReason: typeof j.extra_reason === 'string' ? j.extra_reason.slice(0, 120) : '',
  };
}

function describe(l: Listing): string {
  const facts = [
    l.title && `Заголовок: ${l.title}`,
    l.price !== undefined && `Ціна з сайту: ${l.price} ${l.currency ?? ''}`,
    l.district && `Район з сайту: ${l.district}`,
    l.microdistrict && `Мікрорайон: ${l.microdistrict}`,
    l.address && `Адреса: ${l.address}`,
    l.complex && `ЖК: ${l.complex}`,
    l.rooms && `Кімнат: ${l.rooms}`,
    l.area && `Площа: ${l.area} м²`,
    l.floor && `Поверх: ${l.floor}${l.floors ? '/' + l.floors : ''}`,
    `Тварини (поле сайту): ${l.pets}`,
    `Джерело: ${l.origin ?? l.source}`,
  ].filter(Boolean);
  return `${facts.join('\n')}\n\nТекст оголошення:\n${l.text.slice(0, 4000)}`;
}

export const aiEnabled = () => !!CONFIG.anthropicKey;

/** Один запрос к Claude, возвращает текст ответа. Бросает исключение при ошибке. */
export async function callClaude(system: string, user: string, maxTokens: number): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': CONFIG.anthropicKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CONFIG.anthropicModel,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  return (data.content ?? []).map((b: any) => b.text ?? '').join('');
}

export async function analyze(l: Listing): Promise<AiVerdict | undefined> {
  if (!aiEnabled()) return undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return parseAiJson(await callClaude(systemPrompt(), describe(l), 800));
    } catch (e) {
      log(`ИИ: ошибка (попытка ${attempt})`, String(e));
    }
  }
  // ИИ недоступен — лучше прислать без разбора, чем потерять квартиру
  return undefined;
}
