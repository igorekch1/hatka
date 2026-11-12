import { aiEnabled } from './ai.ts';
import { Bot, type Reply } from './bot.ts';
import { CONFIG, FILTERS, FILTERS_STATE, TOP_SCORE } from './config.ts';
import { Store } from './db.ts';
import { applyFilters, clearFilters, describeFilters, filtersSnapshot, loadFilters, parseFilters, restoreSnapshot, sameFilters } from './filters.ts';
import { refreshFx } from './fx.ts';
import { answerHelp } from './help.ts';
import { ADD_HELP, addManual } from './manual.ts';
import { Pipeline } from './pipeline.ts';
import { renderLikedList, renderTopList, renderViewings } from './render.ts';
import { domriaSource } from './sources/domria.ts';
import { lunSource } from './sources/lun.ts';
import { olxSource } from './sources/olx.ts';
import { startTelegramSource } from './sources/telegram.ts';
import type { Source } from './types.ts';
import { HttpError, escapeHtml, log, sleep } from './util.ts';

const once = process.argv.includes('--once');

if (!CONFIG.dryRun && !CONFIG.botToken) {
  console.error('Нужен TELEGRAM_BOT_TOKEN в .env (или запустите `npm run dry`, чтобы просто посмотреть, что находится).');
  process.exit(1);
}

const store = new Store(CONFIG.dbPath);
loadFilters(store);
const bot = new Bot(store);

// Режим настройки: токен есть, id группы ещё нет — отвечаем только на /chatid
if (!CONFIG.dryRun && !CONFIG.chatId) {
  log('TELEGRAM_CHAT_ID не задан. Добавьте бота в группу и напишите там /chatid — бот ответит id. Затем впишите его в .env и перезапустите.');
  await bot.listen(async (cmd, _args, chatId) => (cmd === 'chatid' ? `id цього чату: <code>${chatId}</code>` : undefined));
}
const pipeline = new Pipeline(store, bot);
const startedAt = Date.now();

const ALL: Source[] = [olxSource, lunSource, domriaSource];
const polling = ALL.filter((s) => CONFIG.sources.includes(s.name)).filter((s) => {
  if (s.name === 'olx' && !CONFIG.city.olx) {
    log(`OLX выключен: для города ${CONFIG.city.name} не заданы OLX_REGION_ID / OLX_CITY_ID`);
    return false;
  }
  return true;
});

type Health = { lastOk?: number; errors: number; lastError?: string; warned: boolean; found: number };
const health = new Map<string, Health>();
for (const s of [...polling.map((p) => p.name), 'telegram']) health.set(s, { errors: 0, warned: false, found: 0 });

async function pollOnce(src: Source) {
  const h = health.get(src.name)!;
  try {
    const items = await src.poll((k) => store.isSeen(k));
    h.lastOk = Date.now();
    h.found += items.length;
    if (h.warned) {
      h.warned = false;
      await bot.sendText(`✅ ${src.name} знову працює`).catch(() => {});
    }
    h.errors = 0;
    // старые — первыми, чтобы в чате был правильный порядок
    for (const l of items.reverse()) await pipeline.enqueue(l);
  } catch (e) {
    h.errors++;
    h.lastError = String(e);
    log(`${src.name}: ошибка #${h.errors}`, h.lastError);
    if (h.errors >= 5 && !h.warned) {
      h.warned = true;
      const hint =
        e instanceof HttpError && (e.status === 403 || e.status === 429)
          ? 'Схоже, сайт блокує запити з сервера. Варіант: запустити радар на домашньому комп\'ютері або через проксі.'
          : 'Можливо, сайт змінив формат — треба поправити парсер.';
      await bot.sendText(`⚠️ <b>${src.name}</b> не відповідає вже ${h.errors} разів поспіль.\n<code>${escapeHtml(h.lastError.slice(0, 200))}</code>\n${hint}`).catch(() => {});
    }
  }
}

async function loop(src: Source) {
  // DIM.RIA делает по запросу на каждое новое объявление — опрашиваем чуть реже
  const base = CONFIG.pollSeconds * 1000 * (src.name === 'domria' ? 1.5 : 1);
  while (true) {
    await pollOnce(src);
    await sleep(base * (0.8 + Math.random() * 0.4));
  }
}

function menu(): Reply {
  const paused = store.getKv('paused') === '1';
  return {
    text: FILTERS_STATE.configured
      ? '🏠 <b>Радар квартир — меню</b>'
      : '🏠 <b>Радар квартир — меню</b>\n⚠️ Фільтри не задані — нічого не надсилаю. Натисніть «✏️ Змінити фільтри».',
    buttons: [
      [{ text: '⚙️ Фільтри', data: 'm:filters' }, { text: '✏️ Змінити фільтри', data: 'm:filters_edit' }],
      [{ text: '🔥 Топ', data: 'm:top' }, { text: '❤️ Сподобались', data: 'm:liked' }],
      [{ text: '📅 Перегляди', data: 'm:viewings' }],
      [{ text: '➕ Додати свою квартиру', data: 'm:add' }],
      [{ text: '📊 Стан', data: 'm:status' }, paused ? { text: '▶️ Продовжити', data: 'm:resume' } : { text: '⏸ Пауза', data: 'm:pause' }],
      [{ text: '❓ Допомога', data: 'm:help' }],
    ],
  };
}

/** Районы для примеров в подсказках — из профиля города */
const EX_DISTRICT = CONFIG.city.districts[0].name;
const EX_DISTRICTS = `${CONFIG.city.districts[0].name} або ${CONFIG.city.districts[1].name}`;

const FILTER_BUTTONS = [
  [{ text: '✏️ Змінити', data: 'm:filters_edit' }, { text: '🗑 Очистити', data: 'm:filters_clear' }],
  [{ text: '🏠 Меню', data: 'm:menu' }],
];

/** Первый запуск / фильтры очищены: просим прислать фильтры ответом — после ответа поиск стартует сам */
const ONBOARDING = [
  '👋 <b>Фільтри ще не задані — поки нічого не надсилаю.</b>',
  '',
  'Напишіть, що шукаєте, <b>у відповідь на це повідомлення</b> (reply) — списком або текстом. Наприклад:',
  `<i>до 900$, ${EX_DISTRICTS}, 2 кімнати від 50 м², з собакою, бажано посудомийка і паркінг</i>`,
  '',
  'Щойно збережу фільтри — одразу почну пошук. Нічого додатково писати не треба.',
  `Те саме можна одним повідомленням: <code>/filters до 900$, ${EX_DISTRICT}…</code>`,
].join('\n');

const FILTERS_HELP = [
  '✏️ <b>Напишіть нові фільтри у відповідь на це повідомлення</b> — списком або звичайним текстом, наприклад:',
  '',
  `<i>до 900$, ${EX_DISTRICTS}, 2 кімнати від 50 м², обов'язково посудомийка і паркінг, не перший поверх</i>`,
  '',
  `або щось одне: <i>«підніми бюджет до 1100»</i>, <i>«додай ${CONFIG.city.districts[CONFIG.city.districts.length - 1].name}»</i>, <i>«прибери вимогу про поверх»</i>.`,
  aiEnabled() ? '' : '⚠️ ШІ вимкнено (немає ANTHROPIC_API_KEY) — зрозумію лише ціну, райони, кімнати, площу й мін. оцінку.',
  'Передумали — «скасувати».',
].filter((l, i, a) => l || a[i - 1]).join('\n');

async function updateFilters(text: string): Promise<Reply> {
  const first = !FILTERS_STATE.configured;
  const prev = structuredClone(FILTERS);
  const res = await parseFilters(text, prev);
  if (sameFilters(res.filters, prev))
    return {
      text: first
        ? `🤔 Не зрозумів жодного критерію — фільтри досі не задані. Спробуйте інакше, напр. «до 900$, ${EX_DISTRICT}, 2 кімнати».`
        : '🤔 Не зрозумів, що змінити — фільтри лишились ті самі. Спробуйте сформулювати інакше.',
      ...(first ? { ask: 'filters' as const } : { buttons: [[{ text: '✏️ Ще раз', data: 'm:filters_edit' }]] }),
    };
  store.setKv('filters_prev', filtersSnapshot());
  applyFilters(store, res.filters);
  const changes = res.changes.length ? res.changes.map((c) => `• ${escapeHtml(c)}`).join('\n') + '\n\n' : '';
  const title = first ? '✅ <b>Фільтри збережено — починаю пошук!</b>' : '✅ <b>Фільтри оновлено</b>';
  return {
    text: `${title}${res.via === 'basic' ? ' (простий розбір, без ШІ)' : ''}\n${changes}${describeFilters()}\n\n<i>Діють для нових оголошень.</i>`,
    buttons: [[{ text: '↩️ Скасувати зміни', data: 'm:filters_undo' }, { text: '✏️ Змінити ще', data: 'm:filters_edit' }]],
  };
}

async function onCommand(cmd: string, args: string, chatId: string, who: string): Promise<Reply | undefined> {
  switch (cmd) {
    case 'chatid':
      return `id цього чату: <code>${chatId}</code>`;
    case 'help':
      return answerHelp(args);
    case 'start':
    case 'menu':
      return menu();
    case 'filters':
    case 'filter':
      if (args) return updateFilters(args);
      if (!FILTERS_STATE.configured) return { text: ONBOARDING, ask: 'filters' };
      return { text: describeFilters(), buttons: FILTER_BUTTONS };
    case 'filters_edit':
      return { text: FILTERS_STATE.configured ? FILTERS_HELP : ONBOARDING, ask: 'filters' };
    case 'filters_clear':
      if (!FILTERS_STATE.configured) return { text: ONBOARDING, ask: 'filters' };
      store.setKv('filters_prev', filtersSnapshot());
      clearFilters(store);
      return {
        text: '🗑 Фільтри очищено — <b>нічого не надсилаю</b>, доки не задасте нові.',
        buttons: [[{ text: '↩️ Скасувати', data: 'm:filters_undo' }, { text: '✏️ Задати фільтри', data: 'm:filters_edit' }]],
      };
    case 'filters_undo': {
      const prev = store.getKv('filters_prev');
      if (!prev) return 'Немає попередньої версії фільтрів.';
      const cur = filtersSnapshot();
      restoreSnapshot(store, prev);
      store.setKv('filters_prev', cur);
      return { text: `↩️ Повернув попередні фільтри.\n\n${describeFilters()}`, buttons: FILTER_BUTTONS };
    }
    case 'add':
      if (!args) return { text: ADD_HELP, ask: 'add' };
      return addManual(store, bot, args, chatId, who);
    case 'top':
      return renderTopList(store.listTop(chatId, TOP_SCORE));
    case 'liked':
      return renderLikedList(store.listLiked(chatId));
    case 'viewings':
      return renderViewings(store.listViewings(chatId));
    case 'pause':
      store.setKv('paused', '1');
      return '⏸ Пауза. Нові квартири не надсилаю (але запам\'ятовую, щоб потім не засипати старими). /resume — продовжити.';
    case 'resume':
      store.setKv('paused', '0');
      return '▶️ Знову стежу за квартирами.';
    case 'status':
    case 'stats': {
      const day = store.stats(Date.now() - 86400_000);
      const reasons = store.topRejectReasons(Date.now() - 86400_000);
      const src = [...health.entries()]
        .filter(([n]) => CONFIG.sources.includes(n))
        .map(([n, h]) => {
          const ok = h.lastOk ? `ок ${Math.round((Date.now() - h.lastOk) / 60000)} хв тому` : n === 'telegram' ? 'слухає події' : 'ще не було';
          return `• ${n}: ${h.errors ? `❌ помилок поспіль: ${h.errors}` : ok}`;
        })
        .join('\n');
      return [
        `${store.getKv('paused') === '1' ? '⏸ На паузі' : '🟢 Працюю'} · аптайм ${Math.round((Date.now() - startedAt) / 3600_000)} год`,
        `ШІ-розбір: ${aiEnabled() ? 'увімк.' : 'вимк.'} · ${FILTERS_STATE.configured ? 'фільтри задані (/filters)' : '⚠️ фільтри не задані — нічого не надсилаю'}`,
        '',
        src,
        '',
        `За добу: надіслав ${day.notified ?? 0}, відсіяв ${day.rejected ?? 0}, дублів ${day.duplicate ?? 0}`,
        reasons.length ? `Найчастіше відсіював: ${reasons.map((r) => `${escapeHtml(r.reason)} (${r.n})`).join(', ')}` : '',
      ].join('\n');
    }
  }
  return undefined;
}

async function main() {
  await refreshFx();
  setInterval(() => refreshFx(), 3600_000).unref();
  setInterval(() => store.prune(), 86400_000).unref();

  if (once) {
    log(`Пробный прогон: ${polling.map((s) => s.name).join(', ')}`);
    for (const s of polling) {
      await pollOnce(s);
      const h = health.get(s.name)!;
      log(`${s.name}: получено ${h.found}${h.lastError ? `, ошибка: ${h.lastError}` : ''}`);
    }
    process.exit(0);
  }

  log(`Старт. Источники: ${CONFIG.sources.join(', ')}; опрос каждые ~${CONFIG.pollSeconds} с; ИИ: ${aiEnabled() ? CONFIG.anthropicModel : 'выкл'}`);
  void bot.listen(onCommand);

  let stopTelegram = async () => {};
  let tgLine = '';
  if (CONFIG.sources.includes('telegram')) {
    const tg = await startTelegramSource((l) => pipeline.enqueue(l)).catch((e) => {
      log('Telegram-каналы не запустились:', String(e));
      return { stop: async () => {}, listening: [], missing: [], skipped: `помилка: ${String(e).slice(0, 200)}` };
    });
    stopTelegram = tg.stop;
    tgLine = tg.skipped
      ? `\n⚠️ Telegram-канали не підключені — ${escapeHtml(tg.skipped)}`
      : [
          tg.listening.length ? `\n📣 Telegram-канали (${tg.listening.length}): ${tg.listening.map((t) => `«${escapeHtml(t)}»`).join(', ')}` : '',
          tg.missing.length ? `\n⚠️ Не знайшов канали: ${escapeHtml(tg.missing.join(', '))} — перевірте @username і що ви в них підписані` : '',
        ].join('');
  }
  const sites = polling.map((s) => s.name);

  await bot
    .sendText(`🟢 Радар квартир запущено · ${escapeHtml(CONFIG.city.name)}.\n🌐 Сайти: ${sites.join(', ') || '—'}${tgLine}\nМеню — /menu`)
    .catch((e) => log('Не смог написать в чат — проверьте TELEGRAM_CHAT_ID и что бот добавлен в группу:', String(e)));
  if (!FILTERS_STATE.configured)
    await bot.reply(String(CONFIG.chatId), { text: ONBOARDING, ask: 'filters' }).catch((e) => log('Не смог отправить приглашение задать фильтры', String(e)));

  // Разносим старт источников, чтобы не стрелять запросами одновременно
  polling.forEach((s, i) => setTimeout(() => void loop(s), i * 7000));

  const shutdown = async () => {
    log('Останавливаюсь…');
    bot.stop();
    await stopTelegram().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
