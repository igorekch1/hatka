import { CONFIG } from './config.ts';
import type { Currency } from './types.ts';
import { getJson, log } from './util.ts';

let uahPerUsd = CONFIG.fxFallback;
let eurPerUsd = 0.92;
let updatedAt = 0;

/** Курс НБУ, обновляется раз в 6 часов; при ошибке остаётся последний известный */
export async function refreshFx(): Promise<void> {
  if (Date.now() - updatedAt < 6 * 3600_000) return;
  try {
    const rows = await getJson<Array<{ cc: string; rate: number }>>(
      'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json',
    );
    const usd = rows.find((r) => r.cc === 'USD')?.rate;
    const eur = rows.find((r) => r.cc === 'EUR')?.rate;
    if (usd) uahPerUsd = usd;
    if (usd && eur) eurPerUsd = usd / eur;
    updatedAt = Date.now();
    log(`Курс НБУ: 1 USD = ${uahPerUsd.toFixed(2)} грн`);
  } catch (e) {
    log('Не удалось обновить курс НБУ, использую', uahPerUsd, String(e));
  }
}

/** Текущий курс: сколько гривен в долларе */
export const uahPerUsdRate = () => uahPerUsd;

export function toUsd(price?: number, currency?: Currency): number | undefined {
  if (price === undefined || !currency) return undefined;
  if (currency === 'USD') return price;
  if (currency === 'UAH') return Math.round(price / uahPerUsd);
  return Math.round(price / eurPerUsd);
}

export function toUah(usd: number): number {
  return Math.round((usd * uahPerUsd) / 100) * 100;
}

export function parseCurrency(raw?: string | null): Currency | undefined {
  if (!raw) return undefined;
  const s = raw.toLowerCase();
  if (s.includes('usd') || s.includes('$') || s.includes('дол')) return 'USD';
  if (s.includes('uah') || s.includes('грн') || s.includes('₴') || s.includes('гривн')) return 'UAH';
  if (s.includes('eur') || s.includes('€') || s.includes('євро') || s.includes('евро')) return 'EUR';
  return undefined;
}
