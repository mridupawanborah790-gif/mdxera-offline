
import { createClient } from '@supabase/supabase-js';

// Exported so other modules (geminiService, edge-function callers) can build
// their own URLs without duplicating the fallback values. Override via
// VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env.local if pointing at a
// different project.
export const SUPABASE_URL = (import.meta as any).env?.VITE_SUPABASE_URL || 'https://sblmbkgoiefqzykjksgm.supabase.co';
export const SUPABASE_ANON_KEY = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNibG1ia2dvaWVmcXp5a2prc2dtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE2Nzg2ODIsImV4cCI6MjA3NzI1NDY4Mn0.wK5E6TVZCavAqLrbZeyfgdToGyETRnQAbm5PPaAVlFw';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  },
});
