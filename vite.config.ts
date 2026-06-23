import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// TAURI_DEV_HOST is set by the Tauri CLI during `tauri dev`
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // Services that live at the root — bypass the bridge files so Vite
      // resolves them directly (the bridge `export *` doesn't forward indented exports)
      { find: '@core/services/storageService',        replacement: path.resolve(__dirname, './services/storageService') },
      { find: '@core/services/geminiService',         replacement: path.resolve(__dirname, './services/geminiService') },
      { find: '@core/services/supplierService',       replacement: path.resolve(__dirname, './services/supplierService') },
      { find: '@core/services/companyDefaultsService',replacement: path.resolve(__dirname, './services/companyDefaultsService') },
      // Generic prefix aliases (must come after the specific overrides above)
      { find: '@core',    replacement: path.resolve(__dirname, './src/core') },
      { find: '@modules', replacement: path.resolve(__dirname, './src/modules') },
      { find: '@app',     replacement: path.resolve(__dirname, './src/app') },
    ],
  },
  // Tauri requires these settings so the WebView can communicate with the dev server
  clearScreen: false,
  server: {
    port: 5173,
    host: host || true,
    strictPort: true,
    hmr: host
      ? { protocol: 'ws', host, port: 5183 }
      : undefined,
    watch: {
      // Don't watch the Rust side — Tauri CLI handles that separately
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // Use a target compatible with the WebView on both Windows (WebView2) and macOS (WKWebView)
    target:
      process.env.TAURI_ENV_PLATFORM === 'windows'
        ? 'chrome105'
        : process.env.TAURI_ENV_PLATFORM === 'macos'
          ? 'safari13'
          : ['es2021', 'chrome100', 'safari13'],
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
