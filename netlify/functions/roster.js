// This function gets your roster from ESPN for the current week,
// cleans it up, and adds up your starters' projected points.

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

  const baseUrl =
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}` +
    `/segments/0/leagues/${leagueId}`;

  // A small helper so we don't have to repeat the fetch + cookies code twice.
  // You pass in the part that goes after "?" and it returns ESPN's data.
  async function getFromEspn(query) {
    const response = await fetch(`${baseUrl}?${query}`, {
      headers: { Cookie: `espn_s2=${espnS2}; SWID=${swid}` },
    });
    if (!response.ok) {
      throw new Error(`ESPN turned down the request (status ${response.status})`);
    }
    return response.json();
  }

  try {
    // 2. Ask ESPN what week it is. ESPN calls a week a "scoring period."
    const status = await getFromEspn("view=mStatus");
    const week = status.scoringPeriodId;

    // 3. Ask for every team's roster for that week.
    const league = await getFromEspn(`view=mRoster&view=mTeam&scoringPeriodId=${week}`);

    // 4. Find your team in the list.
    const myTeam = league.teams.find((team) => team.id === teamId);
    if (!myTeam) {
      return Response.json({ error: `No team with id ${teamId} in this league` }, { status: 404 });
    }

    // 5. Turn each roster spot into a simple player object.
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

      return {
        name: player.fullName,
        position: POSITIONS[player.defaultPositionId] || "?",
        nflTeam: NFL_TEAMS[player.proTeamId] || "?",
        slot: slot,
        starter: slot !== "Bench" && slot !== "IR",
        // Round to one decimal place. If ESPN has no projection, use 0.
        projected: projection ? Math.round(projection.appliedTotal * 10) / 10 : 0,
      };
    });

    // 6. Add up projected points for starters only (bench points don't count).
    const projectedTotal = players
      .filter((p) => p.starter)
      .reduce((sum, p) => sum + p.projected, 0);

    // 7. Send back the cleaned-up result.
    return Response.json({
      week: week,
      teamName: (myTeam.name || `${myTeam.location} ${myTeam.nickname}`).trim(),
      projectedTotal: Math.round(projectedTotal * 10) / 10,
      players: players,
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 502 });
  }
};
