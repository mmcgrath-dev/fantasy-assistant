// qb.js
// Who's starting at QB for every NFL team THIS week, straight from ESPN.
//
// Why this exists: the database works out each team's QB from play-by-play
// (whoever threw the most passes in the team's last game). That's great for
// spotting a backup who took over, but it can't know about a QB who was just
// traded or named the starter, because he hasn't played a snap there yet.
// ESPN moves traded players to their new team right away, and its weekly
// projections already know who's starting. So for each team, the QB with
// ESPN's highest projection this week is the starter.
//
// applyStarters() then lays that over the database's answer:
//   - same guy                  -> nothing changes
//   - ESPN's starter is the QB who started most of the season (back from
//     injury, say)             -> back to normal, no "new QB" warning
//   - anyone else              -> a new QB this week: qbChangedThisWeek is true,
//     and the guy he's replacing is kept so the page can name him

import { NFL_TEAMS, getFromEspn } from "./espn.js";

// "Fernando Mendoza Jr." and "fernando mendoza" should match.
export function sameName(a, b) {
  const clean = (s) =>
    (s || "")
      .toLowerCase()
      .replace(/[.'’]/g, "")
      .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  return clean(a) !== "" && clean(a) === clean(b);
}

// { "MIN": { name: "Kirk Cousins", projected: 15.2 }, ... } for this week.
// Empty lookup if ESPN says no, so the pages still work without it.
export async function getProjectedStarters(settings, week) {
  // kona_player_info is ESPN's player list (the same one behind its "Players"
  // page). The filter header asks for QBs only (lineup slot 0), the 150 most
  // rostered, which covers every starter and backup worth knowing about.
  const filter = {
    players: {
      filterSlotIds: { value: [0] },
      limit: 150,
      sortPercOwned: { sortAsc: false, sortPriority: 1 },
    },
  };
  try {
    const data = await getFromEspn(
      settings,
      `${settings.leagueUrl}?scoringPeriodId=${week}&view=kona_player_info`,
      { "X-Fantasy-Filter": JSON.stringify(filter) }
    );
    const starters = {};
    for (const entry of data.players || []) {
      const p = entry.player || {};
      if (p.defaultPositionId !== 1) continue; // QBs only
      const team = NFL_TEAMS[p.proTeamId];
      if (!team || team === "FA") continue;
      const projection = (p.stats || []).find(
        (s) => s.statSourceId === 1 && s.statSplitTypeId === 1 && s.scoringPeriodId === week
      );
      const projected = projection ? projection.appliedTotal : 0;
      if (projected <= 0) continue; // no projection = not playing this week
      if (!starters[team] || projected > starters[team].projected) {
        starters[team] = { name: p.fullName, projected: Math.round(projected * 10) / 10 };
      }
    }
    return starters;
  } catch (err) {
    console.log("QB starters failed:", err.message);
    return {};
  }
}

// row: one team's offense row (camelCase, with qbNow / qbSeason / qbChanged /
// qbNowGames from the database). Returns the row with this week's starter laid over it.
export function applyStarter(row, starter) {
  if (!row || !starter || sameName(starter.name, row.qbNow)) {
    return row ? { ...row, qbChangedThisWeek: false } : row;
  }
  if (sameName(starter.name, row.qbSeason)) {
    // The usual starter is back: his season numbers are the right guide again.
    return { ...row, qbNow: starter.name, qbChanged: false, qbChangedThisWeek: false, qbNowGames: row.games };
  }
  return {
    ...row,
    qbPrevious: row.qbNow,
    qbNow: starter.name,
    qbChanged: true,
    qbChangedThisWeek: true,
    qbNowGames: 0,
  };
}
