/**
 * Разбор даты просмотра из живого текста: «завтра о 18», «пт 12:30», «14.11 18:00»,
 * «15 листопада о 10». Всё — по киевскому времени, независимо от часового пояса сервера.
 */
const TZ = 'Europe/Kyiv';
const WD_SHORT = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

type Ymd = { y: number; m: number; d: number };

function kyivParts(ms: number) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute') };
}

/** Момент времени для «y-m-d h:min по Киеву» */
export function kyivTime(y: number, m: number, d: number, h: number, min: number): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const p = kyivParts(guess);
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - guess;
  return guess - offset;
}

const addDays = (x: Ymd, n: number): Ymd => {
  const t = new Date(Date.UTC(x.y, x.m - 1, x.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const weekday = (x: Ymd) => new Date(Date.UTC(x.y, x.m - 1, x.d)).getUTCDay();
const pad = (n: number) => String(n).padStart(2, '0');

/** «пт 14.11 о 18:30» */
export function formatKyiv(ms: number, withTime = true): string {
  const p = kyivParts(ms);
  const wd = WD_SHORT[weekday(p)];
  return `${wd} ${pad(p.d)}.${pad(p.m)}${withTime ? ` о ${pad(p.h)}:${pad(p.min)}` : ''}`;
}

const L = '[а-яіїєґa-z\']'; // «буква» для границ слова (\b в JS не работает с кириллицей)
const word = (stem: string) => new RegExp(`(?<!${L})(?:${stem})`, 'i');

const WEEKDAYS: Array<[RegExp, number]> = [
  [word(`понеділ|понедел|пн(?!${L})`), 1],
  [word(`вівтор|вторн|вт(?!${L})`), 2],
  [word(`серед|сред|ср(?!${L})`), 3],
  [word(`четвер|чт(?!${L})`), 4],
  [word(`п'?ятниц|пятниц|пт(?!${L})`), 5],
  [word(`субот|сб(?!${L})`), 6],
  [word(`неділ|воскрес|нд(?!${L})|вс(?!${L})`), 0],
];

const MONTHS: Array<[string, number]> = [
  ['січ|январ', 1], ['лют|феврал', 2], ['берез|март', 3], ['квіт|апрел', 4], ['трав|ма[йя]', 5], ['черв|июн', 6],
  ['лип|июл', 7], ['серп|август', 8], ['верес|сентябр', 9], ['жовт|октябр', 10], ['листопад|ноябр', 11], ['груд|декабр', 12],
];

export type ViewingTime = { at?: number; label?: string };

/**
 * Возвращает момент и подпись. Пустой объект — «дата пока неизвестна».
 * Если ничего не распознали — label = исходный текст (чтобы не потерять «после 18 в будни» и т.п.).
 */
export function parseViewingTime(input: string, now = Date.now()): ViewingTime {
  const raw = input.trim();
  let t = raw.toLowerCase().replace(/[’ʼ`]/g, "'").replace(/\s+/g, ' ');
  if (!t || /^(-|—|–|\?|не знаю|невідомо|ще невідомо|ще не відомо|неизвестно|потім|пізніше|позже)$/.test(t)) return {};

  const n = kyivParts(now);
  const today: Ymd = { y: n.y, m: n.m, d: n.d };
  let day: Ymd | undefined;
  let hh: number | undefined;
  let mm = 0;

  // 1) время с двоеточием: 18:30
  let m = t.match(/(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/);
  if (m) {
    hh = Number(m[1]);
    mm = Number(m[2]);
    t = t.replace(m[0], ' ');
  }

  // 2) дата 14.11 / 14.11.2026 / 14/11
  m = t.match(/(?<!\d)(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?!\d)/);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[1]) >= 1 && Number(m[1]) <= 31) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : today.y;
    day = { y, m: Number(m[2]), d: Number(m[1]) };
    if (!m[3] && Date.UTC(y, day.m - 1, day.d) < Date.UTC(today.y, today.m - 1, today.d) - 86400_000) day.y++;
    t = t.replace(m[0], ' ');
  }

  // 3) «15 листопада»
  if (!day) {
    for (const [stem, month] of MONTHS) {
      m = t.match(new RegExp(`(?<!\\d)(\\d{1,2})\\s*(?:${stem})${L}*`, 'i'));
      if (m) {
        day = { y: today.y, m: month, d: Number(m[1]) };
        if (Date.UTC(day.y, month - 1, day.d) < Date.UTC(today.y, today.m - 1, today.d) - 86400_000) day.y++;
        t = t.replace(m[0], ' ');
        break;
      }
    }
  }

  // 4) сегодня / завтра / послезавтра / день недели
  if (!day) {
    if (/післязавтра|послезавтра/.test(t)) day = addDays(today, 2);
    else if (/завтра/.test(t)) day = addDays(today, 1);
    else if (/сьогодні|сегодня/.test(t)) day = today;
    else
      for (const [re, wd] of WEEKDAYS) {
        if (re.test(t)) {
          day = addDays(today, (wd - weekday(today) + 7) % 7);
          break;
        }
      }
  }

  // 5) время без двоеточия: «о 18», «на 18.30», «18 год»
  if (hh === undefined) {
    m = t.match(new RegExp(`(?<!${L})(?:о|об|на|в|у|at)\\s*(\\d{1,2})(?:[.:](\\d{2}))?(?!\\d)`, 'i')) ??t.match(/(?<!\d)(\d{1,2})(?:[.:](\d{2}))?\s*(?:год|час|h)/i);
    if (m && Number(m[1]) <= 23) {
      hh = Number(m[1]);
      mm = m[2] ? Number(m[2]) : 0;
      // «о 6» в контексте просмотра — почти наверняка вечер
      if (hh >= 1 && hh <= 7 && !m[2]) hh += 12;
    }
  }

  if (!day && hh === undefined) return { label: raw.slice(0, 80) };

  if (!day) {
    // только время: сегодня, если ещё не прошло, иначе завтра
    const at = kyivTime(today.y, today.m, today.d, hh!, mm);
    day = at > now ? today : addDays(today, 1);
  } else if (hh !== undefined && day.y === today.y && day.m === today.m && day.d === today.d) {
    // «пт 10:00» в пятницу, когда 10:00 уже прошло — значит следующая пятница
    const isWeekday = WEEKDAYS.some(([re]) => re.test(raw.toLowerCase()));
    if (isWeekday && kyivTime(day.y, day.m, day.d, hh, mm) < now) day = addDays(day, 7);
  }

  const hasTime = hh !== undefined;
  const at = kyivTime(day.y, day.m, day.d, hasTime ? hh! : 12, hasTime ? mm : 0);
  return { at, label: formatKyiv(at, hasTime) };
}
