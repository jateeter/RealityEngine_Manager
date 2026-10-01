// Vitest config for the Perception Engine backend.
//
// Vitest transpiles TypeScript itself (no dependency on the typescript
// package), so it runs the NodeNext '.js'-suffixed relative imports against
// the .ts sources directly, with no ESM flags or moduleNameMapper. Type
// checking is separate: 'npm run typecheck' covers tsconfig.test.json too.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    clearMocks: true,
  },
});
