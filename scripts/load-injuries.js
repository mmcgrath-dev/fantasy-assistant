// load-injuries.js
// Downloads this season's nflverse injury reports and loads them into the
// Supabase injuries table.
//
// Run from the project folder (after load-players.js has been run):
//   node --env-file=.env scripts/load-injuries.js
//
// Injury reports come out Wednesday through Friday, so running this late in
// the week (Friday night or Saturday) gets the final statuses for that week.

import Papa from "papaparse";
import { createClient } from "@supabase/supabase-js";

const SEASON = 2026;
const INJURIES_URL = `https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_${SEASON}.csv`;
const BATCH_SIZE = 500;

const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY. Check your .env file.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

// Gets every gsis_id in our players table, so we only save injuries for
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

function toInt(value) {
  if (value === undefined || value === "" || value === "NA") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function toText(value) {
  if (value === undefined || value === "" || value === "NA") return null;
  return value;
}

// nflverse writes practice status out in full. Shorten it so it's easy
// to filter on later, like: where practice_status = 'DNP'
function shortPractice(value) {
  if (!value) return null;
  if (value.startsWith("Full")) return "Full";
  if (value.startsWith("Limited")) return "Limited";
  if (value.startsWith("Did Not")) return "DNP";
  return value;
}

async function main() {
  // 1. Get the list of players we can attach injuries to
  console.log("Reading players from Supabase...");
  const knownIds = await getKnownPlayerIds();
  console.log(`Loaded ${knownIds.size} player IDs`);

  // 2. Download the injury reports
  console.log("Downloading injury reports...");
  const res = await fetch(INJURIES_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const csvText = await res.text();

  const { data: reports } = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  console.log(`Read ${reports.length} injury report entries`);

  // 3. Shape each row for the table
  const rows = [];
  let skipped = 0;

  for (const r of reports) {
    if (!r.gsis_id) continue;

    if (!knownIds.has(r.gsis_id)) {
      skipped++;
      continue;
    }

    // The game status injury is the official one. If it's blank, fall back
    // to the injury listed on the practice report.
    rows.push({
      gsis_id: r.gsis_id,
      season: toInt(r.season),
      week: toInt(r.week),
      team: toText(r.team),
      position: toText(r.position),
      game_status: toText(r.report_status),
      injury: toText(r.report_primary_injury) ?? toText(r.practice_primary_injury),
      injury_secondary: toText(r.report_secondary_injury) ?? toText(r.practice_secondary_injury),
      practice_status: shortPractice(toText(r.practice_status)),
      practice_note: toText(r.practice_primary_injury),
      updated_at: new Date().toISOString(),
    });
  }

  console.log(`Found ${rows.length} injury entries (${skipped} skipped, player not in players table)`);

  // 4. Save in batches. Upsert means re-running this later in the week
  //    updates a player's status instead of creating duplicates.
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from("injuries")
      .upsert(batch, { onConflict: "gsis_id,season,week" });

    if (error) throw new Error(`Supabase error saving injuries: ${error.message}`);
    console.log(`Saved ${Math.min(i + BATCH_SIZE, rows.length)} of ${rows.length}`);
  }

  console.log("Done!");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
