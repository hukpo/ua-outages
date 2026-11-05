import type { Provider } from './provider.js'
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
  ]
}
