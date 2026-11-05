import { dtekProvider } from './dtek.js'
import { mykolaivProvider } from './mykolaiv.js'
import { poltavaProvider } from './poltava.js'
import { kharkivProvider } from './kharkiv.js'
import type { Provider } from './provider.js'
import { zaporizhzhiaProvider } from './zaporizhzhia.js'
import { yasnoProvider } from './yasno.js'

/** Built-in providers for every supported region. */
export function createProviders(): Provider[] {
  return [
    yasnoProvider({
      info: {
        id: 'kyiv',
        name: 'Київ',
        operator: 'ДТЕК Київські електромережі (через YASNO)',
        website: 'https://yasno.ua/planovi-vidkliuchennia',
      },
      regionId: 25,
      dsoId: 902,
      hasCities: false,
      sampleAddress: { street: 'вул. Хрещатик', house: '6' },
    }),
    yasnoProvider({
      info: {
        id: 'dnipro',
        name: 'Дніпропетровська область',
        operator: 'ДТЕК Дніпровські електромережі (через YASNO)',
        website: 'https://yasno.ua/planovi-vidkliuchennia',
      },
      regionId: 3,
      dsoId: 301,
      hasCities: true,
      sampleAddress: { city: 'Дніпро', street: 'просп. Дмитра Яворницького', house: '41' },
    }),
    yasnoProvider({
      info: {
        id: 'dnipro-cek',
        name: 'Дніпропетровська область (ЦЕК)',
        operator: 'Центральна енергетична компанія (через YASNO)',
        website: 'https://yasno.ua/planovi-vidkliuchennia',
      },
      regionId: 3,
      dsoId: 303,
      hasCities: true,
    }),
    dtekProvider({
      info: {
        id: 'odesa',
        name: 'Одеська область',
        operator: 'ДТЕК Одеські електромережі',
        website: 'https://www.dtek-oem.com.ua/ua/shutdowns',
      },
      code: 'oem',
      sampleAddress: { city: 'Одеса', street: 'вул. Варненська', house: '1' },
    }),
    dtekProvider({
      info: {
        id: 'kyiv-region',
        name: 'Київська область',
        operator: 'ДТЕК Київські регіональні електромережі',
        website: 'https://www.dtek-krem.com.ua/ua/shutdowns',
      },
      code: 'krem',
    }),
    dtekProvider({
      info: {
        id: 'donetsk',
        name: 'Донецька область',
        operator: 'ДТЕК Донецькі електромережі',
        website: 'https://www.dtek-dem.com.ua/ua/shutdowns',
      },
      code: 'dem',
    }),
    mykolaivProvider(),
    poltavaProvider(),
    kharkivProvider(),
    zaporizhzhiaProvider(),
  ]
}
