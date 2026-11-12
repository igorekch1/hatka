import { FILTERS, FILTERS_STATE, type Filters } from '../src/config.ts';

/** Пример заданных фильтров — на нём построены тесты (в самом боте фильтры задаются через /filters) */
export const SAMPLE_FILTERS: Filters = {
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
  wishes: { undergroundParking: 2, dishwasher: 1.5, acInBedroom: 1.5, gasStove: 1, shower: 1, twoDesks: 1, bright: 0.5 },
  minScore: 0,
  extra: '',
};

/** Ставит тестовые фильтры как «заданные» */
export function useSampleFilters() {
  Object.assign(FILTERS, structuredClone(SAMPLE_FILTERS));
  FILTERS_STATE.configured = true;
}
