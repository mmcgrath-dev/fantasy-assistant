// useState and useEffect are React "hooks," built-in tools that give a component extra powers.
import { useState, useEffect, Fragment } from "react";
import "./App.css";
import { buildWhy } from "./why.js";
import { injurySummary } from "./injury.js";
import Trades from "./Trades.jsx";

// The small label on each roster row, like "Role ▼" in red.
// It comes from the same rules as the Why box (buildWhy in why.js), so the row
// and the panel always agree. Hovering shows the full takeaway.
// "--" means there's nothing to compare yet (kicker, D/ST, or under 4 team games).
function RowTag({ context, injury }) {
  if (!context) return <span className="tag-none">--</span>;

  const { verdict, tag } = buildWhy(context, injury);
  if (!tag) return <span className="tag-none">Steady</span>;

  return (
    <span className={`tag tag-${tag.tone}`} title={verdict || ""}>
      {tag.label}
    </span>
  );
}

// ---------- Colors for the game log ----------
// Each function takes a number and returns a CSS class name.
// The classes (in App.css) go from strong green (great) to strong red (bad).

// Weekly rank at his position: 1 = best player at his position that week.
// 1-10 is a "1" week in a 10-team league (an RB1 week for a back), 11-20 a "2" week, and so on.
function rankColor(rank) {
  if (rank == null) return "";
  if (rank <= 10) return "good-2";
  if (rank <= 20) return "good-1";
  if (rank <= 30) return "neutral";
  if (rank <= 40) return "bad-1";
  return "bad-2";
}

// Defense softness: 1 = gives up the most points to his position (great matchup),
// 32 = gives up the least (tough matchup). Split into four groups of 8.
function defenseColor(softnessRank) {
  if (softnessRank == null) return "";
  if (softnessRank <= 8) return "good-2";
  if (softnessRank <= 16) return "good-1";
  if (softnessRank <= 24) return "bad-1";
  return "bad-2";
}

// vs DEF: points above (+) or below (-) what that defense usually allows.
function vsDefColor(vsDef) {
  if (vsDef == null) return "";
  if (vsDef >= 5) return "good-2";
  if (vsDef > 0) return "good-1";
  if (vsDef > -5) return "bad-1";
  return "bad-2";
}

// Shows a blank cell as "-" instead of nothing.
function show(value) {
  return value == null ? "-" : value;
}

// Adds two stats that might be blank (blank counts as 0). Used for total TDs.
function add(a, b) {
  if (a == null && b == null) return null;
  return (a || 0) + (b || 0);
}

// Average of one stat across a list of games, rounded to one decimal.
// Blank games are skipped so they don't count as zeros.
function average(games, getValue) {
  const values = games.map(getValue).filter((v) => v != null);
  if (values.length === 0) return null;
  const total = values.reduce((sum, v) => sum + v, 0);
  return Math.round((total / values.length) * 10) / 10;
}

// Puts a + in front of positive numbers so +2.7 and -2.7 are easy to tell apart.
function plusMinus(value) {
  if (value == null) return "-";
  return value > 0 ? `+${value}` : value;
}

// ---------- Which columns each position gets ----------
// Each column is an object:
//   label: the header
//   value: how to get this column's number out of one game
//   color: (optional) which tint that game's cell gets
//   hint:  (optional) the hover popup for that game's cell
//   avg:   (optional) false to leave this column blank in the season average row
// Wk and Opp are always first, and PPR, Rank and vs Def always last,
// so only the middle part changes by position.

const SNAPS = {
  label: "Snap%",
  value: (g) => g.snapPct,
  color: (g) => rankColor(g.snapRank),
  hint: (g) => `${g.position}${g.snapRank} in snap share that week`,
};

// Builds a column that's colored by one of the weekly ranks.
// label: header, value: the stat, rankOf: which rank colors it, what: words for the hover popup.
function ranked(label, value, rankOf, what) {
  return {
    label,
    value,
    color: (g) => rankColor(rankOf(g)),
    hint: (g) => (rankOf(g) ? `${g.position}${rankOf(g)} in ${what} that week` : ""),
  };
}

const POSITION_COLUMNS = {
  QB: [
    SNAPS,
    {
      label: "Cmp/Att",
      value: (g) => (g.attempts == null ? null : `${g.completions}/${g.attempts}`),
      avg: false,
    },
    ranked("Pass Yds", (g) => g.passYards, (g) => g.passYardsRank, "passing yards"),
    ranked("Pass TD", (g) => g.passTds, (g) => g.passTdsRank, "passing TDs"),
    // For INTs, rank 1 means the fewest picks, so green still means good.
    ranked("INT", (g) => g.interceptions, (g) => g.intRank, "fewest INTs"),
    ranked("Rush Yds", (g) => g.rushYards, (g) => g.rushYardsRank, "rushing yards"),
    // A rushing TD is worth 6 for a QB vs 4 for a passing TD, so it matters a lot.
    // TDs aren't colored: most players score 0 or 1, so the ranks are mostly ties.
    { label: "Rush TD", value: (g) => g.rushTds },
  ],
  RB: [
    SNAPS,
    ranked("Car", (g) => g.carries, (g) => g.carriesRank, "carries"),
    ranked("Rush Yds", (g) => g.rushYards, (g) => g.rushYardsRank, "rushing yards"),
    ranked("Tar", (g) => g.targets, (g) => g.targetsRank, "targets"),
    ranked("Rec", (g) => g.receptions, (g) => g.receptionsRank, "catches"),
    ranked("Rec Yds", (g) => g.recYards, (g) => g.recYardsRank, "receiving yards"),
    { label: "TD", value: (g) => add(g.rushTds, g.recTds) },
    ranked("Touch", (g) => g.touches, (g) => g.touchRank, "touches"),
  ],
  WR: [
    SNAPS,
    ranked("Tar", (g) => g.targets, (g) => g.targetsRank, "targets"),
    ranked("Rec", (g) => g.receptions, (g) => g.receptionsRank, "catches"),
    ranked("Yds", (g) => g.recYards, (g) => g.recYardsRank, "receiving yards"),
    { label: "TD", value: (g) => add(g.rushTds, g.recTds) },
    ranked("Tar%", (g) => g.targetShare, (g) => g.targetShareRank, "target share"),
  ],
};
// Tight ends get the same columns as receivers.
POSITION_COLUMNS.TE = POSITION_COLUMNS.WR;

// The "Why" box at the top of the panel: a one-line takeaway plus the evidence.
// The rules that write these sentences live in why.js.
function Why({ context, injury }) {
  const { verdict, lines } = buildWhy(context, injury);
  if (lines.length === 0) return null;

  return (
    <div className="why">
      <div className="why-title">Why · last 2 games vs the 2 before</div>
      {verdict && <p className="why-verdict">{verdict}</p>}
      <ul className="why-lines">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

// The Injury box: this week's report, his history this season, and how he
// played in games while hurt. Only shows if he's been on a report this season.
function Injury({ injury }) {
  if (!injury) return null;

  return (
    <div className="why injury">
      <div className="why-title">Injury report</div>
      <ul className="why-lines">
        <li>{injury.statusLine}</li>
        <li>{injury.historyLine}</li>
        {injury.compareLine && <li>{injury.compareLine}</li>}
      </ul>
    </div>
  );
}

// The Matchup box: where he gets the ball this season (targets, and carries
// for backs), lined up against what this week's defense gives up on plays
// going to those same spots. The numbers come from get_matchup_areas in the
// database (16_matchup_areas.sql).
//   edgePerGame: about how many more (+) or fewer (-) PPR points he should get
//                than against an average defense. For backs it's the receiving
//                part (edgeTargets) plus the running part (edgeRuns).
const SMALL_SAMPLE = 10; // fewer plays than this faced in a spot = take it with a grain of salt

// Points per target always with 2 decimals, so 1.5 shows as 1.50 and lines up with 1.53.
function twoDecimals(value) {
  return value == null ? "-" : Number(value).toFixed(2);
}

// Yards per carry with 1 decimal, so 4 shows as 4.0.
function oneDecimal(value) {
  return value == null ? "-" : Number(value).toFixed(1);
}

// +0.7 / -0.8 / 0
function signed(value) {
  return `${value > 0 ? "+" : ""}${value}`;
}

// The headline, from the total edge.
function matchupHeadline(m) {
  const edge = m.edgePerGame;
  const amount = `${signed(edge)} PPR vs an average defense`;
  if (edge >= 1) return `Great spot (${amount}).`;
  if (edge >= 0.4) return `Good spot (${amount}).`;
  if (edge > -0.4) return `About an average matchup (${amount}).`;
  if (edge > -1) return `Tougher spot (${amount}).`;
  return `Tough spot (${amount}).`;
}

// One line about his most common spot, like
// "45% of his carries go middle, where SEA ranks 32nd of 32 (toughest)."
function topSpotLine(spots, kind, opponent) {
  const top = spots[0];
  if (!top || !top.defRank) return null;
  const what = kind === "run" ? "carries go" : "targets go";
  const ease = top.defRank <= 8 ? " (one of the easiest)" : top.defRank >= 25 ? " (one of the toughest)" : "";
  const where = top.area === "middle" ? "up the middle" : top.area;
  return `${top.hisShare}% of his ${what} ${where}, where ${opponent} ranks ${top.defRank} of 32${ease}.`;
}

// One table: his targets by area, or his carries by lane.
function SpotTable({ spots, kind, opponent, pos }) {
  const isRun = kind === "run";
  return (
    <table className="matchup-table">
      <thead>
        <tr>
          <th>{isRun ? "Run lane" : "Target area"}</th>
          <th className="num">{isRun ? "His carries" : "His targets"}</th>
          <th className="num">{opponent} rank</th>
          <th className="num">{isRun ? `${opponent} yds/carry` : `${opponent} per target`}</th>
          <th className="num">Avg defense</th>
        </tr>
      </thead>
      <tbody>
        {spots.map((s) => {
          const small = s.defCount != null && s.defCount < SMALL_SAMPLE;
          const what = isRun ? `RB carries ${s.area}` : `throws ${s.area} to ${pos}s`;
          return (
            <tr key={s.area}>
              <td className="matchup-area">{s.area}</td>
              <td className="num">
                {s.hisCount} <span className="muted">({s.hisShare}%)</span>
              </td>
              <td
                className={`num ${defenseColor(s.defRank)}`}
                title={
                  s.defRank
                    ? `${s.defRank} of 32 on ${what} (1 = easiest)` +
                      (small ? `. Only ${s.defCount} faced here, so it's toned down.` : "")
                    : `${opponent} hasn't faced any ${what} yet`
                }
              >
                {s.defRank ? `${s.defRank}${small ? "*" : ""}` : "-"}
              </td>
              <td className="num">{isRun ? oneDecimal(s.defPerPlay) : twoDecimals(s.defPerPlay)}</td>
              <td className="num muted">{isRun ? oneDecimal(s.leaguePerPlay) : twoDecimals(s.leaguePerPlay)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Matchup({ matchup, pos }) {
  if (!matchup) return null;
  const m = matchup;
  const tone = m.edgePerGame >= 0.4 ? "good" : m.edgePerGame <= -0.4 ? "bad" : "neutral";
  const hasRuns = m.runs.length > 0;

  // Under the headline: what each half is worth, and his main spot for each.
  const lines = [];
  if (hasRuns) {
    lines.push(`Receiving: ${signed(m.edgeTargets)}. ${topSpotLine(m.targets, "target", m.opponent) || ""}`);
    lines.push(`Running: ${signed(m.edgeRuns)}. ${topSpotLine(m.runs, "run", m.opponent) || ""}`);
  } else {
    const line = topSpotLine(m.targets, "target", m.opponent);
    if (line) lines.push(line);
  }

  return (
    <div className={`why matchup matchup-${tone}`}>
      <div className="why-title">
        Matchup · Week {m.week} vs {m.opponent} · where he gets the ball
      </div>
      <p className="why-verdict">{matchupHeadline(m)}</p>
      {lines.length > 0 && (
        <ul className="why-lines">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {m.targets.length > 0 && <SpotTable spots={m.targets} kind="target" opponent={m.opponent} pos={pos} />}
      {hasRuns && <SpotTable spots={m.runs} kind="run" opponent={m.opponent} pos={pos} />}
      <p className="game-log-key">
        Rank is out of 32, 1 = easiest. * = small sample, toned down. Short is under 15 air yards, deep is 15+.
        {hasRuns && " Run lanes are ranked on yards per carry (TDs are too random to judge a defense by)."}
      </p>
    </div>
  );
}

// The panel that opens under a player's row: the Why box, the Injury box,
// the Matchup box, then one line per game this season, plus his season average at the bottom.
function GameLog({ games, context, injury, matchup }) {
  const pos = games[0].position;
  const middleColumns = POSITION_COLUMNS[pos] || POSITION_COLUMNS.WR;

  return (
    <div className="game-log">
      <Why context={context} injury={injury} />
      <Injury injury={injury} />
      <Matchup matchup={matchup} pos={pos} />
      <div className="game-log-scroll">
        <table className="game-log-table">
          <thead>
            <tr>
              <th>Wk</th>
              <th>Opp</th>
              {middleColumns.map((col) => (
                <th key={col.label} className="num">{col.label}</th>
              ))}
              <th className="num">PPR</th>
              <th className="num">Rank</th>
              <th className="num">vs Def</th>
            </tr>
          </thead>
          <tbody>
            {games.map((game) => (
              <tr key={game.week}>
                <td>{game.week}</td>
                <td
                  className={defenseColor(game.softnessRank)}
                  title={game.softnessRank ? `${game.softnessRank} of 32 for points allowed to ${pos}s (1 = easiest)` : ""}
                >
                  {game.opponent}
                </td>
                {middleColumns.map((col) => (
                  <td
                    key={col.label}
                    className={`num ${col.color ? col.color(game) : ""}`}
                    title={col.hint ? col.hint(game) : ""}
                  >
                    {show(col.value(game))}
                  </td>
                ))}
                <td className={`num ${rankColor(game.pointsRank)}`}>{show(game.points)}</td>
                <td className={`num ${rankColor(game.pointsRank)}`}>
                  {game.pointsRank ? `${pos}${game.pointsRank}` : "-"}
                </td>
                <td className={`num ${vsDefColor(game.vsDef)}`}>{plusMinus(game.vsDef)}</td>
              </tr>
            ))}

            {/* Season average row. No colors, it's the baseline to compare each week to. */}
            <tr className="avg-row">
              <td colSpan={2}>Avg</td>
              {middleColumns.map((col) => (
                <td key={col.label} className="num">
                  {col.avg === false ? "" : show(average(games, col.value))}
                </td>
              ))}
              <td className="num">{show(average(games, (g) => g.points))}</td>
              <td className="num"></td>
              <td className="num">{plusMinus(average(games, (g) => g.vsDef))}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="game-log-key">
        Green is a top 10 {pos} week, red is 31st or worse. Opp color is how easy that defense is for {pos}s.
        vs Def is his points minus what that defense usually allows to {pos}s. Hover a cell for more.
      </p>
    </div>
  );
}

// A component is a function that returns what should appear on the page.
// App is the main component, the whole page lives inside it.
function MyTeam() {
  // STATE: values React keeps track of. When state changes, React redraws the page.
  // roster starts as null (nothing loaded yet). setRoster is how we change it.
  const [roster, setRoster] = useState(null);
  const [error, setError] = useState(null);
  // Which player's game log is open. null = none. Only one opens at a time.
  const [openPlayer, setOpenPlayer] = useState(null);

  // EFFECT: code that runs after the page first appears.
  // The empty [] at the end means "only run this once," not on every redraw.
  useEffect(() => {
    async function loadRoster() {
      try {
        // Ask OUR back end (the Netlify Function), not ESPN directly.
        const response = await fetch("/.netlify/functions/roster");
        const data = await response.json();

        if (data.error) {
          setError(data.error);
        } else {
          setRoster(data); // This triggers a redraw with the real data
        }
      } catch (err) {
        setError(err.message);
      }
    }

    loadRoster();
  }, []);

  // While waiting or if something broke, show a simple message instead of the table.
  if (error) {
    return <p className="message">Something went wrong: {error}</p>;
  }

  if (!roster) {
    return <p className="message">Loading your team...</p>;
  }

  // Once roster has data, show the team.
  // This HTML-looking code is called JSX. Anything inside { } is regular JavaScript.
  // In JSX, CSS classes use className instead of class.
  return (
    <>
      <header className="team-header">
        <div>
          <h1>{roster.teamName}</h1>
          <p className="week">Week {roster.week}</p>
        </div>
        <div className="total">
          <div className="total-label">Projected</div>
          <div className="total-number">{roster.projectedTotal}</div>
        </div>
      </header>

      <div className="table-wrap">
        <table className="roster">
          <thead>
            <tr>
              <th>Slot</th>
              <th>Player</th>
              <th>Pos</th>
              <th>Team</th>
              <th>Status</th>
              <th className="num">Trend</th>
              <th className="num">Proj</th>
            </tr>
          </thead>
          <tbody>
            {/* .map turns each player into a table row.
                React needs a unique "key" on each row to keep track of them.
                Bench and IR rows get the "bench" class so the CSS can fade them. */}
            {roster.players.map((player) => {
              // Kickers, D/ST and anyone without games have nothing to open.
              const hasLog = player.gameLog.length > 0;
              // His injury reports turned into sentences (null if he's never been on one).
              const injury = injurySummary(player.injuries, player.gameLog, roster.week);
              const isOpen = openPlayer === player.espnId;

              // Clicking an open player closes him, clicking anyone else opens them.
              function toggle() {
                if (!hasLog) return;
                setOpenPlayer(isOpen ? null : player.espnId);
              }

              // Fragment groups the player row and his panel row without adding
              // an extra tag to the page (a table can't have a <div> between rows).
              return (
                <Fragment key={player.espnId}>
                  <tr
                    className={`${player.starter ? "" : "bench"} ${hasLog ? "clickable" : ""} ${isOpen ? "open" : ""}`}
                    onClick={toggle}
                  >
                    <td className="slot">{player.slot}</td>
                    <td className="player-name">
                      {/* Small arrow that points right when closed and down when open. */}
                      {hasLog && <span className="chevron">{isOpen ? "▾" : "▸"}</span>}
                      {player.name}
                    </td>
                    <td>{player.position}</td>
                    <td>{player.nflTeam}</td>
                    <td>
                      {/* && means "only show this if status isn't empty."
                          The class becomes status-Q, status-BYE, and so on, so each gets its own color. */}
                      {player.status && (
                        <span className={`status status-${player.status}`}>{player.status}</span>
                      )}
                    </td>
                    {/* Short trend label (see RowTag at the top of this file). */}
                    <td className="num trend-cell">
                      <RowTag context={player.roleContext} injury={injury} />
                    </td>
                    {/* The ? : is a short if/else. If they're on bye, show "--", otherwise their points. */}
                    <td className="num">{player.status === "BYE" ? "--" : player.projected}</td>
                  </tr>

                  {/* The panel: one extra row stretched across all 7 columns. */}
                  {isOpen && (
                    <tr className="log-row">
                      <td colSpan={7}>
                        <GameLog
                          games={player.gameLog}
                          context={player.roleContext}
                          injury={injury}
                          matchup={player.matchup}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// The whole app: tabs at the top, then whichever page is picked.
// Only the picked page is on screen, so the Trades page only asks ESPN for the
// whole league when you open it.
function App() {
  const [page, setPage] = useState("team");

  return (
    <main className="app">
      <nav className="tabs">
        <button className={page === "team" ? "tab active" : "tab"} onClick={() => setPage("team")}>
          My Team
        </button>
        <button className={page === "trades" ? "tab active" : "tab"} onClick={() => setPage("trades")}>
          Trades
        </button>
      </nav>
      {page === "team" ? <MyTeam /> : <Trades />}
    </main>
  );
}

export default App;
