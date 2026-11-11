// odds.js
// Two things, both from the weekly scores in league-odds.js:
//
// 1. LUCK METER (allPlay)
//    Each week, pretend every team played every other team. Scoring 3rd most
//    in a 10-team league beats 7 of the other 9 teams, so that week is worth
//    7/9 = 0.78 "expected wins". Add those up and you get how many games a
//    team SHOULD have won. Real wins minus expected wins = schedule luck.
//    +1.5 means the schedule handed you about a game and a half.
//
// 2. CHAMPIONSHIP ODDS (simulate)
//    Plays the rest of the regular season and the playoffs 10,000 times.
//    - Each team's strength is its average score, counting recent weeks more
//      (each week back counts 15% less), and pulled a little toward the league
//      average so one huge week doesn't fool it.
//    - Each simulated week, every team scores its strength plus random noise.
//      The noise is how much real weekly scores in your league bounce around.
//    - We also don't know any team's true strength for sure, so each run
//      nudges every team's strength a little, more for teams with fewer games.
//    - Standings use wins, then points for. The top teams make the playoffs,
//      top seeds get byes if the bracket needs them, and every playoff round is
//      one game (or the total of 2 weeks if your league plays 2-week rounds).
//    The odds are just: in how many of the 10,000 seasons did it happen.
//
// The random numbers come from a fixed seed, so the same data always gives
// the same odds. That matters for "what if" questions like a trade: both
// versions get the exact same luck, so the only difference is the trade.

const RECENT_DECAY = 0.85;   // each week back counts 15% less
const SHRINK_GAMES = 2;      // pull toward league average, like 2 average games
const SIMS = 10000;
const SEED = 20261111;

// ---------- small helpers ----------

// A random number generator with a fixed seed (mulberry32). Math.random can't
// be seeded, and we want the same answer every time for the same data.
function makeRandom(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A bell-curve random number (mean 0, spread 1) from two flat ones (Box-Muller).
// The math makes two at once (cos and sin), so the second is saved for the
// next call instead of thrown away. That halves the slow part.
function makeNormal(random) {
  let spare = null;
  return function normal() {
    if (spare !== null) {
      const z = spare;
      spare = null;
      return z;
    }
    let u = 0;
    while (u === 0) u = random();
    const v = random();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

// Chance a bell-curve number lands below z (the normal "CDF").
export function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

const isDone = (g) => g.winner !== "UNDECIDED";

// ---------- weekly scores ----------

// Every team's score each finished week: { teamId: [{ week, points }, ...] }, oldest first.
export function weeklyScores(data) {
  const scores = {};
  for (const t of data.teams) scores[t.id] = [];
  for (const g of data.games.filter(isDone)) {
    scores[g.homeId]?.push({ week: g.week, points: g.homePoints });
    scores[g.awayId]?.push({ week: g.week, points: g.awayPoints });
  }
  for (const list of Object.values(scores)) list.sort((a, b) => a.week - b.week);
  return scores;
}

// ---------- 1. luck meter ----------

export function allPlay(data) {
  const scores = weeklyScores(data);
  const byWeek = {};
  for (const [id, list] of Object.entries(scores)) {
    for (const s of list) (byWeek[s.week] ||= []).push({ id: Number(id), points: s.points });
  }

  const out = {};
  for (const t of data.teams) out[t.id] = { wins: 0, losses: 0, ties: 0, expectedWins: 0, topScores: 0 };

  for (const week of Object.values(byWeek)) {
    const others = week.length - 1;
    if (others < 1) continue;
    const top = Math.max(...week.map((w) => w.points));
    for (const me of week) {
      let beat = 0;
      let tied = 0;
      for (const them of week) {
        if (them.id === me.id) continue;
        if (me.points > them.points) beat++;
        else if (me.points === them.points) tied++;
      }
      const row = out[me.id];
      row.wins += beat;
      row.ties += tied;
      row.losses += others - beat - tied;
      row.expectedWins += (beat + tied / 2) / others;
      if (me.points === top) row.topScores++;
    }
  }

  for (const t of data.teams) {
    const row = out[t.id];
    const actual = t.wins + t.ties / 2;
    row.expectedWins = round1(row.expectedWins);
    row.luck = round1(actual - row.expectedWins);
    const games = row.wins + row.losses + row.ties;
    row.pct = games > 0 ? Math.round(((row.wins + row.ties / 2) / games) * 100) : null;
  }
  return out;
}

// ---------- team strength ----------

// Each team's expected weekly score, how sure we are about it, and the
// league-wide week-to-week bounce (spread).
export function teamStrengths(data) {
  const scores = weeklyScores(data);
  const all = Object.values(scores).flat().map((s) => s.points);
  const leagueMean = all.length ? all.reduce((a, b) => a + b, 0) / all.length : 100;

  // Spread: how far each team's weekly scores land from its own average,
  // pooled across the league. Typically 20 to 25 points in PPR.
  let sq = 0;
  let n = 0;
  for (const list of Object.values(scores)) {
    if (list.length < 2) continue;
    const m = list.reduce((a, s) => a + s.points, 0) / list.length;
    for (const s of list) sq += (s.points - m) ** 2;
    n += list.length - 1;
  }
  const spread = n > 0 ? Math.sqrt(sq / n) : 22;

  const strengths = {};
  for (const t of data.teams) {
    const list = scores[t.id] || [];
    let weighted = 0;
    let weights = 0;
    list.forEach((s, i) => {
      const w = Math.pow(RECENT_DECAY, list.length - 1 - i); // newest week = 1
      weighted += w * s.points;
      weights += w;
    });
    const mean = (weighted + SHRINK_GAMES * leagueMean) / (weights + SHRINK_GAMES);
    strengths[t.id] = {
      mean,
      // how unsure we are about his true average (fewer games = less sure)
      unsure: spread / Math.sqrt(weights + SHRINK_GAMES),
      lastThree: list.length ? list.slice(-3).reduce((a, s) => a + s.points, 0) / Math.min(3, list.length) : null,
    };
  }
  return { strengths, spread, leagueMean };
}

// Chance team A beats team B in one week (no simulation needed).
export function winChance(strengths, spread, aId, bId) {
  const a = strengths[aId];
  const b = strengths[bId];
  if (!a || !b) return null;
  return normalCdf((a.mean - b.mean) / (spread * Math.SQRT2));
}

// ---------- 2. championship odds ----------

// The playoff bracket for one simulated season. seeds = team ids, best first.
// Top seeds sit out round 1 when the field isn't a power of 2 (6 teams: 1 and 2 rest).
function playBracket(seeds, roundLength, score) {
  const seedOf = new Map(seeds.map((id, i) => [id, i]));
  let size = 1;
  while (size < seeds.length) size *= 2;
  const byes = size - seeds.length;
  let alive = seeds.slice(0, byes);
  let playing = seeds.slice(byes);
  let finalists = seeds.length === 2 ? [...seeds] : null;

  while (playing.length + alive.length > 1) {
    const winners = [];
    for (let i = 0; i < playing.length / 2; i++) {
      const hi = playing[i];
      const lo = playing[playing.length - 1 - i];
      let hiPts = 0;
      let loPts = 0;
      for (let w = 0; w < roundLength; w++) {
        hiPts += score(hi);
        loPts += score(lo);
      }
      winners.push(hiPts >= loPts ? hi : lo);
    }
    // bye teams join the winners, best seed first
    const next = [...alive, ...winners].sort((a, b) => seedOf.get(a) - seedOf.get(b));
    if (next.length === 2) finalists = next;
    alive = [];
    playing = next;
    if (playing.length === 1) break;
  }
  return { champion: playing[0], finalists: finalists || playing };
}

// boosts = { teamId: points per week to add } for "what if" questions.
// Returns { teamId: { playoffs, bye, final, title, avgWins, avgSeed } } in percent.
export function simulate(data, { boosts = {}, sims = SIMS } = {}) {
  const { strengths, spread } = teamStrengths(data);
  const random = makeRandom(SEED);
  const normal = makeNormal(random);
  const ids = data.teams.map((t) => t.id);
  const n = ids.length;
  const playoffTeams = Math.min(data.season.playoffTeams, n);
  let size = 1;
  while (size < playoffTeams) size *= 2;
  const byeSpots = size - playoffTeams;
  const roundLength = data.season.playoffRoundLength || 1;

  // Speed: this runs 10,000 times per question, so teams are numbered 0, 1, 2...
  // and every number lives in a plain array that gets reused each run, instead
  // of building new objects every time.
  const slot = new Map(ids.map((id, i) => [id, i]));
  const remaining = data.games
    .filter((g) => !isDone(g))
    .map((g) => [slot.get(g.homeId), slot.get(g.awayId)])
    .filter(([h, a]) => h != null && a != null);
  const baseMean = ids.map((id) => strengths[id].mean + (boosts[id] || 0));
  const unsure = ids.map((id) => strengths[id].unsure);
  const startWins = data.teams.map((t) => t.wins + t.ties / 2);
  const startPf = data.teams.map((t) => t.pointsFor);

  const mean = new Float64Array(n);
  const wins = new Float64Array(n);
  const pf = new Float64Array(n);
  const order = ids.map((_, i) => i);
  const byWinsThenPoints = (a, b) => wins[b] - wins[a] || pf[b] - pf[a];
  const score = (i) => mean[i] + normal() * spread;

  const playoffs = new Float64Array(n);
  const bye = new Float64Array(n);
  const final = new Float64Array(n);
  const title = new Float64Array(n);
  const winSum = new Float64Array(n);
  const seedSum = new Float64Array(n);

  for (let s = 0; s < sims; s++) {
    // this run's "true" strength for every team
    for (let i = 0; i < n; i++) {
      mean[i] = baseMean[i] + normal() * unsure[i];
      wins[i] = startWins[i];
      pf[i] = startPf[i];
    }
    for (const [h, a] of remaining) {
      const hp = score(h);
      const ap = score(a);
      pf[h] += hp;
      pf[a] += ap;
      if (hp > ap) wins[h] += 1;
      else wins[a] += 1;
    }

    for (let i = 0; i < n; i++) order[i] = i;
    order.sort(byWinsThenPoints);
    for (let rank = 0; rank < n; rank++) {
      const i = order[rank];
      winSum[i] += wins[i];
      seedSum[i] += rank + 1;
      if (rank < playoffTeams) playoffs[i]++;
      if (rank < byeSpots) bye[i]++;
    }

    const { champion, finalists } = playBracket(order.slice(0, playoffTeams), roundLength, score);
    for (const i of finalists) final[i]++;
    title[champion]++;
  }

  const pct = (x) => Math.round((x / sims) * 1000) / 10;
  const out = {};
  ids.forEach((id, i) => {
    out[id] = {
      playoffs: pct(playoffs[i]),
      bye: pct(bye[i]),
      final: pct(final[i]),
      title: pct(title[i]),
      avgWins: round1(winSum[i] / sims),
      avgSeed: round1(seedSum[i] / sims),
    };
  });
  return out;
}

// How much one more point a week is worth to a team's title odds, in percent.
// Runs the season again with +5 a week and splits the difference.
export function valueOfAPoint(data, teamId, base) {
  const boosted = simulate(data, { boosts: { [teamId]: 5 } });
  return Math.round(((boosted[teamId].title - base[teamId].title) / 5) * 100) / 100;
}

// Title odds before and after a trade. Your lineup gets your gain, and the
// other team gets theirs, since helping a rival hurts your odds too.
export function tradeOdds(data, myId, trade, base) {
  const after = simulate(data, {
    boosts: { [myId]: trade.myGain || 0, [trade.team.id]: trade.theirGain || 0 },
  });
  return {
    before: base[myId].title,
    after: after[myId].title,
    change: round1(after[myId].title - base[myId].title),
    playoffsChange: round1(after[myId].playoffs - base[myId].playoffs),
  };
}
