import { defineConfig } from 'vitest/config';

// Tests cover pure logic only (no Worker runtime mocks needed) — Node 22
// provides WebCrypto (crypto.subtle), TextEncoder and crypto.randomUUID.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
