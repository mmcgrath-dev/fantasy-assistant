// snapshot-demo.mjs
// Freezes this week's real app data into JSON files for the public demo.
//
// Run it from the project folder (it needs your .env, same as the loaders):
//   node --env-file=.env scripts/snapshot-demo.mjs
//
// What it does:
//   1. Calls the same three Netlify functions the app uses (roster, trades,
//      league-odds) right here on your computer, so nothing gets deployed.
//   2. Swaps your league-mates' team names for "Team 1" through "Team 9".
//      Your own team name stays. NFL players stay as they are.
//   3. Saves the results in demo/data/. Those files are all the demo ever
//      reads, so the public site never touches ESPN, Supabase or your keys.

import { mkdir, writeFile } from "node:fs/promises";
import roster from "../netlify/functions/roster.js";
import trades from "../netlify/functions/trades.js";
import leagueOdds from "../netlify/functions/league-odds.js";

const OUT = new URL("../demo/data/", import.meta.url);

// Each function hands back a web Response, same as on Netlify. .json() opens it.
async function run(name, fn) {
  const response = await fn(new Request(`http://localhost/.netlify/functions/${name}`));
  const json = await response.json();
  if (json.error) throw new Error(`${name}: ${json.error}`);
  console.log(`  got ${name}`);
  return json;
}

console.log("Pulling this week's data...");
const data = {
  roster: await run("roster", roster),
  trades: await run("trades", trades),
  "league-odds": await run("league-odds", leagueOdds),
};

// Team ids stay the same (trades and the schedule point at them), only the
// names change. Numbered in id order so it's the same every week you run this.
const others = data.trades.teams.filter((t) => !t.isMine).sort((a, b) => a.id - b.id);
const realNames = others.map((t) => t.name);
const newName = new Map(others.map((t, i) => [t.id, `Team ${i + 1}`]));

for (const file of ["trades", "league-odds"]) {
  for (const team of data[file].teams) {
    if (newName.has(team.id)) team.name = newName.get(team.id);
  }
}

// Last check: no real league-mate name should survive anywhere in the files.
for (const [file, json] of Object.entries(data)) {
  const text = JSON.stringify(json);
  const leak = realNames.find((n) => n && text.includes(`"${n}"`));
  if (leak) throw new Error(`${file} still has a real team name in it (${leak}). Nothing was saved.`);
}

await mkdir(OUT, { recursive: true });
for (const [file, json] of Object.entries(data)) {
  await writeFile(new URL(`${file}.json`, OUT), JSON.stringify(json));
}
console.log(`Saved Week ${data.roster.week} to demo/data/. Team names swapped: ${others.length}.`);
