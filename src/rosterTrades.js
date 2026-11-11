// rosterTrades.js
// Gives every team credit for trades it already made.
//
// The odds (odds.js) judge each team by the scores it has put up. That misses
// a trade made this week: the new players haven't scored for their new team
// yet, so the odds still think it's the old roster. Here's the fix:
//   1. league-odds.js lists every trade that went through on ESPN
//   2. for each team in a trade, its lineup value now vs. its lineup value
//      with the trade undone, using the same numbers as the "+X/wk" on the
//      trade cards (teamValue in tradeEngine.js)
//   3. teamStrengths in odds.js adds that gain on top of the team's scores,
//      and fades it out as the team plays games with its new players, since
//      those scores already include the trade
//
// loadOddsData() is the one place both the Odds page and the title odds on
// trade cards get their data, so the two always start from the same number.

import { tradeCall } from "./tradeCalls.js";
import { offenseInfo } from "./offense.js";
import { addHealth } from "./health.js";
import { teamValue } from "./tradeEngine.js";

function round1(n) {
  return Math.round(n * 10) / 10;
}

// Same build the trade pages do: offenses, health, and every player's call.
function prepareLeague(data) {
  const offenses = {};
  const byeWeeks = {};
  for (const [team, row] of Object.entries(data.offenses || {})) {
    offenses[team] = offenseInfo(team, row);
    byeWeeks[team] = row.byeWeek;
  }
  addHealth(data.teams.flatMap((team) => team.players), byeWeeks, data.week);
  return data.teams.map((team) => ({
    ...team,
    players: team.players.map((p) => {
      const offense = offenses[p.nflTeam] || null;
      return { ...p, offense, byeWeek: byeWeeks[p.nflTeam] ?? null, callInfo: tradeCall(p.signals, p.position, p, offense) };
    }),
  }));
}

// For every team in every trade: how much the trade changed its lineup.
// trades = [{ week, moves: [{ playerId, fromTeamId, toTeamId }] }] from league-odds.js
// Returns [{ teamId, week, gain, got, gave }]. A player who's since been
// dropped can't be valued, so he's left out of the "before" roster.
// QBs, kickers and D/ST don't count, same as the trade math.
export function tradeGains(teams, slots, currentWeek, trades) {
  const rostered = new Map();
  for (const team of teams) for (const p of team.players) rostered.set(p.espnId, p);

  const out = [];
  for (const trade of trades || []) {
    const teamIds = [...new Set(trade.moves.flatMap((m) => [m.fromTeamId, m.toTeamId]))];
    for (const id of teamIds) {
      const team = teams.find((t) => t.id === id);
      if (!team) continue;
      const received = new Set(trade.moves.filter((m) => m.toTeamId === id).map((m) => String(m.playerId)));
      const sent = trade.moves.filter((m) => m.fromTeamId === id).map((m) => String(m.playerId));
      const before = [
        ...team.players.filter((p) => !received.has(p.espnId)),
        ...sent.map((pid) => rostered.get(pid)).filter(Boolean),
      ];
      const gain = teamValue(team.players, slots, currentWeek) - teamValue(before, slots, currentWeek);
      if (Math.abs(gain) < 0.05) continue;
      const nameOf = (pid) => rostered.get(pid)?.name;
      out.push({
        teamId: id,
        week: trade.week,
        gain: round1(gain),
        got: [...received].map(nameOf).filter(Boolean),
        gave: sent.map(nameOf).filter(Boolean),
      });
    }
  }
  return out;
}

let cached = null;

// The odds data with each team's trade credit attached (data.rosterTrades).
// If the rosters can't load, the odds still work, just from scores alone.
export function loadOddsData() {
  if (!cached) {
    cached = (async () => {
      const response = await fetch("/.netlify/functions/league-odds");
      const data = await response.json();
      if (data.error) return { error: data.error };
      if (!data.recentTrades?.length) return { ...data, rosterTrades: [] };
      try {
        const league = await (await fetch("/.netlify/functions/trades")).json();
        if (league.error) return { ...data, rosterTrades: [] };
        const teams = prepareLeague(league);
        return { ...data, rosterTrades: tradeGains(teams, league.slots, league.week, data.recentTrades) };
      } catch {
        return { ...data, rosterTrades: [] };
      }
    })().catch((err) => {
      cached = null; // let the next try start fresh
      return { error: err.message };
    });
  }
  return cached;
}
