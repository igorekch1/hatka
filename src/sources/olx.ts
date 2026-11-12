import { CONFIG } from '../config.ts';
import type { Currency, Features, Listing, PetsPolicy, Source } from '../types.ts';
import { canonicalUrlKey, getJson, normalizeDistrict, num, stripHtml } from '../util.ts';

/**
 * OLX: тот же JSON, которым пользуется сайт.
 * category 1760 = «Довгострокова оренда квартир», region_id / city_id — из профиля города (CITY).
 * Берём весь город (а не только выбранные районы), чтобы не терять объявления без района.
 */
const URL = (o: { regionId: number; cityId: number }) =>
  `https://www.olx.ua/api/v1/offers/?offset=0&limit=40&category_id=1760&region_id=${o.regionId}&city_id=${o.cityId}&sort_by=created_at:desc`;

type Param = { key: string; value: any };

export function olxPets(keys: string[] | undefined): PetsPolicy {
  if (!keys || keys.length === 0) return 'unknown';
  if (keys.includes('yes_medium_dog') || keys.includes('yes_big_dog')) return 'dogs_ok';
  if (keys.includes('yes_small_dog')) return 'small_dogs_only';
  if (keys.includes('no')) return 'no';
  if (keys.includes('yes_cat') || keys.includes('yes_other')) return 'no_dogs';
  return 'unknown';
}

export function mapOlxAd(ad: any): Listing {
  const p = (key: string): any => (ad.params as Param[] | undefined)?.find((x) => x.key === key)?.value;
  const price = p('price');
  const appliances: string[] = p('appliances_2')?.key ?? [];
  const comfort: string[] = p('comfort')?.key ?? [];
  const comms: string[] = p('communications')?.key ?? [];

  const features: Features = {};
  if (appliances.includes('dishwasher')) features.dishwasher = true;
  if (comfort.includes('air_conditioning')) features.airConditioner = true;
  if (comfort.includes('shower')) features.shower = true;
  if (comfort.includes('parking_place') || comfort.includes('garage') || comfort.includes('ground_parking'))
    features.parking = true;
  // «Газ» в коммуникациях + плита в технике — почти всегда газовая плита. Наверняка скажет ИИ по тексту.
  if (comms.includes('gas') && (appliances.includes('stove') || appliances.includes('hob'))) features.gasStove = true;

  const photo = ad.photos?.[0];
  const photos: string[] = (ad.photos ?? [])
    .slice(0, 5)
    .map((ph: any) => String(ph.link).replace('{width}', String(ph.width ?? 1000)).replace('{height}', String(ph.height ?? 750)));

  const externalId = String(ad.id);
  const url: string = ad.url;
  const keys = [`olx:${externalId}`];
  const urlKey = canonicalUrlKey(url);
  if (urlKey) keys.push(urlKey);

  return {
    id: `olx:${externalId}`,
    source: 'olx',
    externalId,
    url,
    origin: 'OLX',
    title: ad.title,
    text: stripHtml(`${ad.title ?? ''}\n${ad.description ?? ''}`),
    price: num(price?.value),
    currency: (price?.currency as Currency) ?? undefined,
    rooms: num(p('number_of_rooms_string')?.label?.match(/\d+/)?.[0]),
    area: num(p('total_area')?.key),
    floor: num(p('floor')?.key),
    floors: num(p('total_floors')?.key),
    district: normalizeDistrict(ad.location?.district?.name),
    lat: ad.map?.lat,
    lon: ad.map?.lon,
    photos,
    phones: [],
    pets: olxPets(p('pets')?.key),
    features,
    publishedAt: ad.created_time ? new Date(ad.created_time) : undefined,
    isOwner: ad.business === false ? true : ad.business === true ? false : undefined,
    noCommission: p('commission')?.key === '1' ? true : undefined,
    previewUrl: photo ? photos[0] : undefined,
    dedupKeys: keys,
  };
}

export const olxSource: Source = {
  name: 'olx',
  async poll() {
    const ids = CONFIG.city.olx;
    if (!ids) throw new Error(`OLX: для міста ${CONFIG.city.name} не задані OLX_REGION_ID / OLX_CITY_ID`);
    const res = await getJson<{ data: any[] }>(URL(ids), { referer: 'https://www.olx.ua/' });
    return (res.data ?? []).map(mapOlxAd);
  },
};
