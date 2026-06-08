
import { createClient } from '@supabase/supabase-js';

// Exported so other modules (geminiService, edge-function callers) can build
// their own URLs without duplicating the fallback values. Override via
// VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env.local if pointing at a
// different project.
export const SUPABASE_URL = (import.meta as any).env?.VITE_SUPABASE_URL || 'https://sblmbkgoiefqzykjksgm.supabase.co';
export const SUPABASE_ANON_KEY = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNibG1ia2dvaWVmcXp5a2prc2dtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE2Nzg2ODIsImV4cCI6MjA3NzI1NDY4Mn0.wK5E6TVZCavAqLrbZeyfgdToGyETRnQAbm5PPaAVlFw';

// Detect Tauri desktop environment where Navigator LockManager is unreliable.
// Supabase JS v2 uses LockManager to serialize refresh-token access across
// browser tabs. In Tauri's single-window WebView, the lock frequently stalls
// for 10s and then throws. We work around this by providing a simple in-memory
// mutex. We CANNOT use a no-op lock, because concurrent refresh attempts will
// trigger Supabase's token reuse detection and revoke the user's session.
const isTauri = typeof (window as any).__TAURI_INTERNALS__ !== 'undefined';

class InMemoryMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise(resolve => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

const authMutex = new InMemoryMutex();

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // Provide a real in-memory mutex for Tauri to serialize token refreshes
    ...(isTauri ? {
      lock: async (name: string, acquireTimeout: number, fn: () => Promise<any>) => {
        await authMutex.acquire();
        try {
          return await fn();
        } finally {
          authMutex.release();
        }
      }
    } : {}),
  },
});
