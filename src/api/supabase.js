// @ts-check

import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

let client = null;

export function getSupabase() {
  if (config.mode === 'demo') return null;
  if (!client) {
    client = createClient(config.supabase.url, config.supabase.anonKey, {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }
  return client;
}
