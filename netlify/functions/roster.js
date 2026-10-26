// This function gets your roster from ESPN for the current week,
// cleans it up, adds up your starters' projected points,
// and looks up each player's snap trend in your Supabase database.

import { createClient } from "@supabase/supabase-js";

// ESPN uses numbers instead of names for positions, NFL teams, and lineup spots.
// These "lookup tables" translate the numbers into words.
const POSITIONS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };

const NFL_TEAMS = {
  0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN",
  8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA",
  16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT",
  24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL",
  34: "HOU",
};

const LINEUP_SLOTS = {
  0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "D/ST", 17: "K", 20: "Bench", 21: "IR", 23: "FLEX",
};

// ESPN's injury words, shortened the way fantasy sites usually show them.
// Healthy players come through as "ACTIVE" or "NORMAL", which aren't in here on purpose.
const INJURY_LABELS = {
  OUT: "O",
  DOUBTFUL: "D",
  QUESTIONABLE: "Q",
  INJURY_RESERVE: "IR",
  SUSPENSION: "SSPD",
};

// The order we want slots to appear in, top to bottom.
const SLOT_ORDER = ["QB", "RB", "WR", "TE", "FLEX", "D/ST", "K", "Bench", "IR"];

// Rounds a number to one decimal place, like 14.93 -> 14.9
function roundToOne(number) {
  return Math.round(number * 10) / 10;
}

// Asks Supabase for the snap trend of every player whose ESPN ID is in the list.
// Returns a lookup like { "4890973": { last2: 56, prior2: 76, change: -20, trend: "down" } }
//
// If anything goes wrong (missing keys, Supabase is down), it returns an empty
// lookup instead of crashing. Your roster still shows up, just without trends.
async function getSnapTrends(espnIds) {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.log("Snap trends skipped: SUPABASE_URL or SUPABASE_SECRET_KEY is missing");
    return {};
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

  // .rpc calls a database function by name, here the get_snap_trends function
  // from supabase/10_snap_trends.sql. The object holds its input.
  const { data, error } = await supabase.rpc("get_snap_trends", { espn_ids: espnIds });
  if (error) {
    console.log("Snap trends failed:", error.message);
    return {};
  }

  const trends = {};
  for (const row of data) {
    trends[row.espn_id] = {
      last2: row.last_2,
      prior2: row.prior_2,
      change: row.change,
      trend: row.trend,
    };
  }
  return trends;
}

export default async () => {
  // 1. Read settings from .env
  const leagueId = process.env.ESPN_LEAGUE_ID;
  const season = process.env.ESPN_SEASON;
  const teamId = Number(process.env.ESPN_TEAM_ID); // .env values are text, so turn "2" into the number 2
  const espnS2 = process.env.ESPN_S2;
  const swid = process.env.ESPN_SWID;

  if (!leagueId || !season || !teamId || !espnS2 || !swid) {
    return Response.json({ error: "Missing one of the ESPN settings in .env" }, { status: 500 });
  }

  // Two ESPN addresses: one for the whole NFL season, one for your league inside it.
  const seasonUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}`;
  const leagueUrl = `${seasonUrl}/segments/0/leagues/${leagueId}`;

  // A small helper so we don't have to repeat the fetch + cookies code every time.
  // You pass in a full address and it returns ESPN's data.
  async function getFromEspn(url) {
    const response = await fetch(url, {
      headers: { Cookie: `espn_s2=${espnS2}; SWID=${swid}` },
    });
    if (!response.ok) {
      throw new Error(`ESPN turned down the request (status ${response.status})`);
    }
    return response.json();
  }

  try {
    // 2. Ask ESPN what week it is. ESPN calls a week a "scoring period."
    const status = await getFromEspn(`${leagueUrl}?view=mStatus`);
    const week = status.scoringPeriodId;

    // 3. Ask for every team's roster for that week.
    const league = await getFromEspn(`${leagueUrl}?view=mRoster&view=mTeam&scoringPeriodId=${week}`);

    // 4. Ask for the NFL schedule so we know each NFL team's bye week.
    //    This turns ESPN's list into a simple lookup: { 28: 7, 30: 7, ... } (team id -> bye week)
    const schedule = await getFromEspn(`${seasonUrl}?view=proTeamSchedules_wl`);
    const byeWeeks = {};
    for (const proTeam of schedule.settings.proTeams) {
      byeWeeks[proTeam.id] = proTeam.byeWeek;
    }

    // 5. Find your team in the list.
    const myTeam = league.teams.find((team) => team.id === teamId);
    if (!myTeam) {
      return Response.json({ error: `No team with id ${teamId} in this league` }, { status: 404 });
    }

    // 6. Turn each roster spot into a simple player object.
    const players = myTeam.roster.entries.map((entry) => {
      const player = entry.playerPoolEntry.player;

      // ESPN gives a list of stat lines per player. We want the one that is:
      //   statSourceId 1     = a projection (0 would be actual points scored)
      //   statSplitTypeId 1  = a single week (0 would be the whole season)
      //   scoringPeriodId    = this week
      const projection = (player.stats || []).find(
        (stat) =>
          stat.statSourceId === 1 &&
          stat.statSplitTypeId === 1 &&
          stat.scoringPeriodId === week
      );

      const slot = LINEUP_SLOTS[entry.lineupSlotId] || `Slot ${entry.lineupSlotId}`;

      // Status: BYE wins if their NFL team isn't playing this week.
      // Otherwise use the injury label, or "" (empty) if they're healthy.
      let gameStatus = "";
      if (byeWeeks[player.proTeamId] === week) {
        gameStatus = "BYE";
      } else if (INJURY_LABELS[player.injuryStatus]) {
        gameStatus = INJURY_LABELS[player.injuryStatus];
      }

      return {
        // ESPN's ID for this player, saved as text since that's how the players table stores it.
        espnId: String(player.id),
        name: player.fullName,
        position: POSITIONS[player.defaultPositionId] || "?",
        nflTeam: NFL_TEAMS[player.proTeamId] || "?",
        slot: slot,
        starter: slot !== "Bench" && slot !== "IR",
        status: gameStatus,
        // Keep ESPN's exact number for now so the total adds up correctly.
        // We round it at the very end. If ESPN has no projection, use 0.
        projected: projection ? projection.appliedTotal : 0,
      };
    });

    // 7. Look up snap trends for everyone on the roster in one trip to the database,
    //    then attach each player's trend to him. Players with fewer than 4 games
    //    (and D/ST, which isn't a player) get null, which the page shows as a dash.
    const trends = await getSnapTrends(players.map((p) => p.espnId));
    for (const player of players) {
      player.snapTrend = trends[player.espnId] || null;
    }

    // 8. Sort players into lineup order.
    //    .sort compares two players at a time (a and b) and needs a number back:
    //      negative = a goes first, positive = b goes first, 0 = keep as is.
    //    indexOf gives each slot's position in SLOT_ORDER (QB is 0, RB is 1, and so on).
    //    Players in the same slot (like your two RBs) get 0, so they stay in the
    //    order ESPN sent them. That keeps the list matching your ESPN team page.
    players.sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));

    // 9. Add up projected points for starters only (bench points don't count).
    const projectedTotal = players
      .filter((p) => p.starter)
      .reduce((sum, p) => sum + p.projected, 0);

    // 10. Send back the cleaned-up result.
    //    Now that the total is added up from exact numbers, round everything for display.
    //    { ...player } copies all of a player's info, then projected: overwrites just that one value.
    return Response.json({
      week: week,
      teamName: (myTeam.name || `${myTeam.location} ${myTeam.nickname}`).trim(),
      projectedTotal: roundToOne(projectedTotal),
      players: players.map((player) => ({
        ...player,
        projected: roundToOne(player.projected),
      })),
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 502 });
  }
};
