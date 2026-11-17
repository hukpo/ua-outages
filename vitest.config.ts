import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // the poster tests decode several pictures each: over the 5 s default on a slow runner (Node 20 in CI)
    testTimeout: 30_000,
    // live tests hit real grid-operator servers; run them with `npm run test:live`
    exclude: process.env.LIVE ? [] : ['test/live/**'],
  },
})
