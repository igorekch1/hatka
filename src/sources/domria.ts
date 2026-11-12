import { CONFIG } from '../config.ts';
import { parseCurrency } from '../fx.ts';
import type { Listing, Source } from '../types.ts';
import { districtFromMicro, getJson, num, sleep } from '../util.ts';

/**
 * DIM.RIA: поиск отдаёт только id, детали — отдельным запросом.
 * state_id / city_id — город (из профиля CITY), operation=3 = довгострокова оренда, realty_type=2 = квартира.
 * Детали тянем только по новым id, поэтому нагрузка — пара запросов в минуту.
 */
const SEARCH = () =>
  `https://dom.ria.com/node/searchEngine/v2/?category=1&realty_type=2&operation=3&state_id=${CONFIG.city.domria.stateId}&city_id=${CONFIG.city.domria.cityId}&sort=created_at&limit=20&page=0&lang_id=4`;
export const DETAILS = (id: string | number) => `https://dom.ria.com/realty/data/${id}?lang_id=4`;

export function mapDomRia(d: any): Listing {
  const externalId = String(d.realty_id ?? d.id);
  const photos: string[] = Object.values<any>(d.photos ?? {})
    .sort((a, b) => (a.ordering ?? 99) - (b.ordering ?? 99))
    .slice(0, 5)
    .map((ph) => `https://cdn.riastatic.com/photos/${String(ph.file).replace(/\.jpg$/, 'fl.jpg')}`);

  // priceArr: 1 — USD, 2 — EUR, 3 — UAH (строки с пробелами)
  const usdFromSite = num(d.priceArr?.['1']);
  const micro: string | undefined = d.district_name_uk;
  const street = [d.street_name_uk, d.building_number_str].filter(Boolean).join(', ');
  const url = `https://dom.ria.com/uk/${d.beautiful_url}`;

  return {
    id: `domria:${externalId}`,
    source: 'domria',
    externalId,
    url,
    origin: 'DIM.RIA',
    text: String(d.description_uk || d.description || ''),
    price: num(d.price),
    currency: parseCurrency(d.currency_type_uk) ?? (d.currency_type_id === 1 ? 'USD' : d.currency_type_id === 3 ? 'UAH' : undefined),
    priceUsd: usdFromSite,
    rooms: num(d.rooms_count),
    area: num(d.total_square_meters),
    floor: num(d.floor),
    floors: num(d.floors_count),
    district: districtFromMicro(micro),
    microdistrict: micro,
    address: street || undefined,
    lat: num(d.latitude),
    lon: num(d.longitude),
    photos,
    phones: [],
    pets: 'unknown',
    features: {},
    publishedAt: d.publishing_date_ts ? new Date(d.publishing_date_ts * 1000) : undefined,
    previewUrl: photos[0],
    dedupKeys: [`domria:${externalId}`],
  };
}

export const domriaSource: Source = {
  name: 'domria',
  async poll(isSeen) {
    const res = await getJson<{ items: number[] }>(SEARCH(), { referer: 'https://dom.ria.com/uk/' });
    const fresh = (res.items ?? []).filter((id) => !isSeen(`domria:${id}`));
    const out: Listing[] = [];
    for (const id of fresh) {
      try {
        out.push(mapDomRia(await getJson(DETAILS(id))));
      } catch {
        // одно сломанное объявление не должно ронять весь опрос
      }
      await sleep(400);
    }
    return out;
  },
};
