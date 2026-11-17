import { afterEach } from 'vitest'

// The picture tests are synchronous CPU work behind mocked fetches, so a whole file can run on
// microtasks alone. On a slow CI runner that is over a minute without the worker answering
// vitest ("Timeout calling onTaskUpdate" with every test green). Give the event loop a turn
// after each test.
afterEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
