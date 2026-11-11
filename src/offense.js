// offense.js
// Turns one team's row from get_offense_context (supabase/19_offense_context.sql)
// into what the Trades page shows:
//   - a small tag next to the team: ▲ green when the offense is rolling,
//     ▼ red when it's struggling, nothing when it's about average
//   - the lines in the "offense" box you see when you click a player
//   - flags tradeCalls.js uses, like "strong" (his TDs are partly real) and
//     "qbNew" (his older numbers came with a different QB)

export const TEAM_NAMES = {
  ARI: "Cardinals", ATL: "Falcons", BAL: "Ravens", BUF: "Bills", CAR: "Panthers", CHI: "Bears",
  CIN: "Bengals", CLE: "Browns", DAL: "Cowboys", DEN: "Broncos", DET: "Lions", GB: "Packers",
  HOU: "Texans", IND: "Colts", JAX: "Jaguars", KC: "Chiefs", LAC: "Chargers", LAR: "Rams",
  LV: "Raiders", MIA: "Dolphins", MIN: "Vikings", NE: "Patriots", NO: "Saints", NYG: "Giants",
  NYJ: "Jets", PHI: "Eagles", PIT: "Steelers", SEA: "Seahawks", SF: "49ers", TB: "Buccaneers",
  TEN: "Titans", WSH: "Commanders",
};

// How far from the league average (points per game) counts as rolling or struggling.
const RECENT_GAP = 4;   // last 3 games
const AHEAD_GAP = 2;    // what's expected next (Vegas if posted, otherwise recent scoring)
const QB_NEW_GAMES = 3; // a QB who's started this many or fewer is still "new"

// Plain words for EPA per play. Passing EPA always runs higher than running
// EPA (and sacks aren't counted), so each gets its own scale.
function passWords(epa) {
  if (epa == null) return null;
  if (epa >= 0.2) return "great";
  if (epa >= 0.1) return "good";
  if (epa >= 0) return "average";
  return "poor";
}

function runWords(epa) {
  if (epa == null) return null;
  if (epa >= 0.03) return "good";
  if (epa >= -0.08) return "average";
  return "poor";
}

// row = one team from the trades function (camelCase version of the SQL row)
export function offenseInfo(team, row) {
  if (!row) return null;
  const name = TEAM_NAMES[team] || team;
  const league = row.leaguePpg;
  const recent = row.ppgLast3 ?? row.ppgSeason;
  const hasVegas = row.vegasGames > 0 && row.vegasNext != null;
  const ahead = hasVegas ? row.vegasNext : recent;

  const strong = recent >= league + RECENT_GAP && ahead >= league + AHEAD_GAP;
  const weak = recent <= league - RECENT_GAP && ahead <= league - AHEAD_GAP;
  const qbNew = row.qbChanged && row.qbNowGames <= QB_NEW_GAMES;
  // A QB starting his first game here this week (traded, or just named the starter).
  const qbThisWeek = Boolean(row.qbChangedThisWeek);

  // The box
  const lines = [];
  if (row.ppgPrior != null) {
    lines.push(`Scoring ${row.ppgPrior} a game before, ${row.ppgLast3} over the last 3 (league average ${league}).`);
  } else {
    lines.push(`Scoring ${row.ppgSeason} a game (league average ${league}).`);
  }
  const pass = passWords(row.passEpaLast3);
  const run = runWords(row.rushEpaLast3);
  if (pass && run) lines.push(`Lately the passing game has been ${pass} and the running game ${run}.`);
  if (row.rzPlaysLast3 != null) {
    const before = row.rzPlaysPrior != null ? ` (${row.rzPlaysPrior} before)` : "";
    lines.push(`${row.rzPlaysLast3} plays inside the 20 a game lately${before}.`);
  }
  if (row.qbNow) {
    if (qbThisWeek) {
      lines.push(`QB: ${row.qbNow} starts this week, taking over from ${row.qbPrevious}. Everything above came before he got there.`);
    } else if (row.qbChanged) {
      lines.push(`QB: ${row.qbNow}, who took over from ${row.qbSeason} (${row.qbNowGames} ${row.qbNowGames === 1 ? "start" : "starts"}).`);
    } else {
      lines.push(`QB: ${row.qbNow}.`);
    }
  }
  if (hasVegas) {
    const span = row.vegasGames === 1 ? "next game" : `a game over the next ${row.vegasGames}`;
    lines.push(`Vegas expects about ${row.vegasNext} points ${span}.`);
  } else {
    lines.push("Vegas hasn't posted lines for their next games yet.");
  }
  if (row.nextOpponents) lines.push(`Next up: ${row.nextOpponents}.`);

  let takeaway = "About an average offense right now.";
  if (strong) takeaway = "One of the better offenses right now, so everyone on it gets more chances to score.";
  if (weak) takeaway = "A struggling offense, so it's hard for anyone on it to score a lot.";
  if (qbThisWeek) {
    takeaway += ` New QB this week (${row.qbNow} in for ${row.qbPrevious}), so this offense's numbers so far may not hold.`;
  } else if (qbNew) {
    takeaway += ` New QB, so numbers from before ${row.qbNow} took over may not hold.`;
  }

  return {
    team,
    name,
    strong,
    weak,
    qbNew,
    tone: strong ? "up" : weak ? "down" : null,
    recent,
    ahead,
    hasVegas,
    qbNow: row.qbNow,
    qbSeason: row.qbSeason,
    qbNowGames: row.qbNowGames,
    qbThisWeek,
    qbPrevious: row.qbPrevious || null,
    lines,
    takeaway,
  };
}
