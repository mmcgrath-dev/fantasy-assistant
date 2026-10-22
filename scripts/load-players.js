// load-players.js
// Downloads the nflverse players file and loads every player who played in
// 2025 or later, at every position, into the Supabase players table.
// Linemen and defenders are included so the app can track injuries and
// playing time on both sides of the ball, not just fantasy players.
//
// Run from the project folder:
//   node --env-file=.env scripts/load-players.js

import Papa from "papaparse";
import { createClient } from "@supabase/supabase-js";

const PLAYERS_URL =
  "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv";

const MIN_SEASON = 2025;

// Make sure the keys from .env actually loaded before doing anything
const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY. Check your .env file.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

async function main() {
  // 1. Download the CSV from nflverse
  console.log("Downloading players file from nflverse...");
  const response = await fetch(PLAYERS_URL);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  const csvText = await response.text();

  // 2. Turn the CSV text into a list of objects, one per player
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  console.log(`Found ${parsed.data.length} players total`);

  // 3. Keep everyone who's played recently, and shape each row
  //    to match the columns in our players table
  const rows = parsed.data
    .filter((p) => Number(p.last_season) >= MIN_SEASON)
    .map((p) => ({
      gsis_id: p.gsis_id,
      espn_id: p.espn_id || null,
      pfr_id: p.pfr_id || null,
      full_name: p.display_name,
      position: p.position,
      team: p.latest_team || null,
      updated_at: new Date().toISOString(),
    }));
  console.log(`Keeping ${rows.length} current players`);

  // 4. Send them to Supabase in chunks of 500.
  //    "upsert" means: add the player if they're new, update them if they're
  //    already there. So running this again next week won't create duplicates.
  const CHUNK_SIZE = 500;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const { error } = await supabase
      .from("players")
      .upsert(chunk, { onConflict: "gsis_id" });

    if (error) {
      throw new Error(`Supabase error: ${error.message}`);
    }
    console.log(`Saved ${Math.min(i + CHUNK_SIZE, rows.length)} of ${rows.length}`);
  }

  console.log("Done!");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
