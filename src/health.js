// health.js
// One place that decides whether a player is hurt or has been missing games,
// so every page (Trades, Trade Finder, Start/Sit, My Team) judges it the same way.
//
// Three signals, from most to least certain:
//   1. ESPN's injury status: OUT, IR, SUSPENSION, DOUBTFUL, QUESTIONABLE
//   2. Games missed: his team played but he didn't. Worked out from the last
//      week he played vs the latest week of games in the database, skipping
//      his team's bye. This is the one that was missing for receivers: a guy
//      who hasn't played since Week 6 still showed his Week 4-6 points as if
//      he were healthy.
//   3. No ESPN projection while his team has a game this week. ESPN zeroes out
//      players it doesn't expect to play, so a blank usually means hurt.
//
// What the levels mean everywhere:
//   "out"     won't play this week (OUT, IR, suspended)
//   "missing" missed 2+ of his team's games in a row: his old numbers can't
//             tell us what he'll do when he's back, so trades leave him out
//   "risky"   missed his last game, or Doubtful, or no ESPN projection: don't
//             trade FOR him until he's back on the field
//   "watch"   Questionable but playing lately: fine, just keep an eye on it
//   "ok"      nothing to worry about

const OUT = { OUT: "Out", INJURY_RESERVE: "on IR", SUSPENSION: "suspended" };

function weekList(weeks) {
  return weeks.length === 1 ? `Week ${weeks[0]}` : `Weeks ${weeks.slice(0, -1).join(", ")} and ${weeks[weeks.length - 1]}`;
}

// The latest week with games in the database: the newest "last game" anyone has.
export function latestWeekPlayed(players) {
  let latest = null;
  for (const p of players) {
    const w = p.signals?.lastGameWeek ?? (p.gameLog?.[0]?.week ?? null);
    if (w != null && (latest == null || w > latest)) latest = w;
  }
  return latest;
}

// player: needs injuryStatus (ESPN word) or status (Q/D/O from roster.js),
//         espnProjection (or projected), weeks (remaining schedule), and his last
//         game week (signals.lastGameWeek, or the newest week in his gameLog)
// ctx:    { latestWeek, byeWeek, currentWeek }
export function healthOf(player, { latestWeek, byeWeek, currentWeek }) {
  const statusWord = player.injuryStatus || { O: "OUT", IR: "INJURY_RESERVE", SSPD: "SUSPENSION", D: "DOUBTFUL", Q: "QUESTIONABLE" }[player.status] || "ACTIVE";
  const lastGame = player.signals?.lastGameWeek ?? (player.gameLog?.[0]?.week ?? null);

  // Team games since his last one (his team's bye doesn't count as missed).
  const missedWeeks = [];
  if (lastGame != null && latestWeek != null) {
    for (let w = lastGame + 1; w <= latestWeek; w++) if (w !== byeWeek) missedWeeks.push(w);
  }
  const missed = missedWeeks.length;

  const hasGameThisWeek = player.weeks ? Boolean(player.weeks[currentWeek]) : byeWeek !== currentWeek;
  // Only judge the projection when we actually asked ESPN for one (free agents
  // from the player search don't have one at all, which isn't the same as blank).
  const asked = player.espnProjection !== undefined || player.projected !== undefined;
  const projection = player.espnProjection !== undefined ? player.espnProjection : player.projected > 0 ? player.projected : null;
  const noProjection = asked && projection == null && hasGameThisWeek && !OUT[statusWord];

  const missedText = missed > 0 ? `Hasn't played since Week ${lastGame} (missed ${weekList(missedWeeks)}).` : null;

  let level = "ok";
  let line = null;
  if (OUT[statusWord]) {
    level = "out";
    line = `${OUT[statusWord][0].toUpperCase()}${OUT[statusWord].slice(1)} this week.${missedText ? ` ${missedText}` : ""}`;
  } else if (missed >= 2) {
    level = "missing";
    line = `${missedText} His old numbers can't tell us what he'll do when he's back.`;
  } else if (missed === 1 || statusWord === "DOUBTFUL" || noProjection) {
    level = "risky";
    const parts = [];
    if (missedText) parts.push(missedText);
    if (statusWord === "DOUBTFUL") parts.push("Doubtful this week.");
    else if (statusWord === "QUESTIONABLE") parts.push("Questionable this week.");
    if (noProjection) parts.push("ESPN has no projection for him, which usually means they don't expect him to play.");
    line = parts.join(" ");
  } else if (statusWord === "QUESTIONABLE") {
    level = "watch";
    line = "Questionable this week, but he's been playing.";
  }

  return { level, line, missed, missedWeeks, lastGame, status: statusWord, noProjection };
}

// Gives every player in a league (or one roster) his health. byeWeeks maps an
// NFL team code to its bye week.
export function addHealth(players, byeWeeks, currentWeek) {
  const latestWeek = latestWeekPlayed(players);
  for (const p of players) {
    p.health = healthOf(p, { latestWeek, byeWeek: byeWeeks[p.nflTeam] ?? null, currentWeek });
  }
  return players;
}

// ---------- pricing an injury into a trade ----------
//
// Instead of leaving hurt players out of trades, the trade math counts the
// weeks he'll probably miss. availability() is the share of his normal points
// we expect in a given week:
//   on IR            0 for 4 weeks (the shortest IR stint), then 90%
//   Out this week    0 this week; next week a coin flip if he's been missing
//                    games, likely back if this is his first
//   missed 2+ games  this week depends on his status (Questionable = coin flip),
//                    then 80% next week, then 90%
//   missed 1 / Doubtful / no projection   reduced this week, about full after
// "90% once he's back" covers re-injury risk and easing back in.
//
// Why this makes buy-lows: a team that needs wins now only counts the next
// few weeks, where he's worth almost nothing to them. You count the playoff
// weeks, where he's back. And every manager sees a hurt player as worth less,
// so he costs less (marketDiscount below).

const IR_WEEKS = 4;      // the shortest IR stint
const BACK_RATE = 0.9;   // share of his normal points once he's back
const LAST_WEEK = 17;

export function availability(h, week, currentWeek) {
  if (!h || week == null || currentWeek == null) return 1;
  const k = week - currentWeek; // 0 = this week, 1 = next week...
  if (k < 0) return 1;
  switch (h.level) {
    case "out":
      if (h.status === "INJURY_RESERVE") return k < IR_WEEKS ? 0 : BACK_RATE;
      if (k === 0) return 0;
      if (k === 1) return h.missed >= 1 ? 0.5 : 0.85;
      return h.missed >= 1 ? BACK_RATE : 1;
    case "missing":
      if (k === 0) {
        if (h.status === "DOUBTFUL") return 0.15;
        if (h.noProjection) return 0.25;
        if (h.status === "QUESTIONABLE") return 0.5;
        return 0.7; // listed as active and projected: likely returning
      }
      return k === 1 ? 0.8 : BACK_RATE;
    case "risky":
      if (k === 0) {
        if (h.status === "DOUBTFUL") return 0.2;
        if (h.noProjection) return 0.3;
        if (h.status === "QUESTIONABLE") return 0.6;
        return 0.75;
      }
      return k === 1 ? 0.9 : 0.95;
    case "watch":
      return k === 0 ? 0.85 : 1;
    default:
      return 1;
  }
}

// The first week he's more likely than not to play, or null if he's fine.
export function expectedBack(h, currentWeek) {
  if (!h || h.level === "ok" || h.level === "watch") return null;
  for (let w = currentWeek; w <= LAST_WEEK; w++) {
    if (availability(h, w, currentWeek) >= 0.5) return w;
  }
  return null;
}

// How other managers price a hurt player: his healthy value times the share
// of the rest of the season he's expected to be out there. A guy on IR for
// 4 of the 8 weeks left goes for a lot less than his healthy price.
export function marketDiscount(h, currentWeek) {
  if (!h || h.level === "ok" || currentWeek == null) return 1;
  let sum = 0;
  let n = 0;
  for (let w = currentWeek; w <= LAST_WEEK; w++) {
    sum += availability(h, w, currentWeek);
    n++;
  }
  return n > 0 ? sum / n : 1;
}

// A short tag for trade cards: "Hurt · back ~W14" / "Q · missed W9"
export function healthTag(h, currentWeek) {
  if (!h || h.level === "ok" || h.level === "watch") return null;
  const back = expectedBack(h, currentWeek);
  if (back == null) return "Hurt";
  if (back === currentWeek) return h.missed > 0 ? `Missed ${h.missed} · may play` : "Iffy this week";
  return `Hurt · back ~W${back}`;
}

// True when a player's injury should be priced into a trade (and flagged on
// the card). Out this week after playing last week is just a 0 this week.
export function cantTradeFor(health) {
  if (!health) return false;
  return health.level === "missing" || health.level === "risky" || (health.level === "out" && health.missed >= 1);
}
