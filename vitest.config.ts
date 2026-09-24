import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'src/**/*.test.ts', 'integrations/**/*.test.ts', 'scripts/**/*.test.ts'],
    setupFiles: ['./server/testing/setup.ts'],
    // A file per fork keeps each test's DATA_DIR and store singleton isolated.
    pool: 'forks',
    isolate: true,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
