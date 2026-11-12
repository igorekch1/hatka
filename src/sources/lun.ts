import { CONFIG } from '../config.ts';
import { parseCurrency } from '../fx.ts';
import type { Features, Listing, PetsPolicy, Source } from '../types.ts';
import { canonicalUrlKey, formatPhone, getJson, normalizeDistrict, num } from '../util.ts';

/**
 * Lun.ua — сам агрегатор (rieltor.ua, OLX, DIM.RIA и др.). Важно: отдаёт телефоны,
 * поле про животных, технику и даже «укриття в підземному паркінгу».
 * geoId — город (из профиля CITY), sectionId 2 = довгострокова оренда квартир.
 */
const URL = () =>
  `https://lun.ua/api/v2/market/realties?sectionId=2&geoId=${CONFIG.city.lunGeoId}&language=uk&sort=insert_time&page=1`;
const PAGE = () => `https://lun.ua/rent/${CONFIG.city.lunSlug}/flats`;

const LUN_PETS: Record<string, PetsPolicy> = { yes: 'dogs_ok', no: 'no', some: 'some', unknown: 'unknown' };

export function mapLunCard(c: any): Listing {
  const geo: any[] = c.geoEntities ?? [];
  const byType = (t: string) => geo.find((g) => g.type === t)?.name as string | undefined;
  const furniture: string[] = (c.furniture ?? []).map((f: any) => f.icon);

  const features: Features = {};
  if (furniture.includes('dishwasher')) features.dishwasher = true;
  if (furniture.includes('air-conditioning')) features.airConditioner = true;
  if (furniture.includes('shower')) features.shower = true;
  if (c.houseData?.kitchenStoveName === 'gas') features.gasStove = true;
  else if (c.houseData?.kitchenStoveName === 'electric') features.gasStove = false;
  if ((c.shelter ?? []).includes('underground_parking')) features.undergroundParking = true;
  if (c.houseData?.parkingCount) features.parking = true;

  const photos: string[] = (c.images ?? [])
    .slice(0, 5)
    .map((im: any) => `https://market-images.lunstatic.net/lun-ua/1200/900/images/${im.imageId}.jpg`);

  const phones: string[] = (c.phones ?? c.rieltorContact?.phones ?? []).map(formatPhone);
  const externalId = String(c.id);
  const keys = [`lun:${externalId}`];
  if (c.groupId) keys.push(`lun-group:${c.groupId}`);
  const urlKey = canonicalUrlKey(c.urlRaw);
  if (urlKey) keys.push(urlKey);

  const street = byType('street');
  const house = byType('house');
  const complex = byType('residential_complex');

  return {
    id: `lun:${externalId}`,
    source: 'lun',
    externalId,
    url: c.urlRaw ?? PAGE(),
    origin: c.site?.displayName,
    title: c.header,
    text: String(c.text ?? ''),
    price: num(c.price),
    currency: parseCurrency(c.currency),
    rooms: num(c.roomCount),
    area: num(c.areaTotal),
    floor: num(c.floor),
    floors: num(c.floorCount),
    district: normalizeDistrict(byType('district')),
    microdistrict: byType('microdistrict'),
    address: street ? `${street}${house ? ', ' + house : ''}` : undefined,
    complex: complex && /^ЖК/i.test(complex) ? complex : undefined,
    lat: Array.isArray(c.location) ? c.location[1] : undefined,
    lon: Array.isArray(c.location) ? c.location[0] : undefined,
    photos,
    phones,
    pets: LUN_PETS[c.petsAllowedFull] ?? 'unknown',
    features,
    // Lun отдаёт UTC без «Z»
    publishedAt: c.insertTime ? new Date(`${c.insertTime}Z`) : undefined,
    isOwner: c.isOwner ?? undefined,
    noCommission: c.withoutCommission ?? undefined,
    previewUrl: photos[0],
    dedupKeys: keys,
  };
}

export const lunSource: Source = {
  name: 'lun',
  async poll() {
    const res = await getJson<{ cards: any[] }>(URL(), { referer: PAGE() });
    return (res.cards ?? []).map(mapLunCard);
  },
};
