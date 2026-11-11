// tradeCalls.js
// Turns a player's trade signals (from get_trade_signals in the database) into
// a call (sell high, sell low, hold, or buy) with plain-English reasons, plus
// two value estimates the trade finder uses. Same idea as why.js: simple rules
// you can read and tweak, not AI.
//
// Each rule adds points toward "sell" or toward "buy". The side with more
// points wins; a close call is a hold.
//
// The big lesson baked in here: VOLUME ISN'T VALUE. More carries only matter
// if he's doing something with them, and "he's due for TDs" only holds if he's
// still the one getting the ball near the goal line.

// How big a change has to be before it counts. Bigger numbers = pickier calls.
const TD_LUCK = 1.5;          // TDs above or below expected
const POINTS_JUMP = 0.25;     // points up 25%+ over his last 3 games
const USAGE_JUMP = 0.15;      // touches up 15%+
const USAGE_DROP = 0.25;      // touches down 25%+
const SNAP_MOVE = 8;          // snap % up or down 8+ points
const BOOM = 10;              // last game 10+ points over his average
const YPC_BAD = 0.9;          // yards per carry this far under the league RB average = inefficient
const YPC_GOOD = 0.8;         // this far over = efficient
const RYOE_BAD = -0.4;        // rush yards over expected per carry
const YPT_BAD = 2.5;          // receiving yards per target this far under his position's average
const GL_SWING = 25;          // goal-line share up or down 25+ points
const GL_MIN_PLAYS = 4;       // need at least this many team plays inside the 5 to judge it
const RB_TARGETS = 4.5;       // a back with this many targets a game has a real PPR floor
const BUSTY = 30;             // 30%+ of his games under half his average = boom-or-bust
const STEADY_STDEV = 4.5;     // a typical week lands within this of his average = steady
const SHARE_SWING = 15;       // backfield share (% of his team's RB touches) up or down 15+ points
const MIN_PRIOR_GAMES = 2;    // need this many games before his last 3 to call anything a change
const EARLY_PICK = 36;        // drafted this early (about the first 3 to 4 rounds of a 10-team draft) = an early-round guy
const EARLY_SELL_LOW = 5;     // an early-round guy needs this much "sell" (vs 2 for everyone else) before we say sell low

// Players worth talking about in a trade.
const MIN_PPR = 8;            // points per game this season
const MIN_TOUCHES = 10;       // or touches per game lately

function pctChange(now, before) {
  if (now == null || before == null || before === 0) return null;
  return (now - before) / before;
}

function tdWord(n) {
  return `${n} ${n === 1 ? "TD" : "TDs"}`;
}

function workWords(touchChange) {
  if (touchChange == null) return "the same work";
  if (touchChange <= -0.1) return "less work";
  if (touchChange < 0.1) return "about the same work";
  return "only a little more work";
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

import { cantTradeFor } from "./health.js";

// ---------- what other managers think he's worth ----------
//
// Real managers don't only look at recent points. They look at the ESPN app's
// projection and remember where a guy went in the draft: nobody gives up a
// first-round pick because he had a quiet month. So "market value" blends:
//   40% his points (half season, half last 3 games)
//   30% ESPN's projection for this week
//   30% his draft position, turned into points per game:
//        pick 1 ~ 24/wk, pick 12 ~ 21, pick 24 ~ 18, pick 50 ~ 14, pick 100 ~ 10
// If ESPN is missing one of those, the others share its weight.
export function adpToPoints(adp) {
  return 7 + 17 * Math.exp(-adp / 55);
}

export function marketValueOf(points, espn = {}) {
  const parts = [{ value: points, weight: 0.4 }];
  if (espn.espnProjection != null) parts.push({ value: espn.espnProjection, weight: 0.3 });
  if (espn.adp != null) parts.push({ value: adpToPoints(espn.adp), weight: 0.3 });
  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  return parts.reduce((sum, p) => sum + p.value * p.weight, 0) / totalWeight;
}

// Returns {
//   call:        "sell" | "buy" | "hold"
//   label:       "Sell high" | "Sell low" | "Hold" | "Buy" | "Out"   (what the page shows)
//   strength:    how far the winning side was ahead (1 = mild, 4+ = strong)
//   reasons:     sentences, winning side first
//   worthIt:     false for low-scoring depth guys
//   value:       our estimate of his points per game the rest of the way
//   marketValue: what other managers probably think he's worth (see marketValueOf)
// }
//
// espn = { espnProjection, adp, consistency } from trades.js (any can be null)
// offense = his NFL team from offenseInfo (offense.js), or null
//
// How the offense changes things:
//   - TD luck on a rolling offense (Higgins with Burrow) is partly real, not
//     all luck: the sell reason counts half as much and less of his TDs get
//     taken out of his value.
//   - "He's due for TDs" on a struggling offense is less likely to pay off,
//     so that buy reason counts half as much too.
//   - A new QB gets a note, since most of his numbers came with someone else.
export function tradeCall(s, position, espn = {}, offense = null) {
  if (!s) return null;

  const sell = [];
  const buy = [];
  const isRB = position === "RB";

  const pointsChange = pctChange(s.pprLast3, s.pprPrior);
  const touchChange = pctChange(s.touchesLast3, s.touchesPrior);
  const snapChange = s.snapsLast3 != null && s.snapsPrior != null ? s.snapsLast3 - s.snapsPrior : null;
  const usageFlatOrDown = touchChange == null || touchChange < USAGE_JUMP;

  // ---------- Is he doing anything with the ball? ----------
  // Checked first, because it changes how much the volume rules below count.
  let inefficient = false;
  if (isRB && s.ypcLast3 != null && s.leagueRbYpc != null && s.ypcLast3 <= s.leagueRbYpc - YPC_BAD) {
    inefficient = true;
    const ryoe = s.ryoePerCarry != null && s.ryoePerCarry <= RYOE_BAD
      ? ` and ${s.ryoePerCarry} rush yards over expected per carry`
      : "";
    sell.push({
      weight: 3,
      kind: "efficiency",
      text: `Doing little with his carries: ${s.ypcLast3} yards a carry over his last 3 (league RB average ${s.leagueRbYpc})${ryoe}. Backs this inefficient usually lose work.`,
    });
  } else if (!isRB && s.yptLast3 != null && s.leagueYpt != null && s.yptLast3 <= s.leagueYpt - YPT_BAD && s.touchesLast3 >= 4) {
    inefficient = true;
    sell.push({
      weight: 2,
      kind: "efficiency",
      text: `Not producing on his targets: ${s.yptLast3} yards per target over his last 3 (${position} average ${s.leagueYpt}).`,
    });
  } else if (isRB && s.ypcLast3 != null && s.leagueRbYpc != null && s.ypcLast3 >= s.leagueRbYpc + YPC_GOOD) {
    buy.push({
      weight: 1,
      kind: "efficiency",
      text: `Making the most of his carries: ${s.ypcLast3} yards a carry over his last 3 (league RB average ${s.leagueRbYpc}).`,
    });
  }

  // Volume-based buy reasons count less when he's inefficient: that volume may not last.
  const volumeWeight = inefficient ? 1 : 2;

  // ---------- Goal-line role ----------
  const glJudgeable =
    s.glTeamLast3 != null &&
    s.glTeamLast3 >= GL_MIN_PLAYS &&
    s.glShareLast3 != null &&
    s.glSharePrior != null &&
    s.games - 3 >= MIN_PRIOR_GAMES; // "0% before" means nothing if "before" is one game
  const glLost = glJudgeable && s.glSharePrior - s.glShareLast3 >= GL_SWING;
  const glGained = glJudgeable && s.glShareLast3 - s.glSharePrior >= GL_SWING;
  if (glLost) {
    const mate = s.glMateName ? ` ${s.glMateName} got ${s.glMateCount} of those.` : "";
    sell.push({
      weight: 2,
      kind: "goalLine",
      text: `Losing goal-line work: ${s.glSharePrior}% → ${s.glShareLast3}% of his team's plays inside the 5.${mate}`,
    });
  } else if (glGained) {
    buy.push({
      weight: volumeWeight,
      kind: "goalLine",
      text: `Taking over near the goal line: ${s.glSharePrior}% → ${s.glShareLast3}% of his team's plays inside the 5.`,
    });
  }

  // ---------- Backfield share (backs only) ----------
  // His share of his TEAM's running back touches, measured over his team's
  // games. Catches two things his own numbers miss:
  //   - he's been out, and someone else had the job in the meantime
  //   - a teammate is eating into his work even though his touches look steady
  let absent = false;
  let shareDrop = false;
  const mate = s.mateName && s.mateShareLast3 != null
    ? ` ${s.mateName} has ${s.mateShareLast3}% lately${s.mateSharePrior != null ? ` (was ${s.mateSharePrior}%)` : ""}.`
    : "";
  let jobAtRisk = false; // a back who's been out while someone else had the job
  if (isRB && s.playedLast3 != null && s.playedLast3 <= 1) {
    absent = true;
    jobAtRisk = Boolean(s.mateName);
    const since = s.lastWeekPlayed != null ? `since Week ${s.lastWeekPlayed}` : "lately";
    sell.push({
      weight: 0,
      kind: "absent",
      text: `Hasn't really played ${since} (${s.playedLast3} of his team's last 3 games).${mate} His old numbers don't tell us what his job will be when he's back.`,
    });
  } else if (espn.health && (espn.health.level === "missing" || (espn.health.level === "out" && espn.health.missed >= 2))) {
    // Every position: he's missed 2+ of his team's games in a row (health.js).
    // This used to only work for running backs, so a receiver who hadn't
    // played in weeks still looked like his old healthy self.
    absent = true;
    sell.push({ weight: 0, kind: "absent", text: espn.health.line });
  } else if (isRB && s.shareLast3 != null && s.sharePrior != null && s.games - 3 >= MIN_PRIOR_GAMES) {
    if (s.sharePrior - s.shareLast3 >= SHARE_SWING) {
      shareDrop = true;
      sell.push({
        weight: 2,
        kind: "share",
        text: `Losing the backfield: ${s.sharePrior}% → ${s.shareLast3}% of his team's RB touches.${mate}`,
      });
    } else if (s.shareLast3 - s.sharePrior >= SHARE_SWING) {
      buy.push({
        weight: volumeWeight,
        kind: "share",
        text: `Taking over the backfield: ${s.sharePrior}% → ${s.shareLast3}% of his team's RB touches.`,
      });
    }
  }

  // ---------- TD luck ----------
  // How much of his TD luck to take out of his value. Less when his offense
  // explains it (see the notes at the top of tradeCall).
  let luckRemoved = 0.75;
  const vegasWords = offense?.hasVegas ? ` and Vegas expects about ${offense.ahead} next` : "";

  if (s.tdLuck >= TD_LUCK) {
    if (offense?.strong) {
      luckRemoved = 0.4;
      sell.push({
        weight: 1,
        kind: "luck",
        text: `${tdWord(s.tds)} on ${s.expectedTds} expected, but the ${offense.name} are scoring ${offense.recent} a game lately${vegasWords}. Some of that is real, so expect a smaller cool-off.`,
      });
    } else {
      sell.push({ weight: 2, kind: "luck", text: `${tdWord(s.tds)} on ${s.expectedTds} expected. TDs like that usually cool off.` });
    }
  } else if (s.tdLuck <= -TD_LUCK) {
    if (glLost) {
      // Not bad luck if he isn't getting the goal-line chances anymore.
      sell.push({
        weight: 0,
        kind: "luck",
        text: `He has ${tdWord(s.tds)} on ${s.expectedTds} expected, but don't count on those coming back while someone else gets the goal-line work.`,
      });
    } else if (offense?.weak) {
      const have = s.tds === 0 ? "No TDs yet" : `Only ${tdWord(s.tds)}`;
      luckRemoved = 0.4;
      buy.push({
        weight: volumeWeight / 2,
        kind: "luck",
        text: `${have} on ${s.expectedTds} expected, but the ${offense.name} are only scoring ${offense.recent} a game lately${vegasWords}. Don't count on all of those coming.`,
      });
    } else {
      const have = s.tds === 0 ? "No TDs yet" : `Only ${tdWord(s.tds)}`;
      buy.push({
        weight: volumeWeight,
        kind: "luck",
        text: `${have} on ${s.expectedTds} expected from where he gets the ball. They should come.`,
      });
    }
  }

  // ---------- Points jumped without the work ----------
  if (pointsChange != null && pointsChange >= POINTS_JUMP && usageFlatOrDown) {
    sell.push({
      weight: 2,
      kind: "pointsJump",
      text: `Scoring ${s.pprPrior} → ${s.pprLast3} a game, but on ${workWords(touchChange)} (${s.touchesPrior} → ${s.touchesLast3} touches).`,
    });
  }

  // ---------- Role growing (only the parts that actually grew) ----------
  const touchesUp = touchChange != null && touchChange >= USAGE_JUMP;
  const snapsUp = snapChange != null && snapChange >= SNAP_MOVE;
  if ((touchesUp || snapsUp) && (pointsChange == null || pointsChange < POINTS_JUMP)) {
    const grew = [];
    if (touchesUp) grew.push(`${s.touchesPrior} → ${s.touchesLast3} touches`);
    if (snapsUp) grew.push(`${s.snapsPrior}% → ${s.snapsLast3}% snaps`);
    const caveat = inefficient
      ? " But the extra work isn't turning into much, so it may not last."
      : " The points haven't caught up yet.";
    buy.push({ weight: volumeWeight, kind: "roleUp", text: `Role growing: ${grew.join(" and ")}.${caveat}` });
  }

  // ---------- Role shrinking ----------
  if (touchChange != null && touchChange <= -USAGE_DROP && snapChange != null && snapChange <= -SNAP_MOVE) {
    sell.push({
      weight: 2,
      kind: "roleDown",
      text: `Role shrinking: ${s.touchesPrior} → ${s.touchesLast3} touches and ${s.snapsPrior}% → ${s.snapsLast3}% snaps.`,
    });
  }

  // ---------- Passing-game floor for backs ----------
  if (isRB && s.targetsLast3 != null && s.targetsLast3 >= RB_TARGETS) {
    buy.push({
      weight: 1,
      kind: "rbTargets",
      text: `Still a real part of the passing game (${s.targetsLast3} targets a game lately), which keeps a PPR floor even if the carries dry up.`,
    });
  }

  // ---------- Boom week ----------
  if (s.lastGamePpr != null && s.avgBeforeLast != null && s.lastGamePpr - s.avgBeforeLast >= BOOM && usageFlatOrDown) {
    sell.push({
      weight: 1,
      kind: "boom",
      text: `Coming off ${s.lastGamePpr} points in Week ${s.lastGameWeek} (he averaged ${s.avgBeforeLast} before). His value won't be higher than right now.`,
    });
  }

  // ---------- Red zone work rising ----------
  if (!glGained && s.redZoneLast3 != null && s.redZonePrior != null && s.redZoneLast3 - s.redZonePrior >= 1) {
    buy.push({
      weight: 1,
      kind: "redZone",
      text: `More red zone work: ${s.redZonePrior} → ${s.redZoneLast3} chances inside the 20 a game.`,
    });
  }

  // ---------- The call ----------
  const sellPoints = sell.reduce((sum, r) => sum + r.weight, 0);
  const buyPoints = buy.reduce((sum, r) => sum + r.weight, 0);
  const net = buyPoints - sellPoints;

  let call = "hold";
  if (net >= 2) call = "buy";
  else if (net <= -2) call = "sell";

  // Sell HIGH = his points are inflated (luck, a boom, points ahead of usage).
  // Sell LOW = his role or efficiency is fading; get something before it fades more.
  const highKinds = ["luck", "pointsJump", "boom"];
  const sellHighPoints = sell.filter((r) => highKinds.includes(r.kind)).reduce((sum, r) => sum + r.weight, 0);
  let label = "Hold";
  if (call === "sell") label = sellHighPoints >= sellPoints - sellHighPoints ? "Sell high" : "Sell low";
  if (call === "buy") label = "Buy";

  // Out lately: we can't call it either way until he's back and we see his role.
  if (absent) {
    call = "hold";
    label = "Out";
  }

  // Early-round guys: one bad stretch isn't enough to sell low. The rest of
  // the league still sees a first-rounder, and selling him at his lowest
  // point is how you lose a trade. Only sell low when the case is strong.
  let earlyPickNote = null;
  if (label === "Sell low" && espn.adp != null && espn.adp <= EARLY_PICK && -net < EARLY_SELL_LOW) {
    call = "hold";
    label = "Hold";
    earlyPickNote = `He went around pick ${espn.adp} in drafts. Selling a guy like that after a bad 3-game stretch usually means selling at his lowest, so hold unless it keeps going.`;
  }

  const byWeight = (a, b) => b.weight - a.weight;
  const main = call === "sell" ? sell : call === "buy" ? buy : [...sell, ...buy];
  const other = call === "sell" ? buy : call === "buy" ? sell : [];
  const reasons = [
    ...(earlyPickNote ? [earlyPickNote] : []),
    ...main.sort(byWeight).map((r) => r.text),
    ...other.sort(byWeight).map((r) => `On the other hand: ${r.text.charAt(0).toLowerCase()}${r.text.slice(1)}`),
  ];

  // When he's been out, that's the only thing worth saying: his other trends
  // come from games before the injury.
  if (absent) {
    reasons.splice(0, reasons.length, sell.find((r) => r.kind === "absent").text);
  }

  // Warning signs about his role, even when the call is a hold. The trade
  // finder flags these when you'd be getting him, and wants a bigger gain.
  const roleKinds = ["share", "roleDown", "goalLine", "efficiency"];
  const warnings = sell.filter((r) => roleKinds.includes(r.kind) && r.weight > 0).map((r) => r.text);

  // A QB change doesn't push the call either way, but it's worth knowing:
  // most of his numbers came with a different QB.
  // Missed his last game, Doubtful, or no ESPN projection: worth saying up front.
  if (!absent && espn.health && (espn.health.level === "risky" || espn.health.level === "watch")) {
    reasons.unshift(`${espn.health.level === "risky" ? "Injury warning" : "Health"}: ${espn.health.line}`);
  }

  // Same idea when HE just changed teams, or a new teammate just arrived at
  // his spot: his numbers came before the move.
  const moves = espn.moves || {};
  const newMates = moves.newTeammates || [];
  if (moves.joined) {
    reasons.push(
      `Heads up: just traded to ${moves.joined.to} from ${moves.joined.from}. Every number here came with his old team, so ESPN's projection counts extra in his value.`
    );
  } else if (newMates.length > 0) {
    const who = newMates.map((m) => `${m.name} (${m.position}, from ${m.from})`).join(" and ");
    const what = position === "RB" ? "carries" : "targets";
    reasons.push(
      `Heads up: ${who} just joined ${espn.nflTeam}. Expect fewer ${what} to go around, and his numbers all came before that. ESPN's projection already knows, so it counts extra in his value.`
    );
  }
  if (offense?.qbThisWeek) {
    reasons.push(
      `Heads up: new QB this week. ${offense.qbNow} takes over for ${offense.qbPrevious}, so every number here came with someone else. ESPN's projection already knows about the switch, so it counts extra in his value.`
    );
  } else if (offense?.qbNew) {
    reasons.push(
      `Heads up: ${offense.qbNow} has only started the last ${offense.qbNowGames === 1 ? "game" : `${offense.qbNowGames} games`}. Most of these numbers came with ${offense.qbSeason}.`
    );
  }

  // ---------- Value estimates (points per game, rest of season) ----------
  // Ours: half his last 3 games, half the games before; take out most of his
  // TD luck (less of it when his offense explains it; none of the missing TDs
  // get added back if he lost the goal-line role); knock a point off backs
  // doing nothing with their carries.
  const recent = s.pprLast3 ?? s.pprPerGame;
  const before = s.pprPrior ?? s.pprPerGame;
  // Losing the backfield = the recent games are the better guide.
  let value = shareDrop ? 0.75 * recent + 0.25 * before : 0.5 * recent + 0.5 * before;
  // ESPN's projection as a second opinion, so one weird 3-game stretch can't
  // swing his value too far on its own. After a QB change his own numbers
  // came with someone else, while ESPN's projection already knows about the
  // switch, so ESPN counts for more: half this week, a third for his first 3 games.
  // A trade (his, or a new teammate at his spot) counts the same as a new QB.
  const freshChange = offense?.qbThisWeek || moves.joined || newMates.length > 0;
  const espnWeight = freshChange ? 0.5 : offense?.qbNew ? 0.35 : 0.2;
  if (espn.espnProjection != null) value = (1 - espnWeight) * value + espnWeight * espn.espnProjection;
  const luckPerGame = (s.tdLuck * 6) / s.games;
  if (!(luckPerGame < 0 && glLost)) value -= luckRemoved * luckPerGame;
  if (inefficient && isRB) value -= 1;
  // Someone else ran his backfield while he was out: he may not get it all back.
  if (jobAtRisk) value *= 0.85;

  // Boom-or-bust costs a contender: his bad weeks lose you games the steady
  // guy's don't. Half a point off, and a line either way so you know his range.
  const con = espn.consistency || null;
  let rangeLine = null;
  if (con && con.stdev != null) {
    const lo = round1(con.floor);
    const hi = round1(con.ceiling);
    if (con.bustPct >= BUSTY) {
      value -= 0.5;
      rangeLine = `Boom-or-bust: ${con.bustPct}% of his games land under half his average (floor about ${lo}, ceiling about ${hi}).`;
    } else if (con.stdev <= STEADY_STDEV) {
      rangeLine = `Steady: a typical week lands within ${con.stdev} of his average (floor about ${lo}, ceiling about ${hi}).`;
    } else {
      rangeLine = `Week to week he ranges from about ${lo} to ${hi}.`;
    }
  }
  if (rangeLine) reasons.push(rangeLine);
  const marketValue = marketValueOf(0.5 * s.pprPerGame + 0.5 * recent, espn);

  // "Sell high" only means something when his price sits above his real
  // value: that gap is the profit you cash in. When the two are about even
  // (a hot scorer whose offense makes the scoring real), there's nothing to
  // cash in, and selling him just downgrades your lineup. That's a hold.
  if (label === "Sell high" && marketValue - value < 1.5) {
    call = "hold";
    label = "Hold";
    reasons.unshift(
      `Scoring hot, but his price (about ${round1(marketValue)} a week to other managers) is right in line with what he's really producing, so there's no premium to cash in. Hold him.`
    );
  }

  const worthIt = (s.pprPerGame ?? 0) >= MIN_PPR || (s.touchesLast3 ?? 0) >= MIN_TOUCHES;

  return {
    call,
    label,
    strength: Math.abs(net),
    reasons,
    worthIt,
    guarded: earlyPickNote != null, // early-rounder we're holding: don't ship him cheap
    absent, // missed most of his team's recent games: shows as "Out", injury priced into trades
    possiblyHurt: cantTradeFor(espn.health), // hurt enough that trades price it in (health.js)
    warnings, // role warning signs (losing the backfield, fewer touches...), even on a hold
    value: round1(Math.max(value, 0)),
    marketValue: round1(marketValue),
  };
}
