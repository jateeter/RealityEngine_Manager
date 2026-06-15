// Jest config for the Perception Engine backend.
//
// This package is ESM ("type": "module") and TypeScript NodeNext, and the test
// files use ESM-style relative imports with a ".js" suffix
// (e.g. import { Dispatcher } from '../triggers/Dispatcher.js'). That requires
// ts-jest's ESM preset plus the moduleNameMapper below to strip the ".js" so
// Jest resolves the ".ts" source. Run via the "test" script, which sets
// --experimental-vm-modules (required for Jest's ESM support).

/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    // Map "./foo.js" -> "./foo" so NodeNext-style ESM imports resolve to .ts
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        // Tests are excluded from the build tsconfig; use a test-scoped one.
        tsconfig: 'tsconfig.test.json',
      },
    ],
  },
  clearMocks: true,
};
