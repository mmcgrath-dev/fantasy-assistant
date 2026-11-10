// tradeEngine.js
// Finds trades that help BOTH sides.
//
// How it works:
//   1. Every player gets two numbers from tradeCall (tradeCalls.js):
//        value       = what WE think he'll score per game the rest of the way
//                      (TD luck taken out, inefficiency and lost goal-line work counted)
//        marketValue = what the OTHER manager probably thinks (his points, straight up)
//   2. Each team's lineup is scored WEEK BY WEEK, not once, using each
//      player's remaining schedule: his value bent up or down by how soft each
//      opponent is against his position. A player on his bye scores 0 that
//      week, and so does anyone ESPN lists as OUT this week. So two starters
//      on the same bye really cost you, and bench depth counts.
//      YOUR team counts the playoff weeks (15 to 17) extra: that's when a
//      contender needs the points.
//   3. Every team gets a situation from the standings (see standings below).
//      A team that needs wins now only cares about the next few weeks.
//   4. Try every 1-for-1, 2-for-1 and 1-for-2 with every other team.
//   5. Keep a trade only if:
//        - YOUR lineup goes up, averaged over every week left (our numbers)
//        - THEIR lineup goes up over the weeks THEY care about (their numbers:
//          recent points, ESPN's projection and draft position)
//        - they don't give up more trade value than they get, on paper
//        - in a 2-for-1, the best player in the pair is close to the one coming
//          back. Two mid players don't buy a star: "two quarters don't make a dollar."
//        - a player with role warnings (losing work, bad efficiency) is a
//          DISCOUNTED player. You pay for him with players you're already
//          selling, never with a solid hold: that's an overpay.
//        - an early-rounder we're holding ("don't sell him at his lowest")
//          only moves for a clean player and a clear upgrade, never for
//          someone else's problem.
//      Two of your starting backs from the same NFL team get marked down: they
//      share one backfield, so when both are healthy they eat into each other.
//   6. Injuries happen. Every starter has a chance of missing any given week
//      (backs the most), and when he does, the best guy on the bench fills in.
//      So a thin bench costs points, and a 2-for-1 has to be worth the depth
//      you give up. Giving two players for one also has to win by a clear
//      margin, because our estimates can be off by a couple of points.
//
// QBs, kickers and D/ST aren't in it, and neither is anyone with fewer than 4
// games (no signals yet), sitting on IR, or a back who's missed most of his
// team's recent games (we can't tell what his job will be when he's back).

const MY_MIN_GAIN = 1.0;     // your lineup has to go up at least this much per week
const MY_MIN_GAIN_2FOR1 = 2.5; // ...and this much when you give two players for one
const WARNING_PREMIUM = 1.0;   // ...plus this much for each player you'd get whose role has warning signs
const THEIR_MIN_GAIN = 1.0;  // and theirs at least this much, as they'd see it (less isn't worth their time)
const FAIRNESS = 1.0;        // they can't give up more trade value than they get, on paper (see tradeValue)
const DESPERATE_FAIRNESS = 0.9; // a team that needs wins now will take a little less on paper for help right away
const STAR_RATIO = 0.8;      // in a 2-for-1, the best player in the pair has to be 80%+ of the one coming back
const SAME_BACKFIELD = 0.2;  // two of your starting RBs on one NFL team: the weaker one counts 20% less
const PLAYOFF_WEEKS = [15, 16, 17];
const PLAYOFF_WEIGHT = 1.5;    // how much extra the playoff weeks count for YOUR team
const MATCHUP_CAP = 0.2;       // a matchup bends a week's projection by at most 20% either way

// Chance a starter misses any given week. Rough injury rates by position.
const MISS_CHANCE = { RB: 0.12, WR: 0.08, TE: 0.07 };
const LAST_WEEK = 17;        // last week of the fantasy season (playoffs included)
const NEAR_WEEKS = 3;        // "the next few weeks" for a team that needs wins now
const MAX_TRADES = 6;
const MAX_PER_TEAM = 2;
const MAX_PER_PLAYER = 2;    // the same player of yours shows up in at most 2 suggestions

// ESPN injury words that mean he won't play this week.
const OUT_THIS_WEEK = ["OUT", "INJURY_RESERVE", "SUSPENSION"];

// ---------- trade value ----------

// Why not just add up points? Because two 13-point players are NOT worth one
// 25-point player: only one of them fits in a lineup spot, and studs are rare.
// So trade value grows faster than points (the same idea trade calculators use):
//   25 a week -> 25 * 2.5^0.8 ~ 52     13 a week -> 13 * 1.3^0.8 ~ 16
// Two 13s (~32) are well short of one 25 (~52).
export function tradeValue(pointsPerGame) {
  const ppg = Math.max(pointsPerGame, 0);
  return ppg * Math.pow(ppg / 10, 0.8);
}

// ---------- standings ----------

// Where every team sits, and what that means for trades:
//   safe            in a playoff spot and 3+ wins clear of the first team out
//   in the mix      in a playoff spot, but it's close
//   chasing         out of a playoff spot, but within a game
//   needs wins now  2+ games out of a playoff spot
// season = { playoffTeams, regularSeasonWeeks } from trades.js
export function standings(teams, season) {
  const sorted = [...teams].sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor);
  const spots = Math.min(season.playoffTeams, sorted.length);
  const lastIn = sorted[spots - 1];
  const firstOut = sorted[spots];

  const out = {};
  sorted.forEach((team, i) => {
    const played = team.wins + team.losses + team.ties;
    const weeksLeft = Math.max(season.regularSeasonWeeks - played, 0);
    const rank = i + 1;
    let mode;
    let gap;
    if (rank <= spots) {
      gap = firstOut ? team.wins - firstOut.wins : 99;
      mode = gap >= 3 ? "safe" : "in the mix";
    } else {
      gap = lastIn.wins - team.wins;
      mode = gap >= 2 ? "needs wins now" : "chasing";
    }
    out[team.id] = { rank, mode, gap, weeksLeft };
  });
  return out;
}

function weekRange(from, to) {
  const weeks = [];
  for (let w = from; w <= to; w++) weeks.push(w);
  return weeks;
}

// The weeks a team cares about when judging a trade.
function weeksThatMatter(situation, currentWeek, season) {
  if (situation?.mode === "needs wins now") return weekRange(currentWeek, currentWeek + NEAR_WEEKS - 1);
  if (situation?.mode === "chasing") return weekRange(currentWeek, Math.max(season.regularSeasonWeeks, currentWeek));
  return weekRange(currentWeek, LAST_WEEK);
}

// ---------- lineups ----------

// What a player projects for in a given week by a value field. week = null
// means "a normal week" (no byes, no matchups), used for the explanations.
// With his schedule loaded: no game that week = bye = 0, and the matchup
// bends his value up or down (capped, so one soft defense doesn't run wild).
export function weekPoints(p, field, week, currentWeek) {
  if (week == null) return p.callInfo[field];
  if (week === currentWeek && OUT_THIS_WEEK.includes(p.injuryStatus)) return 0;
  if (p.weeks) {
    const g = p.weeks[week];
    if (!g) return 0; // bye (or season over for him)
    let factor = 1;
    if (g.defAllowed != null && g.leagueAllowed > 0) {
      factor = Math.max(1 - MATCHUP_CAP, Math.min(1 + MATCHUP_CAP, g.defAllowed / g.leagueAllowed));
    }
    return p.callInfo[field] * factor;
  }
  if (p.byeWeek === week) return 0;
  return p.callInfo[field];
}

// Best possible starters for a list of players in one week, using a value field.
// slots = { RB: 2, WR: 2, TE: 1, FLEX: 1 }
export function bestLineup(players, slots, field, week = null, currentWeek = null) {
  const pts = (p) => weekPoints(p, field, week, currentWeek);
  const pool = [...players].sort((a, b) => pts(b) - pts(a));
  const used = new Set();
  const starters = [];

  for (const pos of ["RB", "WR", "TE"]) {
    let left = slots[pos] || 0;
    for (const p of pool) {
      if (left === 0) break;
      if (p.position === pos && !used.has(p.espnId)) {
        used.add(p.espnId);
        starters.push({ slot: pos, player: p });
        left--;
      }
    }
  }
  let flex = slots.FLEX || 0;
  for (const p of pool) {
    if (flex === 0) break;
    if (!used.has(p.espnId)) {
      used.add(p.espnId);
      starters.push({ slot: "FLEX", player: p });
      flex--;
    }
  }

  const total = starters.reduce((sum, s) => sum + pts(s.player), 0);
  return { total, starters, starterIds: used };
}

// Two or more starting backs from the same NFL team: every one after the best
// counts SAME_BACKFIELD less. Returns the points to take off and who's involved.
function sameBackfield(lineup) {
  const byTeam = {};
  for (const s of lineup.starters) {
    if (s.player.position !== "RB") continue;
    (byTeam[s.player.nflTeam] ||= []).push(s.player);
  }
  let penalty = 0;
  const groups = [];
  for (const backs of Object.values(byTeam)) {
    if (backs.length < 2) continue;
    backs.sort((a, b) => b.callInfo.value - a.callInfo.value);
    for (const p of backs.slice(1)) penalty += SAME_BACKFIELD * p.callInfo.value;
    groups.push(backs);
  }
  return { penalty, groups };
}

// Points a lineup is expected to lose to injuries in a normal week. For each
// starter: the chance he misses, times how much worse the lineup is when the
// bench has to cover for him.
function injuryCost(players, slots, field, normal) {
  let cost = 0;
  for (const s of normal.starters) {
    const chance = MISS_CHANCE[s.player.position] ?? 0.08;
    const without = bestLineup(
      players.filter((p) => p.espnId !== s.player.espnId),
      slots,
      field
    );
    cost += chance * (normal.total - without.total);
  }
  return cost;
}

// A team's lineup over a set of weeks: the average weekly total (byes and
// players out this week count), minus what injuries are expected to cost,
// plus the "normal week" lineup for explanations.
function lineupOver(players, slots, field, weeks, currentWeek, { backfieldPenalty = false, playoffWeight = false } = {}) {
  const normal = bestLineup(players, slots, field);
  let sum = 0;
  let weightSum = 0;
  for (const w of weeks) {
    const weight = playoffWeight && PLAYOFF_WEEKS.includes(w) ? PLAYOFF_WEIGHT : 1;
    sum += weight * bestLineup(players, slots, field, w, currentWeek).total;
    weightSum += weight;
  }
  let total = weightSum > 0 ? sum / weightSum : normal.total;
  const injuries = injuryCost(players, slots, field, normal);
  total -= injuries;
  const backfield = backfieldPenalty ? sameBackfield(normal) : { penalty: 0, groups: [] };
  total -= backfield.penalty;
  return { total, injuries, starters: normal.starters, starterIds: normal.starterIds, backfield };
}

// Starters in slot order, for the before/after table on each trade card.
const SLOT_ORDER = { RB: 0, WR: 1, TE: 2, FLEX: 3 };
function lineupRows(lineup) {
  return [...lineup.starters]
    .sort((a, b) => SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot] || b.player.callInfo.value - a.player.callInfo.value)
    .map((s) => ({ slot: s.slot, name: s.player.name, value: s.player.callInfo.value, espnId: s.player.espnId }));
}

// Healthy backups left on the bench at each position after a trade.
function benchLeft(players, lineup) {
  return players.filter(
    (p) => !lineup.starterIds.has(p.espnId) && !OUT_THIS_WEEK.includes(p.injuryStatus)
  );
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function names(players) {
  return players.map((p) => p.name).join(" and ");
}

function record(team) {
  return `${team.wins}-${team.losses}${team.ties ? `-${team.ties}` : ""}`;
}

// Every way to pick k players from a list (k is 1 or 2 here).
function combos(list, k) {
  if (k === 1) return list.map((p) => [p]);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) out.push([list[i], list[j]]);
  }
  return out;
}

// Starters (in a normal week) who share a bye that hasn't happened yet.
function sharedByes(lineup, currentWeek) {
  const byWeek = {};
  for (const s of lineup.starters) {
    const bye = s.player.byeWeek;
    if (bye != null && bye >= currentWeek) (byWeek[bye] ||= []).push(s.player);
  }
  return Object.entries(byWeek)
    .filter(([, players]) => players.length >= 2)
    .map(([week, players]) => ({ week: Number(week), players }));
}

// ---------- explanations ----------

// Which of `incoming` would start for a team after the trade, and which of the
// team's current starters (that they keep) drops to the bench because of it.
function newStarters(before, after, incoming, outgoingIds) {
  const benched = before.starters
    .map((s) => s.player)
    .filter((p) => !after.starterIds.has(p.espnId) && !outgoingIds.has(p.espnId));
  const lines = [];
  for (const p of incoming) {
    const spot = after.starters.find((s) => s.player.espnId === p.espnId);
    if (spot) lines.push({ player: p, slot: spot.slot });
  }
  return { lines, benched };
}

function whyGive(give, myBefore) {
  const out = [];
  for (const p of give) {
    const c = p.callInfo;
    const starting = myBefore.starterIds.has(p.espnId);
    if (c.label === "Sell high" || c.label === "Sell low") {
      out.push(`${p.name} (${c.label.toLowerCase()}): ${c.reasons[0]}`);
    } else if (!starting) {
      out.push(`${p.name} is on your bench and doesn't start for you, so he's worth more as a trade chip.`);
    } else {
      out.push(`${p.name} is a fine starter (about ${c.value} a week by our numbers), but what you get back is worth more to your lineup.`);
    }
  }
  return out;
}

function whyGet(get, give, myBefore, myAfter, currentWeek) {
  const out = [];
  const { lines, benched } = newStarters(myBefore, myAfter, get, new Set(give.map((p) => p.espnId)));
  for (const line of lines) {
    const p = line.player;
    out.push(`${p.name} would start for you at ${line.slot}. We have him at about ${p.callInfo.value} a week the rest of the way.`);
  }
  if (benched.length > 0) {
    out.push(`That moves ${names(benched)} (${benched.map((p) => p.callInfo.value).join(" and ")} a week) to your bench.`);
  }
  for (const p of get) {
    if (p.callInfo.label === "Buy") out.push(`${p.name} is a buy-low: ${p.callInfo.reasons[0]}`);
    else if (p.callInfo.label === "Sell high" || p.callInfo.label === "Sell low") {
      out.push(`Heads up on ${p.name}: ${p.callInfo.reasons[0]}`);
    } else if (p.callInfo.warnings?.length > 0) {
      out.push(`Heads up on ${p.name}: ${p.callInfo.warnings[0]}`);
    }
    if (OUT_THIS_WEEK.includes(p.injuryStatus)) {
      out.push(`${p.name} is out this week, so this one's about the weeks after. It's counted that way.`);
    }
  }
  // New problems the trade would create for you
  const getIds = new Set(get.map((p) => p.espnId));
  for (const group of myAfter.backfield.groups) {
    if (group.some((p) => getIds.has(p.espnId))) {
      out.push(
        `Heads up: ${names(group)} share the ${group[0].nflTeam} backfield. When both are healthy they eat into each other, so ${group.slice(1).map((p) => p.name).join(" and ")} counts ${SAME_BACKFIELD * 100}% less here.`
      );
    }
  }
  const beforeByes = new Set(sharedByes(myBefore, currentWeek).map((b) => b.week));
  for (const bye of sharedByes(myAfter, currentWeek)) {
    if (!beforeByes.has(bye.week) && bye.players.some((p) => getIds.has(p.espnId))) {
      out.push(`Heads up: ${names(bye.players)} all have their bye in Week ${bye.week}. That week is counted as a hit to your lineup.`);
    }
  }
  return out;
}

function situationLine(team, situation) {
  if (!situation) return null;
  const left = situation.weeksLeft;
  const weeks = `${left} ${left === 1 ? "week" : "weeks"}`;
  switch (situation.mode) {
    case "needs wins now":
      return `They're ${record(team)}, ${situation.gap} games out of a playoff spot with ${weeks} left. They need points the next few weeks, not in December, so that's all this trade is judged on for them.`;
    case "chasing":
      return `They're ${record(team)} and just outside the playoffs with ${weeks} left, so they're looking for a push.`;
    case "safe":
      return `They're ${record(team)} and close to a lock for the playoffs, so they're thinking about the playoff weeks, not this week.`;
    default:
      return `They're ${record(team)} and in a playoff spot, but it's close.`;
  }
}

function whyThem(give, get, team, situation, theirBefore, theirAfter) {
  const out = [];
  const line = situationLine(team, situation);
  if (line) out.push(line);
  const { lines, benched } = newStarters(theirBefore, theirAfter, give, new Set(get.map((p) => p.espnId)));
  for (const l of lines) {
    out.push(`${l.player.name} would start for them at ${l.slot}.`);
  }
  if (benched.length > 0) {
    out.push(`${names(benched)} would move to their bench, so it's a real upgrade for them.`);
  }
  const benchGuys = get.filter((p) => !theirBefore.starterIds.has(p.espnId));
  if (benchGuys.length > 0) {
    out.push(`${names(benchGuys)} ${benchGuys.length === 1 ? "doesn't" : "don't"} start for them now, so they're not giving up a starter.`);
  }
  const hurt = get.filter((p) => OUT_THIS_WEEK.includes(p.injuryStatus));
  const healthyBack = give.every((p) => !OUT_THIS_WEEK.includes(p.injuryStatus));
  if (hurt.length > 0 && healthyBack) {
    out.push(`They get healthy players for ${names(hurt)}, who ${hurt.length === 1 ? "is" : "are"} out this week.`);
  }
  const marketGive = give.reduce((sum, p) => sum + p.callInfo.marketValue, 0);
  const marketGet = get.reduce((sum, p) => sum + p.callInfo.marketValue, 0);
  if (give.length === get.length && marketGive >= marketGet) {
    out.push(`Going by recent points, they get ${round1(marketGive)} a week for ${round1(marketGet)}. It looks like a win to them.`);
  }
  if (give.length > get.length) {
    out.push(`They get depth: two players for one, which helps with byes and injuries.`);
  } else if (get.length > give.length) {
    out.push(`They turn two players into one better one and open a roster spot.`);
  }
  return out;
}

// ---------- the search ----------

// teams: from Trades.jsx, every player already has .callInfo (or null) and .byeWeek
// slots: { RB, WR, TE, FLEX }
// season: { playoffTeams, regularSeasonWeeks }
// currentWeek: this week's number
// opts.forPlayer: an espnId. Shop THIS player: every trade must send him out.
//   The bar drops (you're the one who wants to move him), more results come
//   back, and the finder will add a second piece of yours when that's what
//   makes a deal work. That's the trade calculator.
export function findTrades(teams, slots, season, currentWeek, opts = {}) {
  const usable = (p) =>
    p.callInfo && !p.callInfo.absent && p.slot !== "IR" && ["RB", "WR", "TE"].includes(p.position);
  const mine = teams.find((t) => t.isMine);
  if (!mine) return [];

  const table = standings(teams, season);
  const myWeeks = weekRange(currentWeek, LAST_WEEK);
  const myPlayers = mine.players.filter(usable);
  const myBefore = lineupOver(myPlayers, slots, "value", myWeeks, currentWeek, { backfieldPenalty: true, playoffWeight: true });

  // Don't offer players who are due to bounce back (selling low on them),
  // or depth guys nobody wants. When shopping one player, he's always in the
  // deal (whatever his label), and anyone else can be the added piece.
  const shopping = opts.forPlayer ? myPlayers.find((p) => p.espnId === opts.forPlayer) : null;
  const myOffers = shopping
    ? myPlayers.filter((p) => p.espnId === shopping.espnId || p.callInfo.worthIt)
    : myPlayers.filter((p) => p.callInfo.label !== "Buy" && p.callInfo.worthIt);

  const minGainBase = shopping ? 0.3 : MY_MIN_GAIN;
  const minGain2for1 = shopping ? 1.5 : MY_MIN_GAIN_2FOR1;
  const theirMinGain = shopping ? 0.5 : THEIR_MIN_GAIN;
  const maxTrades = shopping ? 8 : MAX_TRADES;
  const maxPerTeam = shopping ? 3 : MAX_PER_TEAM;

  const candidates = [];

  for (const team of teams) {
    if (team.isMine) continue;
    const situation = table[team.id];
    const theirWeeks = weeksThatMatter(situation, currentWeek, season);
    const fairness = situation?.mode === "needs wins now" ? DESPERATE_FAIRNESS : FAIRNESS;
    const theirPlayers = team.players.filter(usable);
    const theirBefore = lineupOver(theirPlayers, slots, "marketValue", theirWeeks, currentWeek);
    const theirTargets = theirPlayers.filter((p) => p.callInfo.worthIt);

    for (const [giveCount, getCount] of [[1, 1], [2, 1], [1, 2]]) {
      for (const give of combos(myOffers, giveCount)) {
        if (shopping && !give.some((p) => p.espnId === shopping.espnId)) continue;
        for (const get of combos(theirTargets, getCount)) {
          const giveIds = new Set(give.map((p) => p.espnId));
          const getIds = new Set(get.map((p) => p.espnId));

          // Cheap checks first (no lineups needed), since there are thousands of combos.

          // Who's being paid with, and what's coming back? (The player being
          // shopped on purpose skips his own checks: you chose to move him.)
          const checkedGive = shopping ? give.filter((p) => p.espnId !== shopping.espnId) : give;
          const warnedGet = get.some((p) => p.callInfo.warnings?.length > 0 || p.callInfo.call === "sell");
          if (warnedGet) {
            // A discounted player gets paid for with players we're selling
            // anyway (or bench guys), never with a solid starter we're holding.
            const payingWithHolds = checkedGive.some(
              (p) => p.callInfo.call !== "sell" && myBefore.starterIds.has(p.espnId)
            );
            if (payingWithHolds) continue;
            // And a guarded early-rounder never moves for someone else's problem.
            if (checkedGive.some((p) => p.callInfo.guarded)) continue;
          }

          // They won't take a deal that looks lopsided against them on paper,
          // using trade value (studs count for more than their points).
          const tvGive = give.reduce((sum, p) => sum + tradeValue(p.callInfo.marketValue), 0);
          const tvGet = get.reduce((sum, p) => sum + tradeValue(p.callInfo.marketValue), 0);
          if (tvGive < fairness * tvGet) continue;

          // Two-for-ones: the best player on the side with two has to be close
          // to the single player on the other side.
          const bestOf = (players) => Math.max(...players.map((p) => p.callInfo.marketValue));
          if (give.length === 2 && bestOf(give) < STAR_RATIO * bestOf(get)) continue;
          if (get.length === 2 && bestOf(give) < STAR_RATIO * bestOf(get)) continue;

          const myAfter = lineupOver(
            [...myPlayers.filter((p) => !giveIds.has(p.espnId)), ...get],
            slots,
            "value",
            myWeeks,
            currentWeek,
            { backfieldPenalty: true, playoffWeight: true }
          );
          const myGain = myAfter.total - myBefore.total;
          const warned = get.filter((p) => p.callInfo.warnings?.length > 0).length;
          let minGain = (give.length > get.length ? minGain2for1 : minGainBase) + WARNING_PREMIUM * warned;
          // Moving a guarded early-rounder takes a clear upgrade, not an edge.
          if (checkedGive.some((p) => p.callInfo.guarded)) minGain = Math.max(minGain, 2.5);
          if (myGain < minGain) continue;

          const theirAfter = lineupOver(
            [...theirPlayers.filter((p) => !getIds.has(p.espnId)), ...give],
            slots,
            "marketValue",
            theirWeeks,
            currentWeek
          );
          const theirGain = theirAfter.total - theirBefore.total;
          if (theirGain < theirMinGain) continue;

          candidates.push({
            team,
            situation,
            give,
            get,
            myGain: round1(myGain),
            theirGain: round1(theirGain),
            score: myGain + 0.4 * theirGain,
            myBefore,
            myAfter,
            theirBefore,
            theirAfter,
          });
        }
      }
    }
  }

  // Best first, then spread them out: a couple per team, each of your players
  // in no more than two, each of theirs in one.
  candidates.sort((a, b) => b.score - a.score);
  const picked = [];
  const perTeam = {};
  const perMine = {};
  const usedTheirs = new Set();
  for (const c of candidates) {
    if (picked.length >= maxTrades) break;
    if ((perTeam[c.team.id] || 0) >= maxPerTeam) continue;
    if (!shopping && c.give.some((p) => (perMine[p.espnId] || 0) >= MAX_PER_PLAYER)) continue;
    if (c.get.some((p) => usedTheirs.has(p.espnId))) continue;

    perTeam[c.team.id] = (perTeam[c.team.id] || 0) + 1;
    c.give.forEach((p) => (perMine[p.espnId] = (perMine[p.espnId] || 0) + 1));
    c.get.forEach((p) => usedTheirs.add(p.espnId));
    picked.push(c);
  }

  return picked.map((c) => {
    const notes = [];
    if (c.get.length > c.give.length) {
      // you'd need a roster spot: your weakest bench guy is the one to cut
      const bench = myPlayers
        .filter((p) => !c.myAfter.starterIds.has(p.espnId) && !c.give.some((g) => g.espnId === p.espnId))
        .sort((a, b) => a.callInfo.value - b.callInfo.value);
      if (bench[0]) notes.push(`You'd need a roster spot. ${bench[0].name} (about ${bench[0].callInfo.value} a week) is the one to drop.`);
    } else if (c.give.length > c.get.length) {
      notes.push("Frees up a roster spot for a waiver pickup.");
    }
    // Depth check: which positions would have no healthy backup left.
    const giveIds = new Set(c.give.map((p) => p.espnId));
    const afterPlayers = [...myPlayers.filter((p) => !giveIds.has(p.espnId)), ...c.get];
    const bench = benchLeft(afterPlayers, c.myAfter);
    for (const pos of ["RB", "WR"]) {
      const backups = bench.filter((p) => p.position === pos).sort((a, b) => b.callInfo.value - a.callInfo.value);
      const before = benchLeft(myPlayers, c.myBefore).filter((p) => p.position === pos).length;
      if (backups.length < before && backups.length <= 1) {
        const who =
          backups.length === 0
            ? `you'd have no healthy ${pos} on your bench`
            : `your only healthy ${pos} backup would be ${backups[0].name} (${backups[0].callInfo.value} a week)`;
        notes.push(`Depth: ${who}. One injury and you're starting a much weaker player. That risk is already counted in the +/wk.`);
      }
    }
    return {
      team: c.team,
      situation: c.situation,
      give: c.give,
      get: c.get,
      myGain: c.myGain,
      theirGain: c.theirGain,
      lineupBefore: lineupRows(c.myBefore),
      lineupAfter: lineupRows(c.myAfter),
      whyGive: whyGive(c.give, c.myBefore),
      whyGet: whyGet(c.get, c.give, c.myBefore, c.myAfter, currentWeek),
      whyThem: whyThem(c.give, c.get, c.team, c.situation, c.theirBefore, c.theirAfter),
      notes,
    };
  });
}

// Your bench guys who'd be the first to go for a waiver pickup.
export function dropCandidates(teams, slots) {
  const mine = teams.find((t) => t.isMine);
  if (!mine) return [];
  const myPlayers = mine.players.filter((p) => p.callInfo && p.slot !== "IR");
  const lineup = bestLineup(
    myPlayers.filter((p) => ["RB", "WR", "TE"].includes(p.position)),
    slots,
    "value"
  );
  return myPlayers
    .filter((p) => ["RB", "WR", "TE"].includes(p.position) && !lineup.starterIds.has(p.espnId))
    .filter((p) => p.callInfo.label !== "Buy")
    .sort((a, b) => a.callInfo.value - b.callInfo.value)
    .slice(0, 2);
}
