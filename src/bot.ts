import { CONFIG } from './config.ts';
import type { MessageRow, Store } from './db.ts';
import { likedNames, renderStatusLines } from './render.ts';
import { log, siteName, sleep } from './util.ts';
import { parseViewingTime } from './when.ts';

export type Button = { text: string; data?: string; url?: string };
/** Ответ на команду: просто текст, или текст с кнопками, или вопрос, на который ждём reply */
export type Reply = string | { text: string; buttons?: Button[][]; ask?: 'filters' };
export type CommandHandler = (cmd: string, args: string, chatId: string, who: string) => Promise<Reply | undefined>;

/** Чего ждём в ответ на сообщение бота (хранится в kv: pending:<chat>:<msg>) */
type Pending = { kind: 'filters'; ts: number } | { kind: 'viewing'; messageId: number; ts: number };

const TG_LIMIT = 3900;

const CANCEL = /^(скасувати|скасуй|відміна|отмена|отменить|cancel)$/i;

/** «🔗 Відкрити на OLX» — сразу видно, куда ведёт ссылка */
export function openLabel(url: string): string {
  const site = siteName(url);
  if (site === 'Telegram') return '🔗 Відкрити пост у Telegram';
  return site ? `🔗 Відкрити на ${site}` : '🔗 Відкрити оголошення';
}

function personName(from: any): string {
  return [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username || 'хтось';
}

/** Режет длинный текст по абзацам, чтобы влезть в лимит Telegram */
export function splitMessage(text: string, limit = TG_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let cur = '';
  for (const part of text.split('\n\n')) {
    const next = cur ? `${cur}\n\n${part}` : part;
    if (next.length > limit && cur) {
      out.push(cur);
      cur = part;
    } else cur = next;
  }
  if (cur) out.push(cur);
  return out.flatMap((c) => (c.length > limit ? c.match(new RegExp(`[\\s\\S]{1,${limit}}`, 'g'))! : [c]));
}

export class Bot {
  private offset = 0;
  private stopped = false;
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  async api<T = any>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${CONFIG.botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(method === 'getUpdates' ? 70_000 : 20_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!data.ok) {
      const retry = data.parameters?.retry_after;
      if (retry) {
        await sleep((retry + 1) * 1000);
        return this.api(method, body);
      }
      throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
    }
    return data.result as T;
  }

  private cardKeyboard(openUrl: string) {
    return {
      inline_keyboard: [
        [{ text: openLabel(openUrl), url: openUrl }],
        [
          { text: '❤️ Подобається', callback_data: 'like' },
          { text: '📞 Дзвоню я', callback_data: 'call' },
        ],
        [{ text: '📅 Записались на перегляд', callback_data: 'viewing' }],
        [
          { text: '🚫 Відмовили', callback_data: 'refused' },
          { text: '❌ Не підходить', callback_data: 'skip' },
        ],
      ],
    };
  }

  private inlineKeyboard(buttons: Button[][]) {
    return {
      inline_keyboard: buttons.map((row) =>
        row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data ?? 'noop' })),
      ),
    };
  }

  private preview(previewUrl?: string | null) {
    return previewUrl
      ? { url: previewUrl, prefer_large_media: true, show_above_text: true }
      : { is_disabled: true };
  }

  /** Отправляет карточку квартиры в общий чат */
  async sendListing(listingId: string, body: string, openUrl: string, previewUrl?: string): Promise<void> {
    if (CONFIG.dryRun || !CONFIG.botToken) {
      console.log(`\n──────── ${listingId}\n${body.replace(/<[^>]+>/g, '')}\n🔗 ${openUrl}`);
      return;
    }
    const msg = await this.api<{ message_id: number }>('sendMessage', {
      chat_id: CONFIG.chatId,
      text: body,
      parse_mode: 'HTML',
      link_preview_options: this.preview(previewUrl),
      reply_markup: this.cardKeyboard(openUrl),
    });
    this.store.saveMessage({ chatId: String(CONFIG.chatId), messageId: msg.message_id, listingId, body, openUrl, previewUrl });
  }

  async sendText(text: string): Promise<void> {
    if (CONFIG.dryRun || !CONFIG.botToken) {
      console.log(`[бот] ${text}`);
      return;
    }
    await this.api('sendMessage', { chat_id: CONFIG.chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  }

  /** Отправляет ответ на команду; длинный текст режется на несколько сообщений, кнопки — у последнего */
  async reply(chatId: string, r: Reply, replyTo?: number): Promise<void> {
    const msg = typeof r === 'string' ? { text: r } : r;
    const chunks = splitMessage(msg.text);
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text: chunks[i],
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      };
      if (replyTo && i === 0) body.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
      if (last && msg.ask) body.reply_markup = { force_reply: true, input_field_placeholder: 'Напишіть фільтри…' };
      else if (last && msg.buttons) body.reply_markup = this.inlineKeyboard(msg.buttons);
      const sent = await this.api<{ message_id: number }>('sendMessage', body);
      if (last && msg.ask) this.setPending(chatId, sent.message_id, { kind: msg.ask, ts: Date.now() });
    }
  }

  private setPending(chatId: string, promptId: number, p: Pending) {
    this.store.setKv(`pending:${chatId}:${promptId}`, JSON.stringify(p));
  }

  private async refreshCard(row: MessageRow) {
    try {
      await this.api('editMessageText', {
        chat_id: row.chat_id,
        message_id: row.message_id,
        text: row.body + renderStatusLines(row),
        parse_mode: 'HTML',
        link_preview_options: this.preview(row.preview_url),
        reply_markup: this.cardKeyboard(row.open_url),
      });
    } catch (e) {
      if (!String(e).includes('not modified')) log('Не удалось обновить сообщение', String(e));
    }
  }

  /** Спрашивает дату просмотра; ответ (reply) придёт в onViewingAnswer */
  private async askViewingTime(row: MessageRow, again: boolean) {
    const text = [
      '📅 <b>Коли перегляд?</b> Дайте відповідь на це повідомлення, наприклад:',
      '«завтра о 18:00», «пт 12:30», «14.11 18:00», «15 листопада о 10».',
      again ? 'Щоб зняти запис на перегляд — «скасувати».' : 'Якщо дата ще невідома — «-».',
    ].join('\n');
    const sent = await this.api<{ message_id: number }>('sendMessage', {
      chat_id: row.chat_id,
      text,
      parse_mode: 'HTML',
      reply_parameters: { message_id: row.message_id, allow_sending_without_reply: true },
      reply_markup: { force_reply: true, input_field_placeholder: 'завтра о 18:00' },
    });
    this.setPending(row.chat_id, sent.message_id, { kind: 'viewing', messageId: row.message_id, ts: Date.now() });
  }

  private async onViewingAnswer(chatId: string, messageId: number, text: string, who: string, replyTo: number) {
    const row = this.store.getMessage(chatId, messageId);
    if (!row) return;
    if (CANCEL.test(text.trim())) {
      Object.assign(row, { deal_status: null, deal_by: null, viewing_at: null, viewing_note: null });
      this.store.updateMessage(chatId, messageId, { deal_status: null, deal_by: null, viewing_at: null, viewing_note: null });
      await this.refreshCard(row);
      await this.reply(chatId, '↩️ Запис на перегляд знято.', replyTo);
      return;
    }
    const t = parseViewingTime(text);
    const patch = { deal_status: 'viewing' as const, deal_by: row.deal_by ?? who, viewing_at: t.at ?? null, viewing_note: t.label ?? null };
    Object.assign(row, patch);
    this.store.updateMessage(chatId, messageId, patch);
    await this.refreshCard(row);
    const msg = t.at
      ? `📅 Записав: перегляд <b>${t.label}</b>. Усі перегляди — /viewings`
      : t.label
        ? `📅 Записав як є: «${t.label}» (не зміг розпізнати дату — у списку буде в кінці). Усі перегляди — /viewings`
        : '📅 Записав перегляд без дати. Коли дізнаєтесь — натисніть «📅 Записались на перегляд» ще раз.';
    await this.reply(chatId, msg, replyTo);
  }

  private async onCardCallback(q: any, who: string): Promise<string> {
    const chatId = String(q.message?.chat?.id ?? '');
    const messageId = q.message?.message_id;
    const row = this.store.getMessage(chatId, messageId);
    if (!row) return 'Це повідомлення вже не відстежується';
    let answer = '';
    let askViewing = false;
    let viewingAgain = false;

    switch (q.data) {
      case 'call': {
        if (row.claimed_by && row.claimed_by !== who) return `Вже дзвонить ${row.claimed_by}`;
        row.claimed_by = row.claimed_by === who ? null : who;
        this.store.updateMessage(chatId, messageId, { claimed_by: row.claimed_by });
        answer = row.claimed_by ? 'Позначив: дзвониш ти' : 'Зняв позначку';
        break;
      }
      case 'skip': {
        row.skipped_by = row.skipped_by ? null : who;
        this.store.updateMessage(chatId, messageId, { skipped_by: row.skipped_by });
        answer = row.skipped_by ? 'Позначив як таку, що не підходить' : 'Повернув у роботу';
        break;
      }
      case 'like': {
        const names = likedNames(row);
        const next = names.includes(who) ? names.filter((n) => n !== who) : [...names, who];
        row.liked_by = next.length ? JSON.stringify(next) : null;
        this.store.updateMessage(chatId, messageId, { liked_by: row.liked_by });
        answer = next.includes(who) ? '❤️ Додав у «Сподобались»' : 'Прибрав з «Сподобались»';
        break;
      }
      case 'refused': {
        const off = row.deal_status === 'refused';
        Object.assign(row, { deal_status: off ? null : 'refused', deal_by: off ? null : who, viewing_at: null, viewing_note: null });
        this.store.updateMessage(chatId, messageId, {
          deal_status: row.deal_status, deal_by: row.deal_by, viewing_at: null, viewing_note: null,
        });
        answer = off ? 'Зняв «Відмовили»' : 'Позначив: відмовили';
        break;
      }
      case 'viewing': {
        // Повторное нажатие — поменять дату (или снять запись ответом «скасувати»)
        askViewing = true;
        viewingAgain = row.deal_status === 'viewing';
        if (!viewingAgain) {
          Object.assign(row, { deal_status: 'viewing', deal_by: who, viewing_at: null, viewing_note: null });
          this.store.updateMessage(chatId, messageId, { deal_status: 'viewing', deal_by: who, viewing_at: null, viewing_note: null });
          answer = 'Записав. Тепер напишіть, коли перегляд';
        } else answer = 'Напишіть нову дату перегляду';
        break;
      }
      default:
        return '';
    }
    await this.refreshCard(row);
    if (askViewing) await this.askViewingTime(row, viewingAgain);
    return answer;
  }

  private async onCallback(q: any, h: CommandHandler) {
    const chatId = String(q.message?.chat?.id ?? '');
    const who = personName(q.from);
    const data: string = q.data ?? '';
    if (data.startsWith('m:')) {
      // Кнопки меню — то же, что команды
      await this.api('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
      const r = await h(data.slice(2), '', chatId, who);
      if (r) await this.reply(chatId, r);
      return;
    }
    const answer = await this.onCardCallback(q, who);
    await this.api('answerCallbackQuery', {
      callback_query_id: q.id,
      text: answer,
      show_alert: answer.startsWith('Вже дзвонить'),
    }).catch(() => {});
  }

  private async onMessage(m: any, h: CommandHandler) {
    const chatId = String(m.chat.id);
    const text: string = m.text ?? '';
    const who = personName(m.from);

    const cmd = text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
    if (cmd) {
      const name = cmd[1].toLowerCase();
      // /chatid отвечает в любом чате — это нужно при первой настройке
      if (name !== 'chatid' && chatId !== String(CONFIG.chatId)) return;
      const r = await h(name, (cmd[2] ?? '').trim(), chatId, who);
      if (r) await this.reply(chatId, r, m.message_id);
      return;
    }

    // Ответ на вопрос бота («коли перегляд?», «напишіть фільтри»)
    const to = m.reply_to_message?.message_id;
    if (!to || chatId !== String(CONFIG.chatId) || !text.trim()) return;
    const key = `pending:${chatId}:${to}`;
    const raw = this.store.getKv(key);
    if (!raw) return;
    const p = JSON.parse(raw) as Pending;
    this.store.delKv(key);
    if (p.kind === 'viewing') await this.onViewingAnswer(chatId, p.messageId, text, who, m.message_id);
    else if (p.kind === 'filters') {
      if (CANCEL.test(text.trim())) return void (await this.reply(chatId, 'Гаразд, фільтри не змінюю.', m.message_id));
      const r = await h('filters', text, chatId, who);
      if (r) await this.reply(chatId, r, m.message_id);
    }
  }

  /** Long polling: кнопки и команды. Работает параллельно с опросом сайтов. */
  async listen(h: CommandHandler) {
    if (CONFIG.dryRun || !CONFIG.botToken) return;
    await this.api('setMyCommands', {
      commands: [
        { command: 'menu', description: 'Меню радара' },
        { command: 'filters', description: 'Фільтри пошуку: показати / змінити' },
        { command: 'liked', description: 'Квартири, що сподобались' },
        { command: 'viewings', description: 'Записи на перегляд' },
        { command: 'status', description: 'Стан радара і статистика' },
        { command: 'pause', description: 'Поставити сповіщення на паузу' },
        { command: 'resume', description: 'Знову надсилати квартири' },
        { command: 'chatid', description: 'Показати id цього чату' },
      ],
    }).catch(() => {});

    while (!this.stopped) {
      try {
        const updates = await this.api<any[]>('getUpdates', {
          offset: this.offset,
          timeout: 50,
          allowed_updates: ['message', 'callback_query'],
        });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          try {
            if (u.callback_query) {
              const fromChat = String(u.callback_query.message?.chat?.id ?? '');
              if (fromChat === String(CONFIG.chatId)) await this.onCallback(u.callback_query, h);
            } else if (u.message?.text) {
              await this.onMessage(u.message, h);
            }
          } catch (e) {
            log('Ошибка обработки апдейта', String(e));
          }
        }
      } catch (e) {
        log('getUpdates:', String(e));
        await sleep(5000);
      }
    }
  }

  stop() {
    this.stopped = true;
  }
}
