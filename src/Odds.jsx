// Odds.jsx
// The Odds page:
//   1. Your championship odds, playoff odds, and this week's win chance
//   2. What one more point a week is worth to your title odds
//   3. The luck meter for every team: real record vs all-play record
// The numbers come from league-odds.js (ESPN scores, schedule and trades),
// rosterTrades.js (what each trade did to both lineups) and the math from odds.js.

import { useState, useEffect, useMemo } from "react";
import { allPlay, simulate, teamStrengths, winChance, valueOfAPoint } from "./odds.js";
import { loadOddsData } from "./rosterTrades.js";

function record(w, l, t) {
  return `${w}-${l}${t ? `-${t}` : ""}`;
}

function signed(n) {
  return `${n > 0 ? "+" : ""}${n}`;
}

// Luck in plain words, for your team's summary line.
function luckWords(luck) {
  if (luck >= 1) return "the schedule has helped you";
  if (luck <= -1) return "the schedule has cost you";
  return "your record is about what your scores earned";
}

// Green for lucky, red for unlucky, nothing when it's under half a game.
function luckClass(luck) {
  if (luck >= 1) return "good-2";
  if (luck >= 0.5) return "good-1";
  if (luck <= -1) return "bad-2";
  if (luck <= -0.5) return "bad-1";
  return "";
}

function Odds() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        // Scores, schedule, and credit for trades already made (rosterTrades.js)
        const json = await loadOddsData();
        if (json.error) setError(json.error);
        else setData(json);
      } catch (err) {
        setError(err.message);
      }
    }
    load();
  }, []);

  // The simulation takes a moment, so it only reruns when the data changes,
  // not every time the page redraws. useMemo remembers the last answer.
  const results = useMemo(() => {
    if (!data) return null;
    const luck = allPlay(data);
    const odds = simulate(data);
    const me = data.teams.find((t) => t.isMine);
    const pointValue = me ? valueOfAPoint(data, me.id, odds) : null;
    return { luck, odds, pointValue };
  }, [data]);

  if (error) return <p className="message">Something went wrong: {error}</p>;
  if (!data || !results) return <p className="message">Playing out the rest of the season 10,000 times...</p>;

  const { luck, odds, pointValue } = results;
  const { strengths, spread } = teamStrengths(data);
  const me = data.teams.find((t) => t.isMine);
  const mine = me ? odds[me.id] : null;
  const myLuck = me ? luck[me.id] : null;

  // This week's game, if it hasn't been played yet.
  const thisWeek = me
    ? data.games.find((g) => g.week === data.currentWeek && g.winner === "UNDECIDED" && (g.homeId === me.id || g.awayId === me.id))
    : null;
  const oppId = thisWeek ? (thisWeek.homeId === me.id ? thisWeek.awayId : thisWeek.homeId) : null;
  const opp = data.teams.find((t) => t.id === oppId);
  const weekChance = opp ? Math.round(winChance(strengths, spread, me.id, opp.id) * 100) : null;

  // Trades whose credit hasn't faded out yet, biggest first.
  const nameOf = (id) => data.teams.find((t) => t.id === id)?.name || "Team";
  const counted = data.teams
    .filter((t) => Math.abs(strengths[t.id]?.fromTrades || 0) >= 0.1)
    .map((t) => ({
      team: t,
      now: Math.round(strengths[t.id].fromTrades * 10) / 10,
      deals: (data.rosterTrades || []).filter((r) => r.teamId === t.id),
    }))
    .sort((a, b) => Math.abs(b.now) - Math.abs(a.now));

  const rows = [...data.teams].sort((a, b) => odds[b.id].title - odds[a.id].title || odds[b.id].playoffs - odds[a.id].playoffs);
  // Byes exist when the playoff field isn't 2, 4 or 8 teams (6 teams: top 2 rest).
  const hasByes = ![2, 4, 8, 16].includes(data.season.playoffTeams);
  const gamesLeft = new Set(data.games.filter((g) => g.winner === "UNDECIDED").map((g) => g.week)).size;

  return (
    <>
      <header className="team-header">
        <div>
          <h1>Odds</h1>
          <p className="week">
            {gamesLeft > 0 ? `${gamesLeft} regular season ${gamesLeft === 1 ? "week" : "weeks"} left` : "Regular season done"} ·{" "}
            {data.season.playoffTeams} make the playoffs
          </p>
        </div>
        {mine && (
          <div className="total">
            <div className="total-label">Title odds</div>
            <div className="total-number">{mine.title}%</div>
            <div className="muted small">Playoffs {mine.playoffs}%</div>
          </div>
        )}
      </header>

      {me && mine && (
        <section className="why ss-moves">
          <div className="why-title">Where you stand</div>
          <ul className="why-lines">
            <li>
              You're {record(me.wins, me.losses, me.ties)}, but your weekly scores earned about {myLuck.expectedWins} wins,
              so {luckWords(myLuck.luck)} ({signed(myLuck.luck)} {Math.abs(myLuck.luck) === 1 ? "win" : "wins"}). Against
              everyone every week you'd be {record(luck[me.id].wins, luck[me.id].losses, luck[me.id].ties)}.
            </li>
            <li>
              Expected to finish with about {mine.avgWins} wins as roughly the {Math.round(mine.avgSeed)} seed.
              {hasByes ? ` ${mine.bye}% chance at a first-round bye.` : ""}
            </li>
            {opp && (
              <li>
                This week vs {opp.name}: {weekChance}% to win.
              </li>
            )}
            {pointValue != null && (
              <li>
                Every extra point a week adds about {pointValue}% to your title odds. A trade or pickup worth +5 a week
                is worth about {Math.round(pointValue * 5 * 10) / 10}%.
              </li>
            )}
            <li>
              Making the playoffs is mostly skill. Once you're in, the best team only wins it all about a third of the time,
              so every point you squeeze out of lineups and trades counts more than it feels like.
            </li>
          </ul>
        </section>
      )}

      <section className="why trade-section">
        <div className="why-title">Luck meter and odds · every team</div>
        <div className="table-wrap">
          <table className="roster odds-table">
            <thead>
              <tr>
                <th>Team</th>
                <th className="num">Record</th>
                <th className="num" title="Record if you played every team every week">All-play</th>
                <th className="num" title="Real wins minus the wins your scores earned">Luck</th>
                <th className="num">PF</th>
                <th className="num">Playoffs</th>
                <th className="num">Title</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const l = luck[t.id];
                const o = odds[t.id];
                return (
                  <tr key={t.id} className={t.isMine ? "odds-mine" : ""}>
                    <td className="player-name">{t.name}</td>
                    <td className="num">{record(t.wins, t.losses, t.ties)}</td>
                    <td className="num" title={`${l.pct}% of all matchups won, ${l.topScores} top score${l.topScores === 1 ? "" : "s"} of the week`}>
                      {record(l.wins, l.losses, l.ties)}
                    </td>
                    <td className={`num ${luckClass(l.luck)}`} title={`${l.expectedWins} wins earned by scores`}>
                      {signed(l.luck)}
                    </td>
                    <td className="num">{t.pointsFor}</td>
                    <td className="num">{o.playoffs}%</td>
                    <td className="num">
                      <strong>{o.title}%</strong>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {counted.length > 0 && (
          <div className="odds-trades">
            <div className="why-title">Trades counted before they show up in scores</div>
            <ul className="why-lines">
              {counted.map(({ team, now, deals }) => (
                <li key={team.id}>
                  <strong>{team.isMine ? "You" : nameOf(team.id)}</strong> {signed(now)}/wk:{" "}
                  {deals
                    .map((d) => `got ${d.got.join(" + ") || "nobody we track"} for ${d.gave.join(" + ") || "nobody we track"} (week ${d.week}, ${signed(d.gain)}/wk)`)
                    .join("; ")}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="game-log-key">
          All-play: your record if you played every team every week. Luck: real wins minus the wins your scores earned
          (green = the schedule helped, red = it hurt). A lucky team is weaker than its record. An unlucky team with a big
          all-play record is the one to fear in the playoffs. Odds come from playing the rest of the season and the playoffs
          10,000 times, using each team's scores (recent weeks count more), credit for trades its scores don't show yet
          (fading as it plays with the new guys), and how much weekly scores bounce around in your league (about {Math.round(spread)} points). Standings break ties with points for.
          {data.season.divisions > 1 && " Your league has divisions, which this doesn't account for yet."}
        </p>
      </section>
    </>
  );
}

export default Odds;
