// supabase.js
// Shared database connection for the Netlify functions.
// Uses the keys in .env (or Netlify's environment variables on the live site).
// Returns null if a key is missing, so a page can still load without the database extras.

import { createClient } from "@supabase/supabase-js";

export function getSupabase() {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.log("Database extras skipped: SUPABASE_URL or SUPABASE_SECRET_KEY is missing");
    return null;
  }
  return createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
}
