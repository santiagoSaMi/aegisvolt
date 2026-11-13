import { defineConfig } from 'vitest/config';

/** Pruebas unitarias y de presentación (sin dependencias externas). */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**'],
  },
});
