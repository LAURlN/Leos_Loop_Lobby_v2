import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['shared/src/**/*.test.ts', 'app/src/**/*.test.ts', 'relay/src/**/*.test.ts'],
    environment: 'node',
  },
});
