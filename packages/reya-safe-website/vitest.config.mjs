import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': new URL('../website/src', import.meta.url).pathname,
      '@cannon': new URL('../website/src', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
  },
});
