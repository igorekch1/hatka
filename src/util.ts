import { CONFIG, FILTERS, MICRODISTRICT_TO_DISTRICT } from './config.ts';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function log(...args: unknown[]) {
  const ts = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', hour12: false });
  console.log(`[${ts}]`, ...args);
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} ${url}`);
    this.status = status;
  }
}

export async function getJson<T = any>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, {
    headers: {
      'user-agent': CONFIG.userAgent,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'uk-UA,uk;q=0.9,ru;q=0.8,en;q=0.7',
      ...headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new HttpError(res.status, url);
  return (await res.json()) as T;
}

export function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Последние 9 цифр — одинаково для «067…», «+38067…», «38067…» */
export function phoneKey(p: string): string | undefined {
  const d = p.replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : undefined;
}

export function formatPhone(p: string): string {
  const k = phoneKey(p);
  return k ? `+380${k}` : p;
}

export function extractPhones(text: string): string[] {
  const out = new Set<string>();
  const re = /(?:\+?38)?[\s(-]*0\d{2}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g;
  for (const m of text.matchAll(re)) {
    const f = formatPhone(m[0]);
    if (f.startsWith('+380')) out.add(f);
  }
  return [...out];
}

const DISTRICT_STEMS: Array<[RegExp, string]> = [
  [/франк[іоиo]в/i, 'Франківський'],
  [/шевченк[іоиo]в/i, 'Шевченківський'],
  [/гал[иі]ц/i, 'Галицький'],
  [/зал[іе]зни[чн]|железнодор/i, 'Залізничний'],
  [/лича?к[іоиo]в|лычак/i, 'Личаківський'],
  [/сих[іоиo]в/i, 'Сихівський'],
];

/** Приводит «Франковский р-н», «Франківський район» → «Франківський» */
export function normalizeDistrict(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  for (const [re, name] of DISTRICT_STEMS) if (re.test(raw)) return name;
  return undefined;
}

export function districtFromMicro(micro?: string | null): string | undefined {
  if (!micro) return undefined;
  return MICRODISTRICT_TO_DISTRICT[micro.trim().toLowerCase()];
}

export function isAllowedDistrict(d?: string): boolean | undefined {
  if (!d) return undefined;
  return FILTERS.districts.includes(d);
}

/** Ключ ссылки на исходную площадку — чтобы склеить OLX-объявление, найденное напрямую и через Lun */
export function canonicalUrlKey(url?: string | null): string | undefined {
  if (!url) return undefined;
  let m = url.match(/olx\.ua\/.*-ID([A-Za-z0-9]+)\.html/);
  if (m) return `olx-url:${m[1]}`;
  m = url.match(/dom\.ria\.com\/.*-(\d+)\.html/);
  if (m) return `domria:${m[1]}`;
  m = url.match(/rieltor\.ua\/.*\/view\/(\d+)/);
  if (m) return `rieltor:${m[1]}`;
  return undefined;
}

/** Название площадки по ссылке: куда на самом деле ведёт кнопка */
export function siteName(url?: string | null): string | undefined {
  if (!url) return undefined;
  if (/olx\.ua/.test(url)) return 'OLX';
  if (/rieltor\.ua/.test(url)) return 'Rieltor';
  if (/dom\.ria\.com/.test(url)) return 'DIM.RIA';
  if (/lun\.ua/.test(url)) return 'Lun';
  if (/(^|\/\/)t\.me\//.test(url)) return 'Telegram';
  const host = url.match(/^https?:\/\/(?:www\.)?([^/]+)/)?.[1];
  return host ?? undefined;
}

export function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.,]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}

export function ago(d?: Date): string {
  if (!d) return '';
  const min = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (min < 1) return 'щойно';
  if (min < 60) return `${min} хв тому`;
  const h = Math.floor(min / 60);
  return `${h} год ${min % 60} хв тому`;
}
