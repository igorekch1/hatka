import type { FeatureKey } from './types.ts';

/* ──────────────────────────────────────────────────────────────────────────
 * ФИЛЬТРЫ. Это значения по умолчанию — в боте их меняют через /filters
 * (сохраняются в базе и переживают перезапуск). Кнопка «Стандартні» в боте
 * возвращает к тому, что записано здесь.
 * ────────────────────────────────────────────────────────────────────────── */
export type Filters = {
  /** Потолок аренды в долларах (гривневые цены пересчитываются по курсу НБУ) */
  maxPriceUsd: number;
  /** Ниже — подозрительно дёшево (развод/посуточно) */
  minPriceUsd: number;
  /** Подходящие административные районы Львова (по-украински) */
  districts: string[];
  /** Если район не указан и не определился — всё равно присылать (с пометкой) */
  allowUnknownDistrict: boolean;
  minRooms: number | null;
  maxRooms: number | null;
  minArea: number | null;
  /** Есть собака среднего размера: отсекать «без тварин» / «собак не можна» */
  dogFriendly: boolean;
  /** Отсекать «только маленькие собаки до 10 кг» */
  rejectSmallDogsOnly: boolean;
  /** Отсекать объявления «только для одного человека» */
  rejectOnlyOnePerson: boolean;
  /** ЖК мечты — бонус к оценке и пометка ⭐ (в нижнем регистре, без «ЖК») */
  dreamComplexes: string[];
  /** «Хотелки» и их вес в оценке (0..3). Неизвестное = 0: не штрафуем, но и не награждаем */
  wishes: Partial<Record<FeatureKey, number>>;
  /** Минимальная оценка 0..10, ниже которой не присылать. 0 — присылать всё, что прошло фильтры */
  minScore: number;
  /** Прочие пожелания свободным текстом — их проверяет ИИ */
  extra: string;
};

export const DEFAULT_FILTERS: Filters = {
  maxPriceUsd: 1000,
  minPriceUsd: 150,
  districts: ['Франківський', 'Шевченківський', 'Галицький'],
  allowUnknownDistrict: true,
  minRooms: null,
  maxRooms: null,
  minArea: null,
  dogFriendly: true,
  rejectSmallDogsOnly: true,
  rejectOnlyOnePerson: true,
  dreamComplexes: ['америка'],
  wishes: {
    undergroundParking: 2,
    dishwasher: 1.5,
    acInBedroom: 1.5,
    gasStove: 1,
    shower: 1,
    twoDesks: 1,
    bright: 0.5,
  },
  minScore: 0,
  extra: '',
};

/** Текущие фильтры. Объект один и тот же на всё приложение — меняется на месте (applyFilters) */
export const FILTERS: Filters = structuredClone(DEFAULT_FILTERS);

/** «Не всё белое» — отдельный бонус, если ИИ уверен, что интерьер НЕ полностью белый */
export const NOT_ALL_WHITE_WEIGHT = 0.5;
export const DREAM_COMPLEX_BONUS = 1.5;

export const ALL_DISTRICTS = ['Франківський', 'Шевченківський', 'Галицький', 'Залізничний', 'Личаківський', 'Сихівський'];

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  dishwasher: 'посудомийна машина',
  airConditioner: 'кондиціонер',
  acInBedroom: 'кондиціонер у спальні',
  gasStove: 'газова плита',
  shower: 'душ',
  undergroundParking: 'підземний паркінг',
  parking: 'паркінг',
  bright: 'світла',
  twoDesks: 'місце під 2 робочі столи',
  allWhiteInterior: 'все біле',
};

/**
 * Микрорайоны → административный район. Нужно для DIM.RIA и Telegram, где часто пишут
 * «Підзамче» или «Левандівка» вместо района. Список неполный — то, чего тут нет,
 * определяет ИИ по улице. Ключи — в нижнем регистре.
 */
export const MICRODISTRICT_TO_DISTRICT: Record<string, string> = {
  // Галицький
  'центр': 'Галицький', 'старе місто': 'Галицький', 'середмістя': 'Галицький',
  'площа ринок': 'Галицький', 'цитадель': 'Галицький', 'високий замок': 'Галицький',
  // Франківський
  'новий світ': 'Франківський', 'наукова': 'Франківський', 'кульпарків': 'Франківський',
  'аракса': 'Франківський', 'сахарова': 'Франківський', 'софіївка': 'Франківський',
  'боднарівка': 'Франківський', 'кастелівка': 'Франківський',
  // Шевченківський
  'замарстинів': 'Шевченківський', 'голоско': 'Шевченківський', 'збоїща': 'Шевченківський',
  'підзамче': 'Шевченківський', 'рясне': 'Шевченківський', 'клепарів': 'Шевченківський',
  // Залізничний
  'левандівка': 'Залізничний', 'привокзальна': 'Залізничний', 'сигнівка': 'Залізничний',
  'білогорща': 'Залізничний', 'скнилівок': 'Залізничний',
  // Сихівський
  'сихів': 'Сихівський', 'козельники': 'Сихівський',
  // Личаківський
  'личаків': 'Личаківський', 'кривчиці': 'Личаківський', 'погулянка': 'Личаківський',
  'пасічна': 'Личаківський', 'лисиничі': 'Личаківський',
};

/* ──────────────────────────────────────────────────────────────────────────
 * Настройки из окружения
 * ────────────────────────────────────────────────────────────────────────── */
const env = process.env;
const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);
const list = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export const CONFIG = {
  botToken: env.TELEGRAM_BOT_TOKEN ?? '',
  chatId: env.TELEGRAM_CHAT_ID ?? '',

  anthropicKey: env.ANTHROPIC_API_KEY ?? '',
  anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-haiku-5-5',

  tgApiId: num(env.TG_API_ID, 0),
  tgApiHash: env.TG_API_HASH ?? '',
  tgSession: env.TG_SESSION ?? '',
  tgChannels: list(env.TG_CHANNELS),

  sources: list(env.SOURCES ?? 'olx,lun,domria,telegram'),
  pollSeconds: num(env.POLL_SECONDS, 60),
  /** Объявления старше этого не присылаем (защита от «поднятых» и от потока при первом запуске) */
  maxAgeHours: num(env.MAX_AGE_HOURS, 3),
  dbPath: env.DB_PATH ?? './data/radar.db',
  fxFallback: num(env.FX_FALLBACK_UAH_PER_USD, 46),
  dryRun: env.DRY_RUN === '1',
  userAgent:
    env.USER_AGENT ??
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};
