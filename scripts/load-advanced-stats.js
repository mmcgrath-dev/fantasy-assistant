// load-advanced-stats.js
// Downloads this season's Next Gen Stats and Pro Football Reference advanced
// stats from nflverse, combines them into one row per player per week, and
// loads them into the Supabase receiving_advanced and rushing_advanced tables.
//
// Run from the project folder (after load-players.js has been run):
//   node --env-file=.env scripts/load-advanced-stats.js

import { gunzipSync } from "node:zlib";
import Papa from "papaparse";
import { createClient } from "@supabase/supabase-js";

const SEASON = 2026;
const BASE = "https://github.com/nflverse/nflverse-data/releases/download";

// Next Gen Stats files hold every season in one file, so we filter to ours
const NGS_RECEIVING_URL = `${BASE}/nextgen_stats/ngs_receiving.csv.gz`;
const NGS_RUSHING_URL = `${BASE}/nextgen_stats/ngs_rushing.csv.gz`;
// PFR files are one per season
const PFR_RECEIVING_URL = `${BASE}/pfr_advstats/advstats_week_rec_${SEASON}.csv`;
const PFR_RUSHING_URL = `${BASE}/pfr_advstats/advstats_week_rush_${SEASON}.csv`;

const BATCH_SIZE = 500;

const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY. Check your .env file.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

// Reads every player from our players table and builds two things:
//   knownIds: every gsis_id we have (Next Gen Stats uses gsis_id)
//   pfrToGsis: a translator from PFR IDs to gsis_id (PFR uses its own IDs)
// Supabase hands back 1,000 rows per request, so we ask in pages.
async function getPlayerIds() {
  const knownIds = new Set();
  const pfrToGsis = new Map();
  const PAGE_SIZE = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("players")
      .select("gsis_id, pfr_id")
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`Supabase error reading players: ${error.message}`);

    for (const p of data) {
      knownIds.add(p.gsis_id);
      if (p.pfr_id) pfrToGsis.set(p.pfr_id, p.gsis_id);
    }

    if (data.length < PAGE_SIZE) break; // last page
    from += PAGE_SIZE;
  }
  return { knownIds, pfrToGsis };
}

// Downloads a CSV (unzipping it first if it ends in .gz) and returns its rows
async function downloadCsv(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed for ${url}: ${res.status} ${res.statusText}`);

  let text;
  if (url.endsWith(".gz")) {
    const zipped = Buffer.from(await res.arrayBuffer());
    text = gunzipSync(zipped).toString("utf8");
  } else {
    text = await res.text();
  }

  const { data } = Papa.parse(text, { header: true, skipEmptyLines: true });
  return data;
}

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

// Next Gen Stats writes percents as 0 to 100. We store everything as
// 0 to 1 so it matches target_share in weekly_stats.
function pctToDecimal(value) {
  const n = toNum(value);
  return n === null ? null : n / 100;
}

function toText(value) {
  if (value === undefined || value === "" || value === "NA") return null;
  return value;
}

// Both tables combine two files, so rows are collected in a Map keyed by
// player + week. Whichever file sees a player first creates his row, and the
// other file fills in the rest.
function getRow(map, gsisId, week) {
  const key = `${gsisId}|${week}`;
  if (!map.has(key)) {
    map.set(key, { gsis_id: gsisId, season: SEASON, week });
  }
  return map.get(key);
}

async function save(table, rows) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from(table)
      .upsert(batch, { onConflict: "gsis_id,season,week" });

    if (error) throw new Error(`Supabase error saving ${table}: ${error.message}`);
    console.log(`  Saved ${Math.min(i + BATCH_SIZE, rows.length)} of ${rows.length}`);
  }
}

async function loadReceiving(knownIds, pfrToGsis) {
  console.log("\nReceiving: downloading Next Gen Stats and PFR...");
  const ngs = await downloadCsv(NGS_RECEIVING_URL);
  const pfr = await downloadCsv(PFR_RECEIVING_URL);

  const rows = new Map();
  let skipped = 0;

  // Next Gen Stats. Week 0 in this file is season-to-date totals, so we skip it
  // and keep only real weeks.
  for (const n of ngs) {
    if (toInt(n.season) !== SEASON || n.season_type !== "REG") continue;
    const week = toInt(n.week);
    if (!week) continue;
    if (!knownIds.has(n.player_gsis_id)) { skipped++; continue; }

    const row = getRow(rows, n.player_gsis_id, week);
    row.team = toText(n.team_abbr);
    row.avg_cushion = toNum(n.avg_cushion);
    row.avg_separation = toNum(n.avg_separation);
    row.avg_intended_air_yards = toNum(n.avg_intended_air_yards);
    row.share_of_team_air_yards = pctToDecimal(n.percent_share_of_intended_air_yards);
    row.catch_rate = pctToDecimal(n.catch_percentage);
    row.avg_yac = toNum(n.avg_yac);
    row.avg_expected_yac = toNum(n.avg_expected_yac);
    row.yac_over_expected = toNum(n.avg_yac_above_expectation);
  }

  // Pro Football Reference
  for (const p of pfr) {
    if (p.game_type && p.game_type !== "REG") continue;
    const gsisId = pfrToGsis.get(p.pfr_player_id);
    if (!gsisId) { skipped++; continue; }

    const row = getRow(rows, gsisId, toInt(p.week));
    row.game_id = toText(p.game_id);
    row.team = toText(p.team) ?? row.team;
    row.opponent = toText(p.opponent);
    row.drops = toInt(p.receiving_drop);
    row.drop_rate = toNum(p.receiving_drop_pct);
    row.broken_tackles = toInt(p.receiving_broken_tackles);
    row.passer_rating_when_targeted = toNum(p.receiving_rat);
  }

  const list = [...rows.values()].map(fillBlanks(RECEIVING_COLUMNS));
  console.log(`  Found ${list.length} player weeks (${skipped} skipped, player not in players table)`);
  await save("receiving_advanced", list);
}

async function loadRushing(knownIds, pfrToGsis) {
  console.log("\nRushing: downloading Next Gen Stats and PFR...");
  const ngs = await downloadCsv(NGS_RUSHING_URL);
  const pfr = await downloadCsv(PFR_RUSHING_URL);

  const rows = new Map();
  let skipped = 0;

  // Next Gen Stats (week 0 is season totals, skipped)
  for (const n of ngs) {
    if (toInt(n.season) !== SEASON || n.season_type !== "REG") continue;
    const week = toInt(n.week);
    if (!week) continue;
    if (!knownIds.has(n.player_gsis_id)) { skipped++; continue; }

    const row = getRow(rows, n.player_gsis_id, week);
    row.team = toText(n.team_abbr);
    row.efficiency = toNum(n.efficiency);
    row.pct_vs_eight_plus_box = pctToDecimal(n.percent_attempts_gte_eight_defenders);
    row.avg_time_to_los = toNum(n.avg_time_to_los);
    row.expected_rush_yards = toNum(n.expected_rush_yards);
    row.rush_yards_over_expected = toNum(n.rush_yards_over_expected);
    row.ryoe_per_carry = toNum(n.rush_yards_over_expected_per_att);
    row.pct_carries_over_expected = toNum(n.rush_pct_over_expected); // already 0 to 1
  }

  // Pro Football Reference
  for (const p of pfr) {
    if (p.game_type && p.game_type !== "REG") continue;
    const gsisId = pfrToGsis.get(p.pfr_player_id);
    if (!gsisId) { skipped++; continue; }

    const row = getRow(rows, gsisId, toInt(p.week));
    row.game_id = toText(p.game_id);
    row.team = toText(p.team) ?? row.team;
    row.opponent = toText(p.opponent);
    row.carries = toInt(p.carries);
    row.yards_before_contact = toInt(p.rushing_yards_before_contact);
    row.yards_before_contact_avg = toNum(p.rushing_yards_before_contact_avg);
    row.yards_after_contact = toInt(p.rushing_yards_after_contact);
    row.yards_after_contact_avg = toNum(p.rushing_yards_after_contact_avg);
    row.broken_tackles = toInt(p.rushing_broken_tackles);
  }

  const list = [...rows.values()].map(fillBlanks(RUSHING_COLUMNS));
  console.log(`  Found ${list.length} player weeks (${skipped} skipped, player not in players table)`);
  await save("rushing_advanced", list);
}

// Supabase needs every row in a batch to have the same columns. A player who
// only showed up in one of the two files is missing the other file's columns,
// so this fills those in as null ("no data that week").
const RECEIVING_COLUMNS = [
  "game_id", "team", "opponent", "avg_cushion", "avg_separation",
  "avg_intended_air_yards", "share_of_team_air_yards", "catch_rate", "avg_yac",
  "avg_expected_yac", "yac_over_expected", "drops", "drop_rate", "broken_tackles",
  "passer_rating_when_targeted",
];
const RUSHING_COLUMNS = [
  "game_id", "team", "opponent", "efficiency", "pct_vs_eight_plus_box",
  "avg_time_to_los", "expected_rush_yards", "rush_yards_over_expected",
  "ryoe_per_carry", "pct_carries_over_expected", "carries", "yards_before_contact",
  "yards_before_contact_avg", "yards_after_contact", "yards_after_contact_avg",
  "broken_tackles",
];

function fillBlanks(columns) {
  const now = new Date().toISOString();
  return (row) => {
    for (const c of columns) if (row[c] === undefined) row[c] = null;
    row.updated_at = now;
    return row;
  };
}

async function main() {
  console.log("Reading players from Supabase...");
  const { knownIds, pfrToGsis } = await getPlayerIds();
  console.log(`Loaded ${knownIds.size} player IDs (${pfrToGsis.size} with PFR IDs)`);

  await loadReceiving(knownIds, pfrToGsis);
  await loadRushing(knownIds, pfrToGsis);

  console.log("\nDone!");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
