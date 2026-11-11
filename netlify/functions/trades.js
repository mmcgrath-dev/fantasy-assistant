// trades.js
// The data behind the Trades page:
//   1. every team in your league, its record, and its full roster, asked from
//      ESPN live each time, so it's always current after waivers and trades
//   2. each RB, WR and TE's sell-high / buy-low numbers from the database
//      (get_trade_signals in supabase/18_trade_signals.sql)
//   3. each running back's share of his team's backfield (get_backfield_share
//      in supabase/20_backfield_share.sql), added to his signals
//   4. every player's remaining schedule with matchup softness (get_player_weeks)
//      and his floor/ceiling (get_consistency), both in supabase/21_player_weeks.sql
//   5. how every NFL offense is playing (get_offense_context in
//      supabase/19_offense_context.sql), keyed by ESPN's team abbreviation,
//      with this week's starting QB from ESPN laid on top (netlify/lib/qb.js)
//   6. who just changed NFL teams, and whose new teammates that affects
//      (netlify/lib/movers.js)
// The page (src/Trades.jsx) turns those numbers into sell / buy / hold calls.
//
// Try it while netlify dev is running:
//   http://localhost:8888/.netlify/functions/trades

import { POSITIONS, NFL_TEAMS, LINEUP_SLOTS, getEspnSettings, getFromEspn } from "../lib/espn.js";
import { getSupabase } from "../lib/supabase.js";
import { getProjectedStarters, applyStarter } from "../lib/qb.js";
import { getMovers, movesFor } from "../lib/movers.js";

// Asks the database for every player's trade signals in one call.
// Returns a lookup of ESPN ID -> signals. Empty lookup if it fails, so the
// rosters still show.
async function getTradeSignals(espnIds) {
  const supabase = getSupabase();
  if (!supabase) return {};

  const { data, error } = await supabase.rpc("get_trade_signals", { espn_ids: espnIds });
  if (error) {
    console.log("Trade signals failed:", error.message);
    return {};
  }

  const signals = {};
  for (const row of data) {
    signals[row.espn_id] = {
      games: row.games,
      pprPerGame: row.ppr_per_game,
      pprLast3: row.ppr_last3,
      pprPrior: row.ppr_prior,
      touchesLast3: row.touches_last3,
      touchesPrior: row.touches_prior,
      snapsLast3: row.snaps_last3,
      snapsPrior: row.snaps_prior,
      redZoneLast3: row.red_zone_last3,
      redZonePrior: row.red_zone_prior,
      tds: row.tds,
      expectedTds: row.expected_tds,
      tdLuck: row.td_luck,
      lastGameWeek: row.last_game_week,
      lastGamePpr: row.last_game_ppr,
      avgBeforeLast: row.avg_before_last,
      // Efficiency and goal-line numbers. tradeCalls.js has rules for these,
      // but they weren't being passed along before, so those rules never ran.
      targetsLast3: row.targets_last3,
      ypcLast3: row.ypc_last3,
      leagueRbYpc: row.league_rb_ypc,
      ryoePerCarry: row.ryoe_per_carry,
      yptLast3: row.ypt_last3,
      leagueYpt: row.league_ypt,
      glShareLast3: row.gl_share_last3,
      glSharePrior: row.gl_share_prior,
      glTeamLast3: row.gl_team_last3,
      glMateName: row.gl_mate_name,
      glMateCount: row.gl_mate_count,
      // games he got hurt in and left early, left out of the numbers above
      shortenedWeeks: row.shortened_weeks || [],
    };
  }
  return signals;
}

// Each RB's share of his team's backfield, keyed by ESPN ID. Empty lookup if
// it fails, so everything else still works.
async function getBackfieldShares(espnIds) {
  const supabase = getSupabase();
  if (!supabase) return {};

  const { data, error } = await supabase.rpc("get_backfield_share", { espn_ids: espnIds });
  if (error) {
    console.log("Backfield share failed:", error.message);
    return {};
  }

  const shares = {};
  for (const row of data) {
    shares[row.espn_id] = {
      playedLast3: row.played_last3,
      lastWeekPlayed: row.last_week_played,
      shareLast3: row.share_last3,
      sharePrior: row.share_prior,
      mateName: row.mate_name,
      mateShareLast3: row.mate_share_last3,
      mateSharePrior: row.mate_share_prior,
    };
  }
  return shares;
}

// The database uses nflverse team codes. ESPN spells two of them differently.
const NFLVERSE_TO_ESPN = { WAS: "WSH", LA: "LAR" };

// Every player's remaining games, keyed by ESPN ID -> { week: game }. The
// database sends one row per player with the games packed in JSON (one row
// per game got cut off by Supabase's 1000-row cap and looked like byes).
async function getPlayerWeeks(espnIds) {
  const supabase = getSupabase();
  if (!supabase) return {};

  const { data, error } = await supabase.rpc("get_player_weeks", { espn_ids: espnIds });
  if (error) {
    console.log("Player weeks failed:", error.message);
    return {};
  }

  const weeks = {};
  for (const row of data) {
    for (const g of row.weeks || []) {
      (weeks[row.espn_id] ||= {})[g.week] = {
        // the database uses nflverse team codes; show ESPN's spelling
        opp: NFLVERSE_TO_ESPN[g.opponent] || g.opponent,
        isHome: g.is_home,
        defAllowed: g.def_allowed,
        leagueAllowed: g.league_allowed,
        implied: g.implied,
      };
    }
  }
  return weeks;
}

// Floor vs ceiling for every player, keyed by ESPN ID.
async function getConsistency(espnIds) {
  const supabase = getSupabase();
  if (!supabase) return {};

  const { data, error } = await supabase.rpc("get_consistency", { espn_ids: espnIds });
  if (error) {
    console.log("Consistency failed:", error.message);
    return {};
  }

  const out = {};
  for (const row of data) {
    out[row.espn_id] = {
      stdev: row.stdev,
      floor: row.floor_ppr,
      ceiling: row.ceil_ppr,
      bestWeek: row.best_week,
      worstWeek: row.worst_week,
      bustPct: row.bust_pct,
      boomPct: row.boom_pct,
    };
  }
  return out;
}

// How every offense is playing, keyed by ESPN team code ("CIN").
// Empty lookup if it fails, so the page still works without it.
async function getOffenses() {
  const supabase = getSupabase();
  if (!supabase) return {};

  const { data, error } = await supabase.rpc("get_offense_context");
  if (error) {
    console.log("Offense context failed:", error.message);
    return {};
  }

  const offenses = {};
  for (const row of data) {
    offenses[NFLVERSE_TO_ESPN[row.team] || row.team] = {
      games: row.games,
      ppgSeason: row.ppg_season,
      ppgLast3: row.ppg_last3,
      ppgPrior: row.ppg_prior,
      leaguePpg: row.league_ppg,
      epaLast3: row.epa_last3,
      epaPrior: row.epa_prior,
      passEpaLast3: row.pass_epa_last3,
      rushEpaLast3: row.rush_epa_last3,
      rzPlaysLast3: row.rz_plays_last3,
      rzPlaysPrior: row.rz_plays_prior,
      playsLast3: row.plays_last3,
      playsPrior: row.plays_prior,
      qbNow: row.qb_now,
      qbSeason: row.qb_season,
      qbChanged: row.qb_changed,
      qbNowGames: row.qb_now_games,
      vegasNext: row.vegas_next,
      vegasGames: row.vegas_games,
      nextOpponents: row.next_opponents
        ? row.next_opponents.replace(/\b(WAS|LA)\b/g, (code) => NFLVERSE_TO_ESPN[code])
        : null,
      byeWeek: row.bye_week,
    };
  }
  return offenses;
}

export default async () => {
  const settings = getEspnSettings();
  if (!settings) {
    return Response.json({ error: "Missing one of the ESPN settings in .env" }, { status: 500 });
  }

  try {
    // 1. What week it is, so rosters are for this week.
    const status = await getFromEspn(settings, `${settings.leagueUrl}?view=mStatus`);
    const week = status.scoringPeriodId;

    // 2. Every team with its roster (mRoster), its name and record (mTeam),
    //    and the league's lineup settings (mSettings: how many RB, WR, TE and
    //    FLEX spots each team starts).
    const league = await getFromEspn(
      settings,
      `${settings.leagueUrl}?view=mRoster&view=mTeam&view=mSettings&scoringPeriodId=${week}`
    );

    // ESPN keys lineup spots by number: 2 = RB, 4 = WR, 6 = TE, 23 = FLEX.
    // 3 (RB/WR) and 5 (WR/TE) are rare combo spots; counted as FLEX here.
    const counts = league.settings?.rosterSettings?.lineupSlotCounts || {};
    // Playoff spots and regular-season length, so the page can tell who's
    // safe, who's chasing, and who needs wins right now.
    const schedule = league.settings?.scheduleSettings || {};
    const season = {
      playoffTeams: schedule.playoffTeamCount ?? 4,
      regularSeasonWeeks: schedule.matchupPeriodCount ?? 14,
    };

    const slots = {
      RB: counts["2"] ?? 2,
      WR: counts["4"] ?? 2,
      TE: counts["6"] ?? 1,
      FLEX: (counts["23"] ?? 1) + (counts["3"] ?? 0) + (counts["5"] ?? 0),
    };

    // 3. Boil each team down to what the Trades page needs.
    const teams = league.teams.map((team) => {
      const record = team.record?.overall || {};
      return {
        id: team.id,
        name: (team.name || `${team.location} ${team.nickname}`).trim(),
        isMine: team.id === settings.teamId,
        wins: record.wins ?? 0,
        losses: record.losses ?? 0,
        ties: record.ties ?? 0,
        pointsFor: Math.round((record.pointsFor ?? 0) * 10) / 10,
        players: (team.roster?.entries || []).map((entry) => {
          const player = entry.playerPoolEntry.player;
          // ESPN's projection for this week (statSourceId 1 = projection,
          // statSplitTypeId 1 = one week). It's what every manager sees in the app.
          const projection = (player.stats || []).find(
            (stat) => stat.statSourceId === 1 && stat.statSplitTypeId === 1 && stat.scoringPeriodId === week
          );
          return {
            espnId: String(player.id),
            name: player.fullName,
            position: POSITIONS[player.defaultPositionId] || "?",
            nflTeam: NFL_TEAMS[player.proTeamId] || "?",
            slot: LINEUP_SLOTS[entry.lineupSlotId] || `Slot ${entry.lineupSlotId}`,
            // How other managers see him: ESPN's weekly projection and where he
            // went in drafts. null when ESPN doesn't have it.
            espnProjection: projection && projection.appliedTotal > 0 ? Math.round(projection.appliedTotal * 10) / 10 : null,
            adp: player.ownership?.averageDraftPosition > 0 ? Math.round(player.ownership.averageDraftPosition) : null,
            // ESPN's injury word: ACTIVE, QUESTIONABLE, DOUBTFUL, OUT, INJURY_RESERVE...
            injuryStatus: player.injuryStatus || "ACTIVE",
          };
        }),
      };
    });

    // 4. Add each player's trade signals (null for QBs, K, D/ST and anyone
    //    with fewer than 4 games).
    const allIds = teams.flatMap((team) => team.players.map((p) => p.espnId));
    //    Offense context is asked for at the same time, since neither needs the other.
    const [signals, offenses, shares, playerWeeks, consistency, starters, movers] = await Promise.all([
      getTradeSignals(allIds),
      getOffenses(),
      getBackfieldShares(allIds),
      getPlayerWeeks(allIds),
      getConsistency(allIds),
      getProjectedStarters(settings, week),
      getMovers(settings, week, getSupabase()),
    ]);
    //    The database only knows who played QB in each team's last game. ESPN
    //    knows who starts THIS week (a QB traded yesterday, say), so its
    //    answer goes on top. See netlify/lib/qb.js.
    for (const team of Object.keys(offenses)) {
      offenses[team] = applyStarter(offenses[team], starters[team]);
    }
    for (const team of teams) {
      for (const player of team.players) {
        const s = signals[player.espnId];
        player.signals = s ? { ...s, ...(shares[player.espnId] || {}) } : null;
        player.weeks = playerWeeks[player.espnId] || null;
        player.consistency = consistency[player.espnId] || null;
        // Just changed teams, or a new teammate at his spot (netlify/lib/movers.js)
        player.moves = movesFor(player, movers);
      }
    }

    // A player who just changed teams may still have his OLD team's schedule
    // (the database's team list can lag a few days). Borrow the schedule of
    // someone at his position on his new team, since they play the same games.
    const allPlayers = teams.flatMap((team) => team.players);
    for (const player of allPlayers) {
      if (!player.moves.joined) continue;
      const mate = allPlayers.find(
        (p) => p !== player && p.nflTeam === player.nflTeam && p.position === player.position && p.weeks && !p.moves.joined
      );
      if (mate) player.weeks = mate.weeks;
    }

    // 5. Your team first, then everyone else by record (best first).
    teams.sort((a, b) => {
      if (a.isMine !== b.isMine) return a.isMine ? -1 : 1;
      return b.wins - a.wins || b.pointsFor - a.pointsFor;
    });

    return Response.json({ week, slots, season, teams, offenses });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 502 });
  }
};
