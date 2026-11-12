/** manual — квартиру добавили руками через /add */
export type SourceName = 'olx' | 'lun' | 'domria' | 'telegram' | 'manual';

/**
 * Политика по животным, сведённая к тому, что важно для собаки среднего размера:
 * dogs_ok          — можно средних/больших собак
 * small_dogs_only  — только маленьких (до 10 кг) — для средней собаки не подходит
 * no_dogs          — котик можно, собак нет
 * no               — без животных
 * some             — «можна з деякими тваринами» — непонятно, решает ИИ/звонок
 * unknown          — не указано
 */
export type PetsPolicy = 'dogs_ok' | 'small_dogs_only' | 'no_dogs' | 'no' | 'some' | 'unknown';

export type FeatureKey =
  | 'dishwasher'
  | 'airConditioner'
  | 'acInBedroom'
  | 'gasStove'
  | 'shower'
  | 'undergroundParking'
  | 'parking'
  | 'bright'
  | 'twoDesks'
  | 'allWhiteInterior';

/** true — есть, false — точно нет, отсутствует ключ — неизвестно */
export type Features = Partial<Record<FeatureKey, boolean>>;

export type Currency = 'USD' | 'UAH' | 'EUR';

export interface Listing {
  /** Уникальный id внутри системы: `${source}:${externalId}` */
  id: string;
  source: SourceName;
  externalId: string;
  url: string;
  /** Откуда объявление на самом деле (для Lun: rieltor.ua / olx.ua / dom.ria.com, для Telegram — канал) */
  origin?: string;
  title?: string;
  text: string;
  price?: number;
  currency?: Currency;
  priceUsd?: number;
  rooms?: number;
  area?: number;
  floor?: number;
  floors?: number;
  /** Административный район Львова: Франківський, Шевченківський, ... */
  district?: string;
  microdistrict?: string;
  address?: string;
  complex?: string;
  lat?: number;
  lon?: number;
  photos: string[];
  phones: string[];
  pets: PetsPolicy;
  features: Features;
  publishedAt?: Date;
  isOwner?: boolean;
  noCommission?: boolean;
  /** Ссылка, которую Telegram покажет как превью (фото) над сообщением */
  previewUrl?: string;
  /** Ключи для склейки одной квартиры с разных площадок */
  dedupKeys: string[];
}

export interface AiVerdict {
  isRentalOffer: boolean;
  price: number | null;
  currency: Currency | null;
  district: string | null;
  complex: string | null;
  rooms: number | null;
  area: number | null;
  phones: string[];
  pets: PetsPolicy;
  onlyOnePerson: boolean;
  features: Features;
  redFlags: string[];
  summary: string;
  /** Подходит ли под «додаткові вимоги» из фильтров; null — нечего проверять / непонятно */
  extraOk: boolean | null;
  extraReason: string;
}

export interface Source {
  name: SourceName;
  /** Возвращает свежие объявления; isSeen позволяет не тянуть детали по уже обработанным */
  poll(isSeen: (key: string) => boolean): Promise<Listing[]>;
}
