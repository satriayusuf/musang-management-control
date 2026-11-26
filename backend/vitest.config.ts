import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Integration tests share one test database; run files serially.
    fileParallelism: false,
    pool: 'forks',
  },
});
