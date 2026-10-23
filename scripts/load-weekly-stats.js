// load-weekly-stats.js
// Downloads this season's nflverse weekly player stats (the box scores) and
// loads them into the Supabase weekly_stats table.
//
// Run from the project folder (after load-players.js has been run):
//   node --env-file=.env scripts/load-weekly-stats.js

import Papa from "papaparse";
import { createClient } from "@supabase/supabase-js";

const SEASON = 2026;
const STATS_URL = `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${SEASON}.csv`;
const BATCH_SIZE = 500;

// Only fantasy positions. Defensive players and linemen have rows in this
// file too, but your league doesn't score them, and their snap counts are
// already in snap_counts for the injury features.
const FANTASY_POSITIONS = new Set(["QB", "RB", "FB", "WR", "TE", "K"]);

const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY. Check your .env file.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

// Gets every gsis_id in our players table, so we only save stats for
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
// and turn blanks into null so the database stores "unknown".
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

function toText(value) {
  if (value === undefined || value === "" || value === "NA") return null;
  return value;
}

// Adds up columns that can be blank, treating blank as 0
function sum(...values) {
  return values.reduce((total, v) => total + (toInt(v) ?? 0), 0);
}

async function main() {
  // 1. Get the list of players we can attach stats to
  console.log("Reading players from Supabase...");
  const knownIds = await getKnownPlayerIds();
  console.log(`Loaded ${knownIds.size} player IDs`);

  // 2. Download the weekly stats file
  console.log("Downloading weekly stats...");
  const res = await fetch(STATS_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const csvText = await res.text();

  const { data: stats } = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  console.log(`Read ${stats.length} player games`);

  // 3. Keep fantasy positions only and shape each row for the table
  const rows = [];
  let skipped = 0;

  for (const s of stats) {
    if (!FANTASY_POSITIONS.has(s.position)) continue;
    if (!s.player_id || !s.game_id) continue;

    if (!knownIds.has(s.player_id)) {
      skipped++;
      continue;
    }

    rows.push({
      gsis_id: s.player_id,
      game_id: s.game_id,
      season: toInt(s.season),
      week: toInt(s.week),
      team: toText(s.team),
      opponent: toText(s.opponent_team),
      position: toText(s.position),

      completions: toInt(s.completions),
      attempts: toInt(s.attempts),
      passing_yards: toInt(s.passing_yards),
      passing_tds: toInt(s.passing_tds),
      interceptions: toInt(s.passing_interceptions),
      sacks: toInt(s.sacks_suffered),

      carries: toInt(s.carries),
      rushing_yards: toInt(s.rushing_yards),
      rushing_tds: toInt(s.rushing_tds),

      targets: toInt(s.targets),
      receptions: toInt(s.receptions),
      receiving_yards: toInt(s.receiving_yards),
      receiving_tds: toInt(s.receiving_tds),
      receiving_air_yards: toInt(s.receiving_air_yards),
      target_share: toNum(s.target_share),
      air_yards_share: toNum(s.air_yards_share),
      wopr: toNum(s.wopr),

      two_point_conversions: sum(
        s.passing_2pt_conversions,
        s.rushing_2pt_conversions,
        s.receiving_2pt_conversions
      ),
      fumbles_lost: sum(s.sack_fumbles_lost, s.rushing_fumbles_lost, s.receiving_fumbles_lost),
      special_teams_tds: toInt(s.special_teams_tds),

      fg_made: toInt(s.fg_made),
      fg_att: toInt(s.fg_att),
      fg_made_40_49: toInt(s.fg_made_40_49),
      fg_made_50_plus: sum(s.fg_made_50_59, s.fg_made_60_),
      fg_missed: toInt(s.fg_missed),
      pat_made: toInt(s.pat_made),
      pat_missed: toInt(s.pat_missed),

      fantasy_points_ppr: toNum(s.fantasy_points_ppr),
      updated_at: new Date().toISOString(),
    });
  }

  console.log(`Found ${rows.length} player games (${skipped} skipped, player not in players table)`);

  // 4. Save in batches. Upsert means re-running this later just updates
  //    games we already have instead of creating duplicates.
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from("weekly_stats")
      .upsert(batch, { onConflict: "gsis_id,game_id" });

    if (error) throw new Error(`Supabase error saving weekly stats: ${error.message}`);
    console.log(`Saved ${Math.min(i + BATCH_SIZE, rows.length)} of ${rows.length}`);
  }

  console.log("Done!");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
