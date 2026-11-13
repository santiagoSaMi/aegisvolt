import { defineConfig } from 'vitest/config';

/**
 * E2E contra Floci: levanta los cuatro servicios como procesos reales. Un solo
 * archivo y en serie (los escenarios comparten el stack y sus tablas temporales).
 */
export default defineConfig({
  test: {
    include: ['test/**/*.e2e.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
