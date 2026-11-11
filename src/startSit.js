// startSit.js
// Works out your best lineup for this week and explains every call.
//
// Every player gets a "start score": the points we think he scores THIS week.
// It's built from two opinions, half and half:
//
//   1. ESPN's projection for this week (what every manager sees in the app)
//   2. Our own number, built from the database:
//        - his rest-of-season value from tradeCall (tradeCalls.js): recent
//          points with TD luck taken out, bad efficiency and lost goal-line
//          work counted. Players without one (QBs, guys with under 4 games)
//          use his game log instead: half last 3 games, half season.
//        - bent up or down by how many points this week's defense gives up
//          to his position (capped at 20% either way)
//        - plus half of his Matchup box edge (where he gets the ball vs where
//          this defense is weak), since that's a sharper look at the same game
//        - nudged by what Vegas expects his team to score (capped at 10%)
//        - nudged 5% by his role trend (Role ▲ / Role ▼ from the Why box)
//
// Then injuries and byes:
//   BYE, Out, IR, suspended = can't start
//   Doubtful = 40% of his score, Questionable = 90%
//   New QB this week, a trade to a new team, or a new teammate at his spot =
//   ESPN's projection counts 75% instead of half, since our numbers came
//   before the change and ESPN's already know about it
//   No ESPN projection while "healthy" = probably hurt or inactive, so half
//   his score and a warning. (A blank projection is a red flag, learned the hard way.)
//
// The best lineup fills RB, WR and TE spots with the top scorers at each
// position, then FLEX with the best one left. That's the same way ESPN's own
// lineup works, and with these slots it always finds the best total.
//
// Each starter also gets a confidence call: how far he's ahead of the best guy
// on your bench who could play that spot.
//   Under 1 point = coin flip, 1 to 3 = lean, over 3 = clear.

import { buildWhy } from "./why.js";
import { injurySummary, describeReport } from "./injury.js";

const ESPN_WEIGHT = 0.5;      // how much ESPN's projection counts vs ours
const NEW_QB_ESPN_WEIGHT = 0.75; // ...when his team has a new QB this week
const SOFT_CAP = 0.2;         // defense softness bends our number at most 20%
const AREA_WEIGHT = 0.5;      // how much of the Matchup box edge to add
const VEGAS_CAP = 0.1;        // Vegas team total bends our number at most 10%
const VEGAS_NOTE = 3;         // mention Vegas when the team total is 3+ points off average
const ROLE_NUDGE = 0.05;      // Role ▲ / Role ▼ moves our number 5%
const QUESTIONABLE = 0.9;
const DOUBTFUL = 0.4;
const NO_PROJECTION = 0.5;
const COIN_FLIP = 1;
const LEAN = 3;

const CANT_START = { BYE: "On bye", O: "Out", IR: "On IR", SSPD: "Suspended" };
const FLEX_OK = ["RB", "WR", "TE"];

function round1(n) {
  return Math.round(n * 10) / 10;
}

function avg(values) {
  const v = values.filter((x) => x != null);
  if (v.length === 0) return null;
  return v.reduce((s, x) => s + x, 0) / v.length;
}

// Our "per game" number for players without a tradeCall rating (QBs, rookies,
// anyone under 4 games): half his last 3 games, half his season.
function formFromLog(gameLog) {
  if (!gameLog || gameLog.length === 0) return null;
  const season = avg(gameLog.map((g) => g.points));
  const last3 = avg(gameLog.slice(0, 3).map((g) => g.points));
  if (season == null) return null;
  return 0.5 * (last3 ?? season) + 0.5 * season;
}

function pct(factor) {
  const p = Math.round((factor - 1) * 100);
  return `${p > 0 ? "+" : ""}${p}%`;
}

// Scores one player for this week.
//   p: a roster player with the extras merged in (callInfo, weeks, offense row...)
//   week: this week
// Returns { score, espn, ours, canStart, blocked, opp, reasons, warnings, verdict }
export function scorePlayer(p, week) {
  const reasons = [];
  const warnings = [];

  const game = p.weeks ? p.weeks[week] : null;
  const opp = game ? `${game.isHome ? "vs" : "@"} ${game.opp}` : null;

  // Can he play at all?
  const blocked = CANT_START[p.status] || null;
  if (blocked) {
    return { score: 0, espn: null, ours: null, canStart: false, blocked, opp, reasons: [`${blocked} this week.`], warnings: [], verdict: null };
  }

  const espn = p.projected > 0 ? p.projected : null;

  // ---------- our number ----------
  const base = p.callInfo ? p.callInfo.value : formFromLog(p.gameLog);
  let ours = null;
  const pieces = [];
  if (base != null) {
    ours = base;
    pieces.push(`${round1(base)} a game`);

    if (game && game.defAllowed != null && game.leagueAllowed > 0) {
      const factor = Math.max(1 - SOFT_CAP, Math.min(1 + SOFT_CAP, game.defAllowed / game.leagueAllowed));
      ours *= factor;
      if (Math.abs(factor - 1) >= 0.05) {
        pieces.push(`${factor > 1 ? "soft" : "tough"} defense for ${p.position}s (${pct(factor)})`);
      }
    }

    const m = p.matchup && p.matchup.week === week ? p.matchup : null;
    if (m && m.edgePerGame != null) {
      ours += AREA_WEIGHT * m.edgePerGame;
      if (Math.abs(m.edgePerGame) >= 0.4) {
        pieces.push(`${m.edgePerGame > 0 ? "good" : "bad"} fit where he gets the ball (${m.edgePerGame > 0 ? "+" : ""}${round1(AREA_WEIGHT * m.edgePerGame)})`);
      }
    }

    const leaguePpg = p.offenseRow?.leaguePpg;
    if (game && game.implied != null && leaguePpg) {
      const raw = 1 + 0.5 * (game.implied / leaguePpg - 1);
      const factor = Math.max(1 - VEGAS_CAP, Math.min(1 + VEGAS_CAP, raw));
      ours *= factor;
      const gap = game.implied - leaguePpg;
      if (Math.abs(gap) >= VEGAS_NOTE) {
        reasons.push(
          `Vegas has ${p.nflTeam} scoring about ${round1(game.implied)}, ${gap > 0 ? "well above" : "well below"} the ${round1(leaguePpg)} league average.`
        );
      }
    }
  }

  // Role trend and injury report, same rules as the Why box on My Team.
  const injury = injurySummary(p.injuries, p.gameLog || [], week);
  const why = p.roleContext ? buildWhy(p.roleContext, injury, p.qb, p.moves) : { verdict: null, tag: null };
  if (ours != null && why.tag) {
    if (why.tag.label === "Role ▲") ours *= 1 + ROLE_NUDGE;
    if (why.tag.label === "Role ▼") ours *= 1 - ROLE_NUDGE;
  }

  if (ours != null) {
    reasons.unshift(`Our number: ${round1(ours)} (${pieces.join(", ")}).`);
  } else if (FLEX_OK.includes(p.position) || p.position === "QB") {
    reasons.unshift("Not enough games in the database for our own number, so this is ESPN's.");
  }
  if (espn != null) reasons.unshift(`ESPN projects ${espn}.`);

  // ---------- blend ----------
  // New QB this week: our number is built on games with the old QB, while
  // ESPN's projection already knows about the switch, so ESPN counts more.
  const newQb = p.qb && p.qb.thisWeek && p.qb.previous;
  if (newQb) {
    warnings.push(`New QB this week: ${p.qb.now} takes over for ${p.qb.previous}. ESPN's projection counts extra since our numbers came with ${p.qb.previous}.`);
  }
  // Same when he just changed teams, or someone just joined his team at his spot.
  const moves = p.moves || {};
  const newMates = moves.newTeammates || [];
  if (moves.joined) {
    warnings.push(`Just traded to ${moves.joined.to} from ${moves.joined.from}. ESPN's projection counts extra since our numbers came with his old team.`);
  } else if (newMates.length > 0) {
    const who = newMates.map((m) => m.name).join(" and ");
    warnings.push(`${who} just joined ${p.nflTeam} at his spot. ESPN's projection counts extra since our numbers came before that.`);
  }
  // Missed games lately (health.js): his recent numbers include time he wasn't
  // out there, and he may not be all the way back.
  const health = p.health;
  if (health && health.missed >= 1) {
    const weeks = health.missedWeeks.join(", ");
    warnings.unshift(
      `Hasn't played since Week ${health.lastGame} (missed ${health.missed === 1 ? `Week ${weeks}` : `Weeks ${weeks}`}). Make sure he's really back before starting him.`
    );
  }

  const fresh = newQb || moves.joined || newMates.length > 0;
  const espnWeight = fresh ? NEW_QB_ESPN_WEIGHT : ESPN_WEIGHT;

  let score;
  if (espn != null && ours != null) score = espnWeight * espn + (1 - espnWeight) * ours;
  else score = espn ?? ours ?? 0;

  // ---------- injuries ----------
  if (p.status === "D") {
    score *= DOUBTFUL;
    warnings.push(`Doubtful${injury?.thisWeek ? `: ${describeReport(injury.thisWeek)}` : ""}. Doubtful players almost never play.`);
  } else if (p.status === "Q") {
    score *= QUESTIONABLE;
    warnings.push(`Questionable${injury?.thisWeek ? `: ${describeReport(injury.thisWeek)}` : ""}. Check Saturday's report.`);
  } else if (espn == null && game) {
    score *= NO_PROJECTION;
    warnings.push("ESPN has no projection for him. He may be hurt or inactive, so check before starting him.");
  }

  if (why.verdict && p.position !== "QB") reasons.push(why.verdict);

  return {
    score: round1(score),
    espn,
    ours: ours == null ? null : round1(ours),
    canStart: true,
    blocked: null,
    opp,
    reasons,
    warnings,
    verdict: why.verdict,
    floor: p.consistency?.floor ?? null,
    ceiling: p.consistency?.ceiling ?? null,
  };
}

// Which bench players could fill a slot.
function fits(slot, position) {
  if (slot === "FLEX") return FLEX_OK.includes(position);
  return slot === position;
}

function confidence(margin) {
  if (margin == null) return { label: "Locked in", tone: "none" };
  if (margin < COIN_FLIP) return { label: "Coin flip", tone: "warn" };
  if (margin < LEAN) return { label: "Lean", tone: "lean" };
  return { label: "Clear", tone: "good" };
}

// For a coin flip: the steadier guy if you're favored, the boom guy if you're not.
function tiebreak(a, b) {
  if (a.sit.floor == null || b.sit.floor == null || a.sit.ceiling == null || b.sit.ceiling == null) return null;
  const steadier = a.sit.floor >= b.sit.floor ? a : b;
  const boomier = a.sit.ceiling >= b.sit.ceiling ? a : b;
  if (steadier === boomier) {
    return `${steadier.name} has both the higher floor (${steadier.sit.floor}) and ceiling (${steadier.sit.ceiling}). Go with him.`;
  }
  return (
    `If you're favored this week, take the safer floor: ${steadier.name} (bad week ${steadier.sit.floor}). ` +
    `If you're the underdog, swing for ${boomier.name}'s ceiling (good week ${boomier.sit.ceiling}).`
  );
}

// The whole page's answer.
//   players: your roster, each already scored (p.sit = scorePlayer(...))
//   slots:   { QB, RB, WR, TE, FLEX, "D/ST", K }
export function buildLineup(players, slots) {
  const pool = players.filter((p) => p.sit.canStart).sort((a, b) => b.sit.score - a.sit.score);
  const used = new Set();
  const lineup = [];

  for (const slot of ["QB", "RB", "WR", "TE", "FLEX", "D/ST", "K"]) {
    for (let i = 0; i < (slots[slot] || 0); i++) {
      const pick = pool.find((p) => !used.has(p.espnId) && fits(slot, p.position));
      if (pick) used.add(pick.espnId);
      lineup.push({ slot, player: pick || null });
    }
  }

  const bench = players.filter((p) => !used.has(p.espnId)).sort((a, b) => b.sit.score - a.sit.score);

  // Confidence: each starter vs the best healthy bench player who could take his spot.
  for (const row of lineup) {
    if (!row.player) continue;
    const alt = bench.find((b) => b.sit.canStart && fits(row.slot, b.position));
    row.alt = alt || null;
    row.margin = alt ? round1(row.player.sit.score - alt.sit.score) : null;
    row.confidence = confidence(row.margin);
    if (alt && row.margin < COIN_FLIP) row.tiebreak = tiebreak(row.player, alt);
  }

  // Why each bench guy sits: who beat him out.
  for (const b of bench) {
    if (!b.sit.canStart) {
      b.sitReason = b.sit.blocked;
      continue;
    }
    const rival = [...lineup].reverse().find((r) => r.player && fits(r.slot, b.position));
    b.sitReason = rival
      ? `${rival.player.name} is ahead by ${round1(rival.player.sit.score - b.sit.score)}.`
      : "No open spot at his position.";
  }

  const total = round1(lineup.reduce((s, r) => s + (r.player ? r.player.sit.score : 0), 0));
  return { lineup, bench, total };
}

// What to change from the lineup you have set on ESPN right now.
// Pairs each player coming in with one going out (same position first).
export function lineupMoves(players, best) {
  const recommended = new Set(best.lineup.filter((r) => r.player).map((r) => r.player.espnId));
  const current = players.filter((p) => p.starter);
  const ins = players.filter((p) => recommended.has(p.espnId) && !p.starter).sort((a, b) => b.sit.score - a.sit.score);
  const outs = current.filter((p) => !recommended.has(p.espnId));

  const moves = [];
  for (const p of ins) {
    let i = outs.findIndex((o) => o.position === p.position);
    if (i === -1) i = 0;
    const out = outs.splice(i, 1)[0] || null;
    moves.push({ start: p, sit: out, gain: round1(p.sit.score - (out ? out.sit.score : 0)) });
  }
  // Starters to pull with nobody better to put in (empty spot on the bench).
  for (const o of outs) moves.push({ start: null, sit: o, gain: 0 });

  const currentTotal = round1(current.reduce((s, p) => s + p.sit.score, 0));
  return { moves, currentTotal };
}

// Where we are in the week, for the banner at the top. The data loads Tuesday
// morning after Monday night's game, and the injury reports reload Saturday.
export function weekTiming(date = new Date()) {
  const day = date.getDay(); // 0 = Sunday
  if (day >= 2 && day <= 5) {
    return {
      title: "Wednesday call",
      note: "Built on Tuesday's data load. Practice reports change all week and the app reloads them Saturday morning, so check back then for the final call.",
    };
  }
  if (day === 6 || day === 0) {
    return {
      title: "Final call",
      note: "Saturday's injury reports are in. For coin flips, check inactives about 90 minutes before kickoff.",
    };
  }
  return {
    title: "Last week's lineup",
    note: "Monday: this week is almost done. Next week's call is ready Wednesday after Tuesday's data load.",
  };
}
