import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['fake-indexeddb/auto'],
    exclude: ['e2e/**', 'node_modules/**', '.output/**'],
  },
});
