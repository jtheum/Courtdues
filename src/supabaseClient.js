import { createClient } from "@supabase/supabase-js";

// These come from your Supabase project (Settings -> API) and are set as
// environment variables at build time. The anon key is safe to ship in a
// frontend — it only allows what your Row Level Security policies permit.
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Fail loud in dev so a missing .env doesn't turn into a silent blank board.
  console.error(
    "Missing Supabase config. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your .env file."
  );
}

export const supabase = createClient(url, anonKey);
