/**
 * Профили городов: всё, что в боте зависит от города. Город выбирается переменной CITY в .env.
 *
 * Чтобы добавить город:
 *  - lunGeoId — из адреса страницы lun.ua/rent/<город>/flats (в HTML: ?geo_id=…&section_id=2);
 *  - domria — state_id/city_id из поиска dom.ria.com (для областных центров обычно совпадают);
 *  - olx — region_id/city_id из API OLX (можно задать и через OLX_REGION_ID / OLX_CITY_ID);
 *  - districts — административные районы и основы их написаний (укр./рус., старые названия).
 * Номера Lun и DIM.RIA для городов ниже проверены 13.11.2026: API отдаёт объявления именно этого города.
 */

export type District = {
  /** Каноническое название (как в фильтрах и карточке) */
  name: string;
  /** Основы написаний: «Франковский р-н», «Франківський район», старые названия */
  match: RegExp;
};

export type CityProfile = {
  key: string;
  /** «Львів» */
  name: string;
  /** «у Львові» — для текстов и промптов */
  nameIn: string;
  /** Часть адреса lun.ua/rent/<slug>/flats */
  lunSlug: string;
  lunGeoId: number;
  domria: { stateId: number; cityId: number };
  /** Номера OLX; если неизвестны — OLX для города выключен (или задайте OLX_REGION_ID / OLX_CITY_ID) */
  olx?: { regionId: number; cityId: number };
  districts: District[];
  /** Какой район называют «центр» */
  centerDistrict?: string;
  /** Микрорайон → район (ключи в нижнем регистре). Чего нет — определяет ИИ по улице */
  microdistricts?: Record<string, string>;
};

const LVIV: CityProfile = {
  key: 'lviv',
  name: 'Львів',
  nameIn: 'у Львові',
  lunSlug: 'lviv',
  lunGeoId: 10012684,
  domria: { stateId: 5, cityId: 5 },
  olx: { regionId: 5, cityId: 176 },
  districts: [
    { name: 'Франківський', match: /франк[іоиo]в/i },
    { name: 'Шевченківський', match: /шевченк[іоиo]в/i },
    { name: 'Галицький', match: /гал[иі]ц/i },
    { name: 'Залізничний', match: /зал[іе]зни[чн]|железнодор/i },
    { name: 'Личаківський', match: /лича?к[іоиo]в|лычак/i },
    { name: 'Сихівський', match: /сих[іоиo]в/i },
  ],
  centerDistrict: 'Галицький',
  microdistricts: {
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
  },
};

const KYIV: CityProfile = {
  key: 'kyiv',
  name: 'Київ',
  nameIn: 'у Києві',
  lunSlug: 'kyiv',
  lunGeoId: 10009580,
  domria: { stateId: 10, cityId: 10 },
  districts: [
    { name: 'Голосіївський', match: /гол[ое]с[іе][іїе]в/i },
    { name: 'Дарницький', match: /дарниц/i },
    { name: 'Деснянський', match: /деснян/i },
    { name: 'Дніпровський', match: /дн[іе]пров/i },
    { name: 'Оболонський', match: /оболон/i },
    { name: 'Печерський', match: /печер/i },
    { name: 'Подільський', match: /под[іо]льськ|подольск/i },
    { name: 'Святошинський', match: /святошин/i },
    { name: 'Солом’янський', match: /солом/i },
    { name: 'Шевченківський', match: /шевченк[іоиo]в/i },
  ],
  centerDistrict: 'Шевченківський',
};

const ODESA: CityProfile = {
  key: 'odesa',
  name: 'Одеса',
  nameIn: 'в Одесі',
  lunSlug: 'odesa',
  lunGeoId: 10016589,
  domria: { stateId: 12, cityId: 12 },
  districts: [
    { name: 'Київський', match: /ки[їе]вськ|киевск/i },
    // Пересипський — бывший Суворовський, Хаджибейський — бывший Малиновський
    { name: 'Пересипський', match: /пересип|суворов/i },
    { name: 'Приморський', match: /примор/i },
    { name: 'Хаджибейський', match: /хаджибе|малинов/i },
  ],
  centerDistrict: 'Приморський',
};

const KHARKIV: CityProfile = {
  key: 'kharkiv',
  name: 'Харків',
  nameIn: 'у Харкові',
  lunSlug: 'kharkiv',
  lunGeoId: 10024345,
  domria: { stateId: 7, cityId: 7 },
  districts: [
    // В скобках — старые названия, которые ещё встречаются в объявлениях
    { name: 'Індустріальний', match: /[іи]ндустр|орджон/i },
    { name: 'Київський', match: /ки[їе]вськ|киевск/i },
    { name: 'Немишлянський', match: /немишл|немышл|фрунзен/i },
    { name: 'Новобаварський', match: /новобавар|жовтнев|октябрьск/i },
    { name: 'Основ’янський', match: /основ.?янськ|основянск|червонозавод|краснозавод/i },
    { name: 'Салтівський', match: /салт[іо]вськ|салтовск|московськ|московск/i },
    { name: 'Слобідський', match: /слоб[іо]дськ|слободск|комінтерн|коминтерн/i },
    { name: 'Холодногірський', match: /холодног|ленінськ|ленинск/i },
    { name: 'Шевченківський', match: /шевченк[іоиo]в|дзержинськ|дзержинск/i },
  ],
  centerDistrict: 'Шевченківський',
};

const DNIPRO: CityProfile = {
  key: 'dnipro',
  name: 'Дніпро',
  nameIn: 'у Дніпрі',
  lunSlug: 'dnipro',
  lunGeoId: 10006463,
  domria: { stateId: 11, cityId: 11 },
  districts: [
    { name: 'Амур-Нижньодніпровський', match: /амур/i },
    { name: 'Індустріальний', match: /[іи]ндустр/i },
    { name: 'Новокодацький', match: /новокодац/i },
    { name: 'Самарський', match: /самарськ|самарск/i },
    { name: 'Соборний', match: /собор/i },
    { name: 'Центральний', match: /центральн/i },
    { name: 'Чечелівський', match: /чечел/i },
    { name: 'Шевченківський', match: /шевченк[іоиo]в/i },
  ],
  centerDistrict: 'Центральний',
};

export const CITIES: Record<string, CityProfile> = { lviv: LVIV, kyiv: KYIV, odesa: ODESA, kharkiv: KHARKIV, dnipro: DNIPRO };

/** Город из CITY (по умолчанию Львов); номера OLX можно переопределить через OLX_REGION_ID / OLX_CITY_ID */
export function resolveCity(env: Record<string, string | undefined> = process.env): CityProfile {
  const key = (env.CITY ?? 'lviv').trim().toLowerCase();
  const city = CITIES[key];
  if (!city) throw new Error(`Невідоме місто CITY=${key}. Доступні: ${Object.keys(CITIES).join(', ')}`);
  const regionId = Number(env.OLX_REGION_ID);
  const cityId = Number(env.OLX_CITY_ID);
  return regionId && cityId ? { ...city, olx: { regionId, cityId } } : city;
}

export const CITY: CityProfile = resolveCity();
