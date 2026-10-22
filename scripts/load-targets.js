// load-targets.js
// Downloads this season's nflverse play-by-play file, pulls out every pass
// thrown to a player (a "target"), and loads them into the Supabase targets table.
//
// Run from the project folder (after load-players.js has been run):
//   node --env-file=.env scripts/load-targets.js

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

// Gets every gsis_id in our players table, so we only save targets for
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
  // 1. Get the list of players we can attach targets to
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

  // 3. Keep only real targets:
  //    - a pass play (not a penalty that wiped the play out)
  //    - not a sack (no throw happened)
  //    - thrown to a specific player (throwaways and spikes have no receiver)
  //    - not a two-point try (those don't count toward a player's target share)
  const rows = [];
  let skipped = 0;

  for (const p of plays) {
    if (p.play_type !== "pass") continue;
    if (p.pass_attempt !== "1") continue;
    if (p.sack === "1") continue;
    if (p.two_point_attempt === "1") continue;
    if (!p.receiver_player_id || p.receiver_player_id === "NA") continue;

    if (!knownIds.has(p.receiver_player_id)) {
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
      receiver_id: p.receiver_player_id,
      passer_id: toText(p.passer_player_id),
      down: toInt(p.down),
      ydstogo: toInt(p.ydstogo),
      yardline_100: toInt(p.yardline_100),
      air_yards: toInt(p.air_yards),
      pass_length: toText(p.pass_length),
      pass_location: toText(p.pass_location),
      complete: toBool(p.complete_pass),
      receiving_yards: toInt(p.receiving_yards),
      yards_after_catch: toInt(p.yards_after_catch),
      touchdown: toBool(p.pass_touchdown),
      interception: toBool(p.interception),
      epa: toNum(p.epa),
      updated_at: new Date().toISOString(),
    });
  }

  console.log(`Found ${rows.length} targets (${skipped} skipped, receiver not in players table)`);

  // 4. Save in batches. Upsert means re-running this later just updates
  //    plays we already have instead of creating duplicates.
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from("targets")
      .upsert(batch, { onConflict: "game_id,play_id" });

    if (error) throw new Error(`Supabase error saving targets: ${error.message}`);
    console.log(`Saved ${Math.min(i + BATCH_SIZE, rows.length)} of ${rows.length}`);
  }

  console.log("Done!");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
