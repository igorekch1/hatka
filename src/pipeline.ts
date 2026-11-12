import { aiEnabled, analyze } from './ai.ts';
import type { Bot } from './bot.ts';
import { CONFIG, FILTERS, FILTERS_STATE } from './config.ts';
import type { Store } from './db.ts';
import { adjustPets, aiFilter, hardFilter, keywordFeatures, mergeAi, score } from './filter.ts';
import { toUsd } from './fx.ts';
import { renderListing } from './render.ts';
import type { Listing } from './types.ts';
import { log, phoneKey, sleep } from './util.ts';

/** Вторичные «отпечатки», чтобы склеить одну квартиру от разных риелторов/площадок */
export function fingerprints(l: Listing): string[] {
  const out: string[] = [];
  const area = l.area ? Math.round(l.area) : undefined;
  if (area) {
    for (const p of l.phones) {
      const k = phoneKey(p);
      if (k) out.push(`fp:${k}:${area}`);
    }
    if (l.address && /\d/.test(l.address)) {
      const addr = l.address.toLowerCase().replace(/вулиця|вул\.|улица|ул\.|[^a-zа-яіїєґ0-9]/gi, '');
      if (l.priceUsd) out.push(`addr:${addr}:${area}:${Math.round(l.priceUsd / 50)}`);
    }
    // Тот же район + та же площадь + та же цена (±$5) — почти наверняка одна и та же квартира
    if (l.district && l.priceUsd) out.push(`pad:${l.district}:${area}:${Math.round(l.priceUsd / 10)}`);
  }
  return out;
}

export class Pipeline {
  private queue: Promise<void> = Promise.resolve();
  private store: Store;
  private bot: Bot;

  constructor(store: Store, bot: Bot) {
    this.store = store;
    this.bot = bot;
  }

  /** Все объявления обрабатываются строго по очереди — так дедупликация не ошибается */
  enqueue(l: Listing): Promise<void> {
    this.queue = this.queue.then(() => this.process(l)).catch((e) => log(`Ошибка обработки ${l.id}:`, String(e)));
    return this.queue;
  }

  private reject(l: Listing, reason: string) {
    this.store.saveListing(l.id, l.source, l.url, 'rejected', { reason, priceUsd: l.priceUsd });
    if (CONFIG.dryRun) console.log(`  ✗ ${l.id} — ${reason}`);
  }

  async process(raw: Listing): Promise<void> {
    const seen = this.store.findSeen(raw.dedupKeys);
    if (seen) {
      // Уже видели это же объявление или его копию с другой площадки
      this.store.markSeen(raw.dedupKeys, seen.listing_id);
      if (seen.listing_id !== raw.id && !this.store.getStatus(raw.id))
        this.store.saveListing(raw.id, raw.source, raw.url, 'duplicate', { reason: `копія ${seen.listing_id}` });
      return;
    }
    this.store.markSeen(raw.dedupKeys, raw.id);

    if (raw.publishedAt && Date.now() - raw.publishedAt.getTime() > CONFIG.maxAgeHours * 3600_000) {
      this.store.saveListing(raw.id, raw.source, raw.url, 'old');
      return;
    }

    let l: Listing = adjustPets({ ...raw, priceUsd: raw.priceUsd ?? toUsd(raw.price, raw.currency) });

    // Та же квартира от другого риелтора / с другой площадки — уже видели (и прислали или отсеяли)
    const early = fingerprints(l);
    const earlyDup = this.store.findSeen(early);
    if (earlyDup) {
      this.store.markSeen(early, earlyDup.listing_id);
      this.store.saveListing(l.id, l.source, l.url, 'duplicate', { reason: `схожа на ${earlyDup.listing_id}` });
      return;
    }
    this.store.markSeen(early, l.id);

    // Фильтры не заданы — критериев нет, ничего не присылаем (и не тратим ИИ)
    if (!FILTERS_STATE.configured) return this.reject(l, 'фільтри не задані');

    const pre = hardFilter(l);
    if (!pre.ok) return this.reject(l, pre.reason);

    const ai = await analyze(l);
    if (ai) {
      const av = aiFilter(ai);
      if (!av.ok) return this.reject(l, av.reason);
      l = adjustPets(mergeAi(l, ai, toUsd));
      const post = hardFilter(l);
      if (!post.ok) return this.reject(l, post.reason);
    }
    l = keywordFeatures(l);

    if (!l.district && !FILTERS.allowUnknownDistrict) return this.reject(l, 'район не визначено');
    if (l.source === 'telegram' && l.priceUsd === undefined && !aiEnabled())
      return this.reject(l, 'не вдалося зрозуміти ціну');

    // ИИ мог дополнить телефон/район — проверяем дубли ещё раз
    const fps = fingerprints(l).filter((k) => !early.includes(k));
    const dup = this.store.findSeen(fps);
    if (dup) {
      this.store.saveListing(l.id, l.source, l.url, 'duplicate', { reason: `схожа на ${dup.listing_id}` });
      return;
    }
    this.store.markSeen(fps, l.id);

    const s = score(l);
    if (s < FILTERS.minScore) return this.reject(l, `оцінка ${s} < ${FILTERS.minScore}`);

    if (this.store.getKv('paused') === '1') return this.reject(l, 'пауза');

    const body = renderListing(l, s, ai);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.bot.sendListing(l.id, body, l.url, l.previewUrl);
        this.store.saveListing(l.id, l.source, l.url, 'notified', { score: s, priceUsd: l.priceUsd, data: { ai, district: l.district } });
        log(`✅ Отправил ${l.id} ($${l.priceUsd ?? '?'}, ${l.district ?? 'район ?'}, оценка ${s})`);
        return;
      } catch (e) {
        log(`Не удалось отправить ${l.id} (попытка ${attempt})`, String(e));
        // Если Telegram не смог загрузить превью — пробуем без него
        if (String(e).includes('WEBPAGE') || String(e).includes('preview')) l = { ...l, previewUrl: undefined };
        await sleep(2000 * attempt);
      }
    }
    this.store.saveListing(l.id, l.source, l.url, 'error', { reason: 'не вдалося надіслати в Telegram' });
  }
}
