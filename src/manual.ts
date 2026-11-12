import { analyze } from './ai.ts';
import type { Bot, Reply } from './bot.ts';
import { CONFIG } from './config.ts';
import type { MessageRow, Store } from './db.ts';
import { adjustPets, keywordFeatures, mergeAi, score } from './filter.ts';
import { toUsd } from './fx.ts';
import { fingerprints } from './pipeline.ts';
import { messageLink, renderListing } from './render.ts';
import { DETAILS, mapDomRia } from './sources/domria.ts';
import { parsePriceFromText, textPets } from './sources/telegram.ts';
import type { Listing } from './types.ts';
import { canonicalUrlKey, escapeHtml as e, extractPhones, getJson, log, normalizeDistrict, stripHtml } from './util.ts';

/**
 * /add <ссылка> [заметка] — квартира, которую нашли сами. Бот собирает карточку
 * (насколько получится вытащить данные со страницы + ИИ), присылает в группу
 * и сразу ставит «❤️ Подобається» от того, кто добавил. Фильтры не применяются.
 */

const URL_RE = /https?:\/\/[^\s<>"']+/i;

/** Без query/hash и слэша в конце — чтобы ?utm и #photo не мешали узнать ту же ссылку */
export function normalizeUrl(url: string): string {
  return url.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
}

function meta(html: string, name: string): string | undefined {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i');
  const m = html.match(re);
  const v = m?.[1] ?? m?.[2];
  return v ? stripHtml(v).trim() : undefined;
}

/** Видимый текст страницы без скриптов/стилей — для ИИ */
function pageText(html: string): string {
  return stripHtml(
    html
      .replace(/<(script|style|noscript|svg|head|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|li|h\d|section|article)>/gi, '\n'),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

async function getHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'user-agent': CONFIG.userAgent,
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'uk-UA,uk;q=0.9,ru;q=0.8,en;q=0.7',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Собирает Listing из страницы (или только из заметки, если страница не открылась) */
export function listingFromPage(url: string, html: string | undefined, note: string): Listing {
  const title = html ? (meta(html, 'og:title') ?? html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim()) : undefined;
  const ogDesc = html ? meta(html, 'og:description') : undefined;
  const desc = html ? meta(html, 'description') : undefined;
  const body = html ? pageText(html).slice(0, 5000) : '';
  const head = [title, ogDesc, desc !== ogDesc ? desc : undefined, note && `Нотатка: ${note}`].filter(Boolean).join('\n');
  const text = [head, body].filter(Boolean).join('\n\n');

  const { price, currency } = parsePriceFromText(`${ogDesc ?? ''}\n${title ?? ''}\n${note}\n${body.slice(0, 1500)}`);
  const lat = html?.match(/"lat(?:itude)?"\s*:\s*"?(4[89]\.\d+)/)?.[1];
  const lon = html?.match(/"(?:lon|lng|longitude)"\s*:\s*"?(2[34]\.\d+)/)?.[1];
  const key = canonicalUrlKey(url);
  const id = `manual:${normalizeUrl(url).replace(/^https?:\/\/(www\.)?/, '')}`;
  return {
    id,
    source: 'manual',
    externalId: id.slice(7),
    url,
    title,
    text,
    price,
    currency,
    district: normalizeDistrict(`${note} ${desc ?? ''} ${ogDesc ?? ''}`.match(/\S+\s+(р-н|район|р\.)/i)?.[0]),
    lat: lat ? Number(lat) : undefined,
    lon: lon ? Number(lon) : undefined,
    photos: [],
    // Телефоны берём только из заметки и описания: на странице полно чужих номеров (сайта, агентства)
    phones: extractPhones(`${note}\n${ogDesc ?? ''}`),
    pets: textPets(`${note}\n${ogDesc ?? ''}`),
    features: {},
    // Telegram сам построит превью по ссылке, даже если нашему серверу сайт не отдался
    previewUrl: url,
    dedupKeys: [id, ...(key ? [key] : [])],
  };
}

async function fetchListing(url: string, note: string): Promise<{ listing: Listing; loaded: boolean }> {
  const ria = url.match(/dom\.ria\.com\/.*-(\d+)\.html/);
  if (ria) {
    try {
      const l = mapDomRia(await getJson(DETAILS(ria[1])));
      return { listing: { ...l, text: note ? `${l.text}\nНотатка: ${note}` : l.text }, loaded: true };
    } catch (err) {
      log('DIM.RIA: не удалось получить детали для /add', String(err));
    }
  }
  try {
    return { listing: listingFromPage(url, await getHtml(url), note), loaded: true };
  } catch (err) {
    log(`/add: страница не открылась (${url})`, String(err));
    return { listing: listingFromPage(url, undefined, note), loaded: false };
  }
}

/** Карточка, которая уже есть в группе для этой ссылки (бот присылал или добавляли раньше) */
export function findCard(store: Store, chatId: string, url: string): MessageRow | undefined {
  const norm = normalizeUrl(url);
  const byUrl = (store.db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY message_id DESC').all(chatId) as MessageRow[])
    .find((r) => r.open_url && normalizeUrl(r.open_url) === norm);
  if (byUrl) return byUrl;
  const key = canonicalUrlKey(url);
  const seen = key ? store.findSeen([key]) : undefined;
  return seen ? store.findMessageByListing(chatId, seen.listing_id) : undefined;
}

export const ADD_HELP = [
  '➕ <b>Додати квартиру, яку знайшли самі</b>',
  'Надішліть у відповідь на це повідомлення посилання (OLX, DIM.RIA, Rieltor, Lun, пост у Telegram…).',
  'Після посилання можна дописати нотатку: <i>«2к, $800, Франківський, з собакою ок, 0671234567»</i> — це допоможе, якщо сайт не віддасть дані.',
].join('\n');

export async function addManual(store: Store, bot: Bot, args: string, chatId: string, who: string): Promise<Reply> {
  const url = args.match(URL_RE)?.[0]?.replace(/[).,]+$/, '');
  if (!url) return { text: `Не бачу посилання.\n\n${ADD_HELP}`, ask: 'add' };
  const note = args.replace(url, '').trim();

  const existing = findCard(store, chatId, url);
  if (existing) {
    await bot.likeCard(existing, who);
    const link = messageLink(existing.chat_id, existing.message_id);
    return `❤️ Ця квартира вже є в чаті${link ? ` — <a href="${e(link)}">картка</a>` : ''}. Позначив «Подобається» від ${e(who)}.`;
  }

  const { listing: raw, loaded } = await fetchListing(url, note);
  let l: Listing = adjustPets({ ...raw, priceUsd: raw.priceUsd ?? toUsd(raw.price, raw.currency) });
  const ai = await analyze(l);
  if (ai) l = adjustPets(mergeAi(l, ai, toUsd));
  l = keywordFeatures(l);
  const s = score(l);

  let body = `${renderListing(l, s, ai)}\n➕ <i>Додано вручну (${e(who)})</i>`;
  if (!loaded) body += '\n⚠️ <i>Сторінка не відкрилась — картка зібрана з нотатки. Деталі дивіться за посиланням.</i>';

  const sent = await bot.sendListing(l.id, body, l.url, l.previewUrl, { likedBy: who });
  // Чтобы бот потом не прислал эту же квартиру как новую
  store.markSeen([...l.dedupKeys, ...fingerprints(l)], l.id);
  store.saveListing(l.id, l.source, l.url, 'manual', { score: s, priceUsd: l.priceUsd, data: { ai, district: l.district } });
  return sent ? '' : 'Не вдалося надіслати картку 😕';
}
