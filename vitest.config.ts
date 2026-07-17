/**
 * Vitest config — runs the same module-resolution as the Vite build so tests
 * can import from @core / @modules / @app aliases just like the app does.
 *
 * Single test scope today: src/core/sync/__tests__. Adding more test
 * directories later only requires extending `include`.
 */
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: [
      { find: '@core/services/storageService',        replacement: path.resolve(__dirname, './services/storageService') },
      { find: '@core/services/geminiService',         replacement: path.resolve(__dirname, './services/geminiService') },
      { find: '@core/services/supplierService',       replacement: path.resolve(__dirname, './services/supplierService') },
      { find: '@core/services/companyDefaultsService', replacement: path.resolve(__dirname, './services/companyDefaultsService') },
      { find: '@core',    replacement: path.resolve(__dirname, './src/core') },
      { find: '@modules', replacement: path.resolve(__dirname, './src/modules') },
      { find: '@app',     replacement: path.resolve(__dirname, './src/app') },
    ],
  },
  test: {
    environment: 'node',
    include: [
      'src/core/sync/__tests__/**/*.test.ts',
      'services/__tests__/**/*.test.ts',
      'src/core/utils/__tests__/**/*.test.ts'
    ],
    globals: false,
  },
});
