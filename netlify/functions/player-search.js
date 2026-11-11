// player-search.js
// Behind the Trade Finder tab. Two jobs, picked by the web address:
//
//   /.netlify/functions/player-search?q=tate
//     Search every NFL player in the database by name (or team code).
//     Returns up to 10 matches: id, name, position, team.
//
//   /.netlify/functions/player-search?id=4432773
//     The full data packet for one player, same shape the Trades page uses:
//     trade signals (with backfield share), remaining schedule, consistency.
//     The page runs the same tradeCall rules on it to make the verdict.
//
// Players here don't have to be on a fantasy roster: that's the point. You can
// scout a free agent or a guy in another league's news before anyone adds him.

import { getSupabase } from "../lib/supabase.js";

// The database uses nflverse team codes. ESPN spells two of them differently.
const NFLVERSE_TO_ESPN = { WAS: "WSH", LA: "LAR" };

function fixTeam(code) {
  return NFLVERSE_TO_ESPN[code] || code;
}

// ---------- the same row-to-camelCase mapping the Trades page gets ----------

function mapSignals(row) {
  return {
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
  };
}

function mapShare(row) {
  return {
    playedLast3: row.played_last3,
    lastWeekPlayed: row.last_week_played,
    shareLast3: row.share_last3,
    sharePrior: row.share_prior,
    mateName: row.mate_name,
    mateShareLast3: row.mate_share_last3,
    mateSharePrior: row.mate_share_prior,
  };
}

function mapWeeks(row) {
  const weeks = {};
  for (const g of row?.weeks || []) {
    weeks[g.week] = {
      opp: fixTeam(g.opponent),
      isHome: g.is_home,
      defAllowed: g.def_allowed,
      leagueAllowed: g.league_allowed,
      implied: g.implied,
    };
  }
  return weeks;
}

function mapConsistency(row) {
  return {
    stdev: row.stdev,
    floor: row.floor_ppr,
    ceiling: row.ceil_ppr,
    bestWeek: row.best_week,
    worstWeek: row.worst_week,
    bustPct: row.bust_pct,
    boomPct: row.boom_pct,
  };
}

export default async (request) => {
  const supabase = getSupabase();
  if (!supabase) {
    return Response.json({ error: "Missing the Supabase settings in .env" }, { status: 500 });
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const id = (url.searchParams.get("id") || "").trim();

  try {
    // ---------- search by name or team ----------
    if (q) {
      // Commas and parentheses would break the search filter below.
      const safe = q.replace(/[,()]/g, " ").trim();
      const { data, error } = await supabase
        .from("players")
        .select("espn_id, full_name, position, team")
        .or(`full_name.ilike.%${safe}%,team.ilike.${safe}`)
        .not("espn_id", "is", null)
        .in("position", ["QB", "RB", "WR", "TE"])
        .order("full_name")
        .limit(10);
      if (error) throw new Error(error.message);

      return Response.json({
        matches: data.map((p) => ({
          espnId: p.espn_id,
          name: p.full_name,
          position: p.position,
          nflTeam: fixTeam(p.team),
        })),
      });
    }

    // ---------- the full packet for one player ----------
    if (id) {
      const [player, signals, shares, weeks, consistency] = await Promise.all([
        supabase.from("players").select("espn_id, full_name, position, team").eq("espn_id", id).single(),
        supabase.rpc("get_trade_signals", { espn_ids: [id] }),
        supabase.rpc("get_backfield_share", { espn_ids: [id] }),
        supabase.rpc("get_player_weeks", { espn_ids: [id] }),
        supabase.rpc("get_consistency", { espn_ids: [id] }),
      ]);
      if (player.error) throw new Error(player.error.message);

      const s = signals.data?.[0] ? mapSignals(signals.data[0]) : null;
      const share = shares.data?.[0] ? mapShare(shares.data[0]) : null;

      return Response.json({
        espnId: player.data.espn_id,
        name: player.data.full_name,
        position: player.data.position,
        nflTeam: fixTeam(player.data.team),
        signals: s ? { ...s, ...(share || {}) } : null,
        weeks: weeks.data?.[0] ? mapWeeks(weeks.data[0]) : null,
        consistency: consistency.data?.[0] ? mapConsistency(consistency.data[0]) : null,
      });
    }

    return Response.json({ error: "Add ?q=name to search or ?id= for one player" }, { status: 400 });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 502 });
  }
};
