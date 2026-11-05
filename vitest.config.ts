import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // live tests hit real grid-operator servers; run them with `npm run test:live`
    exclude: process.env.LIVE ? [] : ['test/live/**'],
  },
})
