// injury.js
// Turns a player's injury reports this season (from get_injury_history in the
// database) into short lines for the Injury box in his panel, and works out
// whether an injury explains a recent drop.
//
// Where the data comes from: the official NFL injury reports teams file each
// week (loaded from nflverse by scripts/load-injuries.js). One entry per week,
// with his game status and his last practice of the week. Reports load on
// Tuesday and Saturday mornings, so the newest week shows up on Saturday.

// Was the injury actually affecting him that week? A game status (Out,
// Doubtful, Questionable) or not practicing fully counts. Players who are
// listed but practice fully with no status are usually just being managed.
export function isAffected(report) {
  return Boolean(report.status) || (report.practice != null && report.practice !== "Full");
}

function practiceWords(practice) {
  if (practice === "DNP") return "did not practice";
  if (practice === "Limited") return "limited in practice";
  if (practice === "Full") return "full practice";
  return null;
}

// "Ankle, Foot · Questionable · did not practice"
export function describeReport(report) {
  const injuryNames = [report.type, report.secondary].filter(Boolean).join(", ");
  const parts = [injuryNames || "Injury", report.status || "no game status", practiceWords(report.practice)];
  return parts.filter(Boolean).join(" · ");
}

// "Weeks 1, 2, 4" or "Week 5"
function weekList(weeks) {
  const sorted = [...weeks].sort((a, b) => a - b);
  return `${sorted.length === 1 ? "Week" : "Weeks"} ${sorted.join(", ")}`;
}

function averageOf(games, getValue) {
  const values = games.map(getValue).filter((v) => v != null);
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 10) / 10;
}

// Everything the panel and the Why rules need, or null if he's never been on a report.
//   reports:     his injury reports, newest week first
//   games:       his game log, newest week first
//   currentWeek: the week ESPN says it is
export function injurySummary(reports, games, currentWeek) {
  if (!reports || reports.length === 0) return null;

  const latest = reports[0];
  // This week's report, if he's on it. That's the one that matters for this week's lineup.
  const thisWeek = latest.week === currentWeek ? latest : null;

  // 1. Where he stands right now.
  const statusLine = thisWeek
    ? `Week ${currentWeek} report: ${describeReport(thisWeek)}.`
    : `Not on the Week ${currentWeek} report as of the last data load. Latest was Week ${latest.week}: ${describeReport(latest)}.`;

  // 2. His history this season, grouped by injury: "Ankle (Weeks 1, 2, 4, 5), Foot (Weeks 5, 6)".
  const weeksByInjury = {};
  for (const report of reports) {
    for (const name of [report.type, report.secondary].filter(Boolean)) {
      if (!weeksByInjury[name]) weeksByInjury[name] = [];
      weeksByInjury[name].push(report.week);
    }
  }
  const groups = Object.entries(weeksByInjury).map(([name, weeks]) => `${name} (${weekList(weeks)})`);
  const historyLine = `On the report ${reports.length} ${reports.length === 1 ? "week" : "weeks"} this season: ${groups.join(", ")}.`;

  // 3. How he played in games where the injury was actually affecting him vs the rest.
  const affectedWeeks = new Set(reports.filter(isAffected).map((r) => r.week));
  const hurtGames = games.filter((g) => affectedWeeks.has(g.week));
  const otherGames = games.filter((g) => !affectedWeeks.has(g.week));
  let compareLine = null;
  if (hurtGames.length > 0 && otherGames.length > 0) {
    const hurtWeeks = weekList(hurtGames.map((g) => g.week));
    compareLine =
      `Playing hurt (${hurtWeeks}): ${Math.round(averageOf(hurtGames, (g) => g.snapPct))}% snaps, ` +
      `${averageOf(hurtGames, (g) => g.points)} PPR. ` +
      `His other games: ${Math.round(averageOf(otherGames, (g) => g.snapPct))}% snaps, ` +
      `${averageOf(otherGames, (g) => g.points)} PPR.`;
  }

  // For the Why rules: was he affected by an injury in either of his last 2 games?
  const lastTwoWeeks = games.slice(0, 2).map((g) => g.week);
  const recent = reports.find((r) => lastTwoWeeks.includes(r.week) && isAffected(r)) || null;

  return {
    statusLine,
    historyLine,
    compareLine,
    recent,                                        // the report from his last 2 games, if it affected him
    thisWeek,                                      // this week's report, if he's on it
    stillHurt: Boolean(thisWeek && isAffected(thisWeek)),
  };
}
