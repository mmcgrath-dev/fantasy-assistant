// movers.js
// Players who just changed NFL teams (traded or signed) and haven't played a
// game for their new team yet, plus who that affects.
//
// How it spots them: ESPN moves a traded player to his new team right away.
// The database knows the team he played his LAST game for (get_last_teams in
// supabase/22_last_teams.sql). If those two don't match, he just moved.
// After his first game with the new team, the database catches up and he
// drops off this list on his own.
//
// Who it affects:
//   - the player himself: every number he has came with his old team
//   - his new teammates at the same spot: a new receiver (WR or TE) eats into
//     the other receivers' targets, a new back into the other backs' carries

import { NFL_TEAMS, getFromEspn } from "./espn.js";

const POSITIONS = { 2: "RB", 3: "WR", 4: "TE" };
// Receivers compete with each other for targets, backs with each other for carries.
const GROUP = { RB: "RB", WR: "REC", TE: "REC" };
// The database uses nflverse team codes. ESPN spells two of them differently.
const NFLVERSE_TO_ESPN = { WAS: "WSH", LA: "LAR" };

// Returns [{ espnId, name, position, from, to, lastWeek }]. Empty list if
// ESPN or the database says no, so the pages still load without it.
export async function getMovers(settings, week, supabase) {
  if (!settings || !supabase) return [];
  try {
    // ESPN's player list: RBs, WRs and TEs (lineup slots 2, 4 and 6), the 300
    // most rostered, which covers anyone whose move would matter.
    const filter = {
      players: {
        filterSlotIds: { value: [2, 4, 6] },
        limit: 300,
        sortPercOwned: { sortAsc: false, sortPriority: 1 },
      },
    };
    const data = await getFromEspn(
      settings,
      `${settings.leagueUrl}?scoringPeriodId=${week}&view=kona_player_info`,
      { "X-Fantasy-Filter": JSON.stringify(filter) }
    );
    const espnPlayers = (data.players || [])
      .map((entry) => entry.player || {})
      .filter((p) => POSITIONS[p.defaultPositionId] && NFL_TEAMS[p.proTeamId] && NFL_TEAMS[p.proTeamId] !== "FA")
      .map((p) => ({
        espnId: String(p.id),
        name: p.fullName,
        position: POSITIONS[p.defaultPositionId],
        team: NFL_TEAMS[p.proTeamId],
      }));
    if (espnPlayers.length === 0) return [];

    const { data: rows, error } = await supabase.rpc("get_last_teams", {
      espn_ids: espnPlayers.map((p) => p.espnId),
    });
    if (error) {
      console.log("Last teams failed:", error.message);
      return [];
    }
    const lastTeam = {};
    for (const row of rows) {
      lastTeam[row.espn_id] = { team: NFLVERSE_TO_ESPN[row.last_team] || row.last_team, week: row.last_week };
    }

    return espnPlayers
      .filter((p) => lastTeam[p.espnId] && lastTeam[p.espnId].team !== p.team)
      .map((p) => ({ ...p, from: lastTeam[p.espnId].team, to: p.team, lastWeek: lastTeam[p.espnId].week }));
  } catch (err) {
    console.log("Movers failed:", err.message);
    return [];
  }
}

// What a move means for one player:
//   joined:       { from, to } if he's the one who just moved, else null
//   newTeammates: [{ name, position, from }] who just joined his team at his spot
export function movesFor(player, movers) {
  const self = movers.find((m) => m.espnId === player.espnId);
  const group = GROUP[player.position];
  const newTeammates = group
    ? movers
        .filter((m) => m.espnId !== player.espnId && m.to === player.nflTeam && GROUP[m.position] === group)
        .map((m) => ({ name: m.name, position: m.position, from: m.from }))
    : [];
  return {
    joined: self ? { from: self.from, to: self.to } : null,
    newTeammates,
  };
}

// "Keenan Allen (WR, from IND)" or "Keenan Allen and Josh Downs"
export function teammateNames(list) {
  return list.map((m) => `${m.name} (${m.position}, from ${m.from})`).join(" and ");
}
