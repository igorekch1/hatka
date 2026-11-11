import { FEATURE_LABELS } from './config.ts';
import type { MessageRow } from './db.ts';
import { isDreamComplex } from './filter.ts';
import { toUah } from './fx.ts';
import type { AiVerdict, FeatureKey, Listing, PetsPolicy } from './types.ts';
import { ago, escapeHtml as e, formatPhone, siteName } from './util.ts';

const PETS_TEXT: Record<PetsPolicy, string> = {
  dogs_ok: '🐕 Собака: можна ✅',
  small_dogs_only: '🐕 Собака: лише маленькі ❌',
  no_dogs: '🐕 Собака: не можна ❌',
  no: '🐕 Без тварин ❌',
  some: '🐕 Тварини: «з деякими» / обговорюється — уточнити ⚠️',
  unknown: '🐕 Про тварин не сказано — уточнити ⚠️',
};

const SOURCE_NAME: Record<string, string> = { olx: 'OLX', lun: 'Lun', domria: 'DIM.RIA', telegram: 'Telegram' };

/** Что важно уточнить при звонке, если в объявлении не сказано */
const ASK_IF_UNKNOWN: FeatureKey[] = ['undergroundParking', 'dishwasher', 'acInBedroom', 'shower'];

const SHOWN: FeatureKey[] = [
  'undergroundParking', 'parking', 'dishwasher', 'acInBedroom', 'airConditioner', 'gasStove', 'shower', 'twoDesks', 'bright',
];

/** «OLX · знайдено через Lun» — первоисточник первым; для Telegram — название канала */
export function sourceLine(l: Listing): string {
  if (l.source === 'telegram') return `Telegram${l.origin ? ` (${l.origin})` : ''}`;
  const site = siteName(l.url) ?? l.origin ?? SOURCE_NAME[l.source];
  return site === SOURCE_NAME[l.source] ? site : `${site} · знайдено через ${SOURCE_NAME[l.source]}`;
}

export function renderListing(l: Listing, s: number, ai?: AiVerdict): string {
  const lines: string[] = [];
  const dream = isDreamComplex(l);

  const head: string[] = [];
  if (l.rooms) head.push(`${l.rooms}к`);
  if (l.area) head.push(`${l.area} м²`);
  if (l.priceUsd !== undefined) head.push(`$${l.priceUsd}`);
  else if (l.price !== undefined) head.push(`${l.price} ${l.currency ?? ''}`.trim());
  const uah = l.currency === 'UAH' && l.price ? `${l.price.toLocaleString('uk-UA')} грн` : l.priceUsd ? `≈${toUah(l.priceUsd).toLocaleString('uk-UA')} грн` : '';
  lines.push(`${dream ? '⭐️' : '🏠'} <b>${e(head.join(' · ') || 'Квартира')}</b>${uah ? ` (${e(uah)})` : ''}`);

  const place = [l.district ?? 'район ?', l.complex, l.microdistrict, l.address].filter(Boolean) as string[];
  const floor = l.floor ? ` · ${l.floor}${l.floors ? '/' + l.floors : ''} пов.` : '';
  lines.push(`📍 ${e([...new Set(place)].join(' · '))}${e(floor)}`);
  lines.push(PETS_TEXT[l.pets]);

  const yes: string[] = [];
  const no: string[] = [];
  const unknown: string[] = [];
  for (const k of SHOWN) {
    if (k === 'parking' && l.features.undergroundParking) continue;
    if (k === 'airConditioner' && l.features.acInBedroom) continue;
    const v = l.features[k];
    if (v === true) yes.push(FEATURE_LABELS[k]);
    else if (v === false) no.push(FEATURE_LABELS[k]);
    else if (ASK_IF_UNKNOWN.includes(k)) unknown.push(FEATURE_LABELS[k]);
  }
  if (l.features.allWhiteInterior === true) no.push('інтер\'єр весь білий');
  if (yes.length) lines.push(`✅ ${e(yes.join(', '))}`);
  if (no.length) lines.push(`❌ ${e(no.join(', '))}`);
  if (unknown.length) lines.push(`❔ не вказано: ${e(unknown.join(', '))}`);
  if (ai?.redFlags.length) lines.push(`🚩 ${e(ai.redFlags.join('; '))}`);

  const meta = [`⭐ ${s}/10`, l.publishedAt ? `🕐 ${ago(l.publishedAt)}` : '', sourceLine(l)]
    .filter(Boolean)
    .join(' · ');
  lines.push(e(meta));

  const who = [l.isOwner === true ? '👤 власник' : l.isOwner === false ? '🏢 рієлтор' : '', l.noCommission ? 'без комісії' : '']
    .filter(Boolean)
    .join(' · ');
  if (who) lines.push(e(who));
  if (l.phones.length) lines.push(`📞 ${l.phones.slice(0, 2).map((p) => e(formatPhone(p))).join(', ')}`);
  else if (l.source === 'olx') lines.push('📞 телефон — в оголошенні на OLX');
  if (ai?.summary) lines.push(`💬 <i>${e(ai.summary)}</i>`);
  if (!ai && l.text) lines.push(`💬 <i>${e(l.text.replace(/\s+/g, ' ').slice(0, 220))}…</i>`);
  return lines.join('\n');
}

export function likedNames(row: Pick<MessageRow, 'liked_by'>): string[] {
  try {
    const v = JSON.parse(row.liked_by ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

type CardState = Pick<MessageRow, 'claimed_by' | 'skipped_by' | 'liked_by' | 'deal_status' | 'deal_by' | 'viewing_note'>;

/** Строки статуса под карточкой: кто лайкнул, кто звонит, просмотр/отказ */
export function renderStatusLines(row: CardState): string {
  const out: string[] = [];
  const liked = likedNames(row);
  if (liked.length) out.push(`\n❤️ <b>Подобається: ${e(liked.join(', '))}</b>`);
  if (row.claimed_by) out.push(`\n📞 <b>Дзвонить: ${e(row.claimed_by)}</b>`);
  if (row.deal_status === 'viewing')
    out.push(`\n📅 <b>Перегляд: ${e(row.viewing_note ?? 'дата ще невідома')}</b>${row.deal_by ? ` (${e(row.deal_by)})` : ''}`);
  if (row.deal_status === 'refused') out.push(`\n🚫 <b>Відмовили</b>${row.deal_by ? ` (${e(row.deal_by)})` : ''}`);
  if (row.skipped_by) out.push(`\n🙅 <b>Не підходить</b> (${e(row.skipped_by)})`);
  return out.join('');
}

/* ─── Списки для меню ──────────────────────────────────────────────────── */

/** Ссылка на сообщение в супергруппе (-100…). В обычной группе ссылок на сообщения нет. */
export function messageLink(chatId: string, messageId: number): string | undefined {
  return chatId.startsWith('-100') ? `https://t.me/c/${chatId.slice(4)}/${messageId}` : undefined;
}

/** Две первые строки карточки без тегов (они уже экранированы — годятся для HTML) */
export function cardTitle(body: string): string {
  return body.split('\n').slice(0, 2).map((s) => s.replace(/<[^>]+>/g, '').trim()).join(' — ');
}

function links(row: MessageRow): string {
  const card = messageLink(row.chat_id, row.message_id);
  return [card && `<a href="${e(card)}">картка</a>`, row.open_url && `<a href="${e(row.open_url)}">оголошення</a>`]
    .filter(Boolean)
    .join(' · ');
}

export function renderLikedList(rows: MessageRow[]): string {
  if (!rows.length) return '❤️ Поки що нічого не сподобалось. Тисніть «❤️ Подобається» на картці квартири.';
  const order = (r: MessageRow) => (r.deal_status === 'refused' || r.skipped_by ? 1 : 0);
  const sorted = [...rows].sort((a, b) => order(a) - order(b));
  const items = sorted.map((r, i) => {
    const marks = [
      `❤️ ${e(likedNames(r).join(', '))}`,
      r.claimed_by && `📞 ${e(r.claimed_by)}`,
      r.deal_status === 'viewing' && `📅 ${e(r.viewing_note ?? 'перегляд, дата невідома')}`,
      r.deal_status === 'refused' && '🚫 відмовили',
      r.skipped_by && '🙅 не підходить',
    ].filter(Boolean);
    return `${i + 1}. ${cardTitle(r.body)}\n    ${marks.join(' · ')}\n    ${links(r)}`;
  });
  return `❤️ <b>Сподобались (${rows.length})</b>\n\n${items.join('\n\n')}`;
}

export function renderViewings(rows: MessageRow[], now = Date.now()): string {
  if (!rows.length) return '📅 Записів на перегляд поки немає. На картці квартири тисніть «📅 Записались на перегляд».';
  const fmt = (r: MessageRow) =>
    `📅 <b>${e(r.viewing_note ?? 'дата невідома')}</b> — ${cardTitle(r.body)}\n    ${[r.deal_by && `записав(ла): ${e(r.deal_by)}`, links(r)].filter(Boolean).join(' · ')}`;
  // Начавшиеся меньше 3 часов назад ещё считаем актуальными, остальные прошедшие — в конец
  const upcoming = rows.filter((r) => !r.viewing_at || r.viewing_at > now - 3 * 3600_000);
  const past = rows.filter((r) => r.viewing_at && r.viewing_at <= now - 3 * 3600_000).reverse().slice(0, 10);
  const parts = [`📅 <b>Перегляди (${upcoming.length})</b>`, '', upcoming.map(fmt).join('\n\n') || 'Майбутніх немає.'];
  if (past.length) parts.push('', '<b>Минулі</b>', past.map(fmt).join('\n\n'));
  return parts.join('\n');
}
