import './src/core/utils/networkOverride';
import React from 'react';
import ReactDOM from 'react-dom/client';
// NOTE: Currently using the legacy App.tsx (props-drilling model) as the entry point.
// The new slim src/app/App.tsx + Router + Zustand stores will replace this once
// Phase 6 (per-module state migration) is complete.
import App from './App';
import AppErrorBoundary from '@core/components/layout/AppErrorBoundary';

// Polyfill process.env for any legacy code that references it
if (typeof (window as Window & { process?: { env: Record<string, unknown> } }).process === 'undefined') {
  (window as Window & { process?: { env: Record<string, unknown> } }).process = { env: {} };
}

// Surface uncaught errors that would otherwise produce a silent blank screen
window.addEventListener('error', (e) => {
  console.error('[window.error]', e.error || e.message, e);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[window.unhandledrejection]', e.reason);
});

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element #root not found');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
