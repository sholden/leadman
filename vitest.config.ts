import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The DB module is a singleton created at import time, and several modules
    // hold process-wide state (credential status, provider clients). A separate
    // process per file keeps tests from leaking into each other.
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
    setupFiles: ['tests/setup.ts'],
    testTimeout: 20_000,
    reporters: process.env.CI ? ['default', 'github-actions'] : ['default'],
    coverage: {
      provider: 'v8',
      include: ['src/server/**/*.ts'],
      // Entry point binds a port; provider internals need a live API to be meaningful.
      exclude: ['src/server/index.ts', 'src/server/ai/providers/**'],
      reporter: ['text-summary', 'lcov'],
    },
  },
});
