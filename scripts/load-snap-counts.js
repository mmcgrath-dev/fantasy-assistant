// load-snap-counts.js
// Downloads this season's nflverse snap counts and loads them into the
// Supabase snap_counts table for every player in our players table.
//
// Run from the project folder (after load-players.js has been run):
//   node --env-file=.env scripts/load-snap-counts.js

import Papa from "papaparse";
import { createClient } from "@supabase/supabase-js";

const SEASON = 2026;
const SNAPS_URL = `https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_${SEASON}.csv`;

const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY. Check your .env file.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

// Builds a lookup from pfr_id to gsis_id using our own players table.
// Supabase only hands back 1,000 rows per request, so we ask in pages
// until we've got everyone.
async function getPfrToGsisMap() {
  const map = new Map();
  const PAGE_SIZE = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("players")
      .select("gsis_id, pfr_id")
      .not("pfr_id", "is", null)
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`Supabase error reading players: ${error.message}`);

    for (const p of data) map.set(p.pfr_id, p.gsis_id);

    if (data.length < PAGE_SIZE) break; // last page
    from += PAGE_SIZE;
  }
  return map;
}

async function main() {
  // 1. Get the ID translator from the players table
  console.log("Reading players from Supabase...");
  const pfrToGsis = await getPfrToGsisMap();
  console.log(`Loaded ${pfrToGsis.size} player IDs`);

  // 2. Download this season's snap counts
  console.log(`Downloading ${SEASON} snap counts from nflverse...`);
  const response = await fetch(SNAPS_URL);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  const parsed = Papa.parse(await response.text(), { header: true, skipEmptyLines: true });
  console.log(`Found ${parsed.data.length} snap count rows total`);

  // 3. Keep rows for players we know, translating pfr_id to gsis_id.
  //    This also drops linemen and defense, since they aren't in our players table.
  let skipped = 0;
  const rows = [];
  for (const s of parsed.data) {
    const gsisId = pfrToGsis.get(s.pfr_player_id);
    if (!gsisId) {
      skipped++;
      continue;
    }
    rows.push({
      gsis_id: gsisId,
      game_id: s.game_id,
      season: Number(s.season),
      week: Number(s.week),
      team: s.team || null,
      opponent: s.opponent || null,
      offense_snaps: s.offense_snaps === "" ? null : Number(s.offense_snaps),
      offense_pct: s.offense_pct === "" ? null : Number(s.offense_pct),
      updated_at: new Date().toISOString(),
    });
  }
  console.log(`Keeping ${rows.length} rows for our players (skipped ${skipped} others)`);

  // 4. Save in chunks. Upsert on (gsis_id, game_id) so rerunning it
  //    each week updates old games and adds new ones without duplicates.
  const CHUNK_SIZE = 500;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const { error } = await supabase
      .from("snap_counts")
      .upsert(chunk, { onConflict: "gsis_id,game_id" });

    if (error) throw new Error(`Supabase error: ${error.message}`);
    console.log(`Saved ${Math.min(i + CHUNK_SIZE, rows.length)} of ${rows.length}`);
  }

  console.log("Done!");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
