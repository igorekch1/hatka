import { CONFIG } from '../config.ts';
import { parseCurrency } from '../fx.ts';
import type { Currency, Listing, PetsPolicy } from '../types.ts';
import { extractPhones, log, normalizeDistrict } from '../util.ts';

/**
 * Telegram-каналы читаются от имени ТВОЕГО аккаунта (userbot, MTProto):
 * обычный бот не может читать чужие каналы. Сессия создаётся один раз командой
 * `npm run tg-login` и хранится в .env как TG_SESSION. Userbot только читает.
 *
 * Сообщения приходят событием (без опроса) — это самый быстрый источник.
 */

/** Грубый разбор цены из текста поста; точнее — делает ИИ */
export function parsePriceFromText(text: string): { price?: number; currency?: Currency } {
  const t = text.replace(/ /g, ' ');
  const patterns: RegExp[] = [
    /(\$|usd|💵)\s*(\d[\d\s.,]{1,7})/i,
    /(\d[\d\s.,]{1,7})\s*(\$|usd|у\.?\s?о\.?|дол|грн|uah|₴|гривен|€|eur|євро)/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const [numPart, curPart] = /\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
    const price = Number(numPart.replace(/[\s.,]/g, ''));
    let currency = parseCurrency(curPart);
    if (!currency && /у\.?\s?о/i.test(curPart)) currency = 'USD';
    if (price >= 100 && price <= 500_000) return { price, currency };
  }
  return {};
}

export function textPets(text: string): PetsPolicy {
  if (
    /без\s+(домашн\S*\s+)?(тварин|животн)|тварин\S*\s+не\s|животн\S*\s+не\s|no\s+pets|не\s+(доступн\S*|підходить|подходит)\s+для\s+(власників|владельцев)\s+(тварин|животн)|тварин\S*\s+заборон|животн\S*\s+запрещ/i.test(text)
  )
    return 'no';
  if (/(можна|можно|дозволено|разрешено).{0,30}(тварин|животн|собак|песик)/i.test(text)) return 'some';
  return 'unknown';
}

export function mapTelegramPost(p: {
  channel: string; channelTitle?: string; messageId: number; text: string; date: Date; link: string;
}): Listing {
  const { price, currency } = parsePriceFromText(p.text);
  return {
    id: `telegram:${p.channel}:${p.messageId}`,
    source: 'telegram',
    externalId: `${p.channel}:${p.messageId}`,
    url: p.link,
    origin: p.channelTitle ?? p.channel,
    text: p.text,
    price,
    currency,
    district: normalizeDistrict(p.text.match(/\S+\s+(р-н|район|р\.)/i)?.[0]),
    photos: [],
    phones: extractPhones(p.text),
    pets: textPets(p.text),
    features: {},
    publishedAt: p.date,
    // Для публичных каналов Telegram сам покажет превью поста с фото
    previewUrl: p.link.includes('/c/') ? undefined : p.link,
    dedupKeys: [`telegram:${p.channel}:${p.messageId}`],
  };
}

const pkg = (name: string) => name; // динамический импорт: пакет нужен только если включён Telegram-источник

/** gramjs — CommonJS-пакет; подтягиваем классы так, чтобы работало при любом способе экспорта */
export async function loadGramJs(): Promise<{ TelegramClient: any; StringSession: any; NewMessage: any }> {
  const main: any = await import(pkg('telegram'));
  const root = main.default ?? main;
  const sessions: any = root.sessions ?? (await import(pkg('telegram/sessions/index.js')));
  const events: any = root.events ?? (await import(pkg('telegram/events/index.js')));
  return {
    TelegramClient: root.TelegramClient ?? main.TelegramClient,
    StringSession: (sessions.default ?? sessions).StringSession,
    NewMessage: (events.default ?? events).NewMessage,
  };
}

export async function startTelegramSource(onListing: (l: Listing) => Promise<void>): Promise<() => Promise<void>> {
  if (!CONFIG.tgApiId || !CONFIG.tgApiHash || !CONFIG.tgSession) {
    log('Telegram-каналы: не настроены TG_API_ID / TG_API_HASH / TG_SESSION — пропускаю');
    return async () => {};
  }
  if (CONFIG.tgChannels.length === 0) {
    log('Telegram-каналы: список TG_CHANNELS пуст — пропускаю');
    return async () => {};
  }

  const { TelegramClient, StringSession, NewMessage } = await loadGramJs();

  const client = new TelegramClient(new StringSession(CONFIG.tgSession), CONFIG.tgApiId, CONFIG.tgApiHash, {
    connectionRetries: 10,
    autoReconnect: true,
  });
  client.setLogLevel?.('error');
  await client.connect();

  const meta = new Map<string, { username?: string; title?: string; key: string }>();
  const chatIds: any[] = [];
  for (const ch of CONFIG.tgChannels) {
    try {
      const entity = await client.getEntity(ch);
      const key = entity.username ?? String(entity.id);
      meta.set(String(entity.id), { username: entity.username, title: entity.title, key });
      chatIds.push(entity.id);
      log(`Telegram: слушаю «${entity.title ?? ch}»`);
    } catch (e) {
      log(`Telegram: не нашёл канал ${ch} (вы в нём состоите? правильный @username?)`, String(e));
    }
  }

  client.addEventHandler(async (event: any) => {
    try {
      const m = event.message;
      const text: string = m?.message ?? '';
      if (text.length < 40) return; // альбомы: фото без подписи, стикеры и т.п.
      const chatId = String(m.chatId ?? m.peerId?.channelId ?? '');
      const info = meta.get(chatId) ?? meta.get(chatId.replace(/^-100/, ''));
      const channel = info?.key ?? chatId;
      const link = info?.username
        ? `https://t.me/${info.username}/${m.id}`
        : `https://t.me/c/${chatId.replace(/^-100/, '')}/${m.id}`;
      await onListing(
        mapTelegramPost({ channel, channelTitle: info?.title, messageId: m.id, text, date: new Date(m.date * 1000), link }),
      );
    } catch (e) {
      log('Telegram: ошибка обработки сообщения', String(e));
    }
  }, new NewMessage({ chats: chatIds }));

  return async () => {
    await client.disconnect();
  };
}
