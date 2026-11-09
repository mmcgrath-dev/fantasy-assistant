// load-schedule.js
// Downloads the nflverse schedule and loads this season's games into the
// Supabase schedule table: every week, opponents, final scores once games
// are played, and Vegas lines.
//
// Run from the project folder:
//   node --env-file=.env scripts/load-schedule.js
//
// Doesn't depend on the players table, so it can run in any order.
// Scores and Vegas lines change during the week, so it reloads every game each
// time and upsert overwrites the old values.

import Papa from "papaparse";
import { createClient } from "@supabase/supabase-js";

const SEASON = 2026;
// nflverse keeps the whole schedule (every season) in one file on GitHub.
const SCHEDULE_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";

const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY. Check your .env file.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

function toInt(value) {
  if (value === undefined || value === "" || value === "NA") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function toNumber(value) {
  if (value === undefined || value === "" || value === "NA") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toText(value) {
  if (value === undefined || value === "" || value === "NA") return null;
  return value;
}

async function main() {
  // 1. Download the schedule
  console.log("Downloading schedule...");
  const res = await fetch(SCHEDULE_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const csvText = await res.text();

  const { data: games } = Papa.parse(csvText, { header: true, skipEmptyLines: true });

  // 2. Keep this season only (the file goes back to 1999)
  const rows = games
    .filter((g) => toInt(g.season) === SEASON)
    .map((g) => ({
      game_id: g.game_id,
      season: toInt(g.season),
      week: toInt(g.week),
      game_type: toText(g.game_type),
      gameday: toText(g.gameday),
      gametime: toText(g.gametime),
      away_team: g.away_team,
      home_team: g.home_team,
      away_score: toInt(g.away_score),
      home_score: toInt(g.home_score),
      spread_line: toNumber(g.spread_line),
      total_line: toNumber(g.total_line),
      roof: toText(g.roof),
      temp: toInt(g.temp),
      wind: toInt(g.wind),
      div_game: g.div_game === "1",
      updated_at: new Date().toISOString(),
    }));

  const played = rows.filter((r) => r.home_score !== null).length;
  console.log(`Found ${rows.length} games for ${SEASON} (${played} played so far)`);

  // 3. Save. Only about 272 games, so one upsert is plenty.
  //    Upsert on game_id means scores and lines get updated on every run.
  const { error } = await supabase.from("schedule").upsert(rows, { onConflict: "game_id" });
  if (error) throw new Error(`Supabase error saving schedule: ${error.message}`);

  console.log("Done!");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
