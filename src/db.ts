import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type ListingStatus = 'notified' | 'rejected' | 'old' | 'duplicate' | 'error' | 'manual';

/** Статус «сделки» по карточке: записались на просмотр / хозяин отказал */
export type DealStatus = 'viewing' | 'refused';

export type MessageRow = {
  chat_id: string;
  message_id: number;
  listing_id: string;
  body: string;
  open_url: string;
  preview_url: string | null;
  claimed_by: string | null;
  skipped_by: string | null;
  /** JSON-массив имён */
  liked_by: string | null;
  deal_status: DealStatus | null;
  deal_by: string | null;
  viewing_at: number | null;
  viewing_note: string | null;
  sent_at: number | null;
};

type MessagePatch = Partial<Pick<MessageRow,
  'claimed_by' | 'skipped_by' | 'liked_by' | 'deal_status' | 'deal_by' | 'viewing_at' | 'viewing_note'>>;

/** Новые колонки для баз, созданных старой версией */
const MESSAGE_COLUMNS: Record<string, string> = {
  liked_by: 'TEXT',
  deal_status: 'TEXT',
  deal_by: 'TEXT',
  viewing_at: 'INTEGER',
  viewing_note: 'TEXT',
  sent_at: 'INTEGER',
};

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS seen (
        key TEXT PRIMARY KEY,
        listing_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS listings (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        url TEXT,
        status TEXT NOT NULL,
        reason TEXT,
        score REAL,
        price_usd REAL,
        created_at INTEGER NOT NULL,
        data TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        listing_id TEXT NOT NULL,
        body TEXT NOT NULL,
        open_url TEXT,
        preview_url TEXT,
        claimed_by TEXT,
        skipped_by TEXT,
        PRIMARY KEY (chat_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE INDEX IF NOT EXISTS listings_created ON listings(created_at);
    `);
    const have = new Set((this.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((c) => c.name));
    for (const [col, type] of Object.entries(MESSAGE_COLUMNS))
      if (!have.has(col)) this.db.exec(`ALTER TABLE messages ADD COLUMN ${col} ${type}`);
  }

  isSeen(key: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM seen WHERE key = ?').get(key);
  }

  /** Какой из ключей уже встречался и к какому объявлению он привязан */
  findSeen(keys: string[]): { key: string; listing_id: string } | undefined {
    for (const k of keys) {
      const row = this.db.prepare('SELECT key, listing_id FROM seen WHERE key = ?').get(k) as
        | { key: string; listing_id: string }
        | undefined;
      if (row) return row;
    }
    return undefined;
  }

  markSeen(keys: string[], listingId: string) {
    const st = this.db.prepare('INSERT OR IGNORE INTO seen(key, listing_id, created_at) VALUES (?, ?, ?)');
    const now = Date.now();
    for (const k of keys) st.run(k, listingId, now);
  }

  saveListing(id: string, source: string, url: string, status: ListingStatus, extra: {
    reason?: string; score?: number; priceUsd?: number; data?: unknown;
  } = {}) {
    this.db
      .prepare(`INSERT INTO listings(id, source, url, status, reason, score, price_usd, created_at, data)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET status=excluded.status, reason=excluded.reason,
                  score=excluded.score, price_usd=excluded.price_usd, data=excluded.data`)
      .run(id, source, url, status, extra.reason ?? null, extra.score ?? null, extra.priceUsd ?? null,
        Date.now(), extra.data === undefined ? null : JSON.stringify(extra.data));
  }

  getStatus(id: string): ListingStatus | undefined {
    const row = this.db.prepare('SELECT status FROM listings WHERE id = ?').get(id) as { status: ListingStatus } | undefined;
    return row?.status;
  }

  saveMessage(m: { chatId: string; messageId: number; listingId: string; body: string; openUrl: string; previewUrl?: string }) {
    this.db
      .prepare(`INSERT OR REPLACE INTO messages(chat_id, message_id, listing_id, body, open_url, preview_url, sent_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(m.chatId, m.messageId, m.listingId, m.body, m.openUrl, m.previewUrl ?? null, Date.now());
  }

  getMessage(chatId: string, messageId: number): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE chat_id = ? AND message_id = ?').get(chatId, messageId) as
      | MessageRow
      | undefined;
  }

  updateMessage(chatId: string, messageId: number, patch: MessagePatch) {
    const keys = Object.keys(patch).filter((k) => k in MESSAGE_COLUMNS || k === 'claimed_by' || k === 'skipped_by');
    if (!keys.length) return;
    this.db
      .prepare(`UPDATE messages SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE chat_id = ? AND message_id = ?`)
      .run(...keys.map((k) => (patch as any)[k] ?? null), chatId, messageId);
  }

  findMessageByListing(chatId: string, listingId: string): MessageRow | undefined {
    return this.db
      .prepare('SELECT * FROM messages WHERE chat_id = ? AND listing_id = ? ORDER BY message_id DESC LIMIT 1')
      .get(chatId, listingId) as MessageRow | undefined;
  }

  /** Карточки с оценкой от minScore (оценка — из listings) за последние days дней, свежие сверху */
  listTop(chatId: string, minScore: number, days = 30, limit = 40): Array<MessageRow & { score: number }> {
    return this.db
      .prepare(`SELECT m.*, l.score AS score FROM messages m JOIN listings l ON l.id = m.listing_id
                WHERE m.chat_id = ? AND l.score >= ? AND COALESCE(m.sent_at, l.created_at) >= ?
                ORDER BY COALESCE(m.sent_at, 0) DESC, m.message_id DESC LIMIT ?`)
      .all(chatId, minScore, Date.now() - days * 86400_000, limit) as Array<MessageRow & { score: number }>;
  }

  /** Карточки, которые кому-то понравились — свежие сверху */
  listLiked(chatId: string, limit = 40): MessageRow[] {
    return this.db
      .prepare(`SELECT * FROM messages WHERE chat_id = ? AND liked_by IS NOT NULL AND liked_by != '[]'
                ORDER BY COALESCE(sent_at, 0) DESC, message_id DESC LIMIT ?`)
      .all(chatId, limit) as MessageRow[];
  }

  /** Записи на просмотр: сначала с датой по порядку, потом без даты */
  listViewings(chatId: string): MessageRow[] {
    return this.db
      .prepare(`SELECT * FROM messages WHERE chat_id = ? AND deal_status = 'viewing'
                ORDER BY viewing_at IS NULL, viewing_at, message_id`)
      .all(chatId) as MessageRow[];
  }

  stats(sinceMs: number): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM listings WHERE created_at >= ? GROUP BY status')
      .all(sinceMs) as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }

  topRejectReasons(sinceMs: number, limit = 5) {
    return this.db
      .prepare(`SELECT reason, COUNT(*) AS n FROM listings WHERE created_at >= ? AND status = 'rejected'
                GROUP BY reason ORDER BY n DESC LIMIT ?`)
      .all(sinceMs, limit) as Array<{ reason: string; n: number }>;
  }

  getKv(k: string): string | undefined {
    const row = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined;
    return row?.v;
  }

  setKv(k: string, v: string) {
    this.db.prepare('INSERT OR REPLACE INTO kv(k, v) VALUES (?, ?)').run(k, v);
  }

  delKv(k: string) {
    this.db.prepare('DELETE FROM kv WHERE k = ?').run(k);
  }

  /** Чистим «seen» старше 60 дней, чтобы база не росла бесконечно */
  prune() {
    this.db.prepare('DELETE FROM seen WHERE created_at < ?').run(Date.now() - 60 * 86400_000);
    // Вопросы бота («коли перегляд?»), на которые так и не ответили
    this.db
      .prepare(`DELETE FROM kv WHERE k LIKE 'pending:%' AND CAST(json_extract(v, '$.ts') AS INTEGER) < ?`)
      .run(Date.now() - 7 * 86400_000);
  }
}
