import { defineConfig } from 'vitest/config';

/**
 * Pruebas de integración contra DynamoDB real (Floci). Cada archivo crea y
 * borra su propia tabla temporal; se ejecutan en serie para no saturar el emulador.
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.int.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
