// load-rushes.js
// Downloads this season's nflverse play-by-play file, pulls out every
// carry, and loads them into the Supabase rushes table.
//
// Run from the project folder (after load-players.js has been run):
//   node --env-file=.env scripts/load-rushes.js

import { gunzipSync } from "node:zlib";
import Papa from "papaparse";
import { createClient } from "@supabase/supabase-js";

const SEASON = 2026;
const PBP_URL = `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${SEASON}.csv.gz`;
const BATCH_SIZE = 500;

const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY. Check your .env file.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

// Gets every gsis_id in our players table, so we only save carries for
// players we know about. Supabase hands back 1,000 rows per request,
// so we ask in pages until we've got everyone.
async function getKnownPlayerIds() {
  const ids = new Set();
  const PAGE_SIZE = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("players")
      .select("gsis_id")
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`Supabase error reading players: ${error.message}`);

    for (const p of data) ids.add(p.gsis_id);

    if (data.length < PAGE_SIZE) break; // last page
    from += PAGE_SIZE;
  }
  return ids;
}

// The CSV gives us everything as text. These turn it into real numbers
// and true/false, and turn blanks into null so the database stores "unknown".
function toInt(value) {
  if (value === undefined || value === "" || value === "NA") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function toNum(value) {
  if (value === undefined || value === "" || value === "NA") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toBool(value) {
  if (value === undefined || value === "" || value === "NA") return null;
  return value === "1";
}

function toText(value) {
  if (value === undefined || value === "" || value === "NA") return null;
  return value;
}

async function main() {
  // 1. Get the list of players we can attach carries to
  console.log("Reading players from Supabase...");
  const knownIds = await getKnownPlayerIds();
  console.log(`Loaded ${knownIds.size} player IDs`);

  // 2. Download the play-by-play file. It comes zipped (.gz), so we unzip it in memory.
  console.log("Downloading play-by-play (this one's big, give it a few seconds)...");
  const res = await fetch(PBP_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const zipped = Buffer.from(await res.arrayBuffer());
  const csvText = gunzipSync(zipped).toString("utf8");

  const { data: plays } = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  console.log(`Read ${plays.length} plays`);

  // 3. Keep only real carries:
  //    - a run play (this includes QB scrambles, which nflverse counts as runs)
  //    - not a kneel-down (those aren't real carries and would drag down yards per carry)
  //    - not a penalty that wiped the play out
  //    - not a two-point try (those don't count toward carries)
  const rows = [];
  let skipped = 0;

  for (const p of plays) {
    if (p.play_type !== "run") continue;
    if (p.rush_attempt !== "1") continue;
    if (p.two_point_attempt === "1") continue;
    if (!p.rusher_player_id || p.rusher_player_id === "NA") continue;

    if (!knownIds.has(p.rusher_player_id)) {
      skipped++;
      continue;
    }

    rows.push({
      game_id: p.game_id,
      play_id: toInt(p.play_id),
      season: toInt(p.season),
      week: toInt(p.week),
      team: toText(p.posteam),
      opponent: toText(p.defteam),
      rusher_id: p.rusher_player_id,
      down: toInt(p.down),
      ydstogo: toInt(p.ydstogo),
      yardline_100: toInt(p.yardline_100),
      run_location: toText(p.run_location),
      run_gap: toText(p.run_gap),
      rushing_yards: toInt(p.rushing_yards),
      first_down: toBool(p.first_down_rush),
      touchdown: toBool(p.rush_touchdown),
      fumble_lost: toBool(p.fumble_lost),
      qb_scramble: toBool(p.qb_scramble),
      epa: toNum(p.epa),
      updated_at: new Date().toISOString(),
    });
  }

  console.log(`Found ${rows.length} carries (${skipped} skipped, rusher not in players table)`);

  // 4. Save in batches. Upsert means re-running this later just updates
  //    plays we already have instead of creating duplicates.
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from("rushes")
      .upsert(batch, { onConflict: "game_id,play_id" });

    if (error) throw new Error(`Supabase error saving rushes: ${error.message}`);
    console.log(`Saved ${Math.min(i + BATCH_SIZE, rows.length)} of ${rows.length}`);
  }

  console.log("Done!");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
