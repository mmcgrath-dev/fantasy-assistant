// useState and useEffect are React "hooks," built-in tools that give a component extra powers.
import { useState, useEffect, Fragment } from "react";
import "./App.css";

// Arrows for each trend label from the database.
const TREND_ARROWS = { up: "▲", down: "▼", steady: "▶" };

// Shows one player's snap trend: his snap % over the last 2 games,
// plus an arrow and how many points it moved compared to the 2 games before.
// Hovering over it shows the full numbers.
// Players with no trend (kickers, D/ST, fewer than 4 games) get "--".
function SnapTrend({ snapTrend }) {
  if (!snapTrend) {
    return <span className="trend-none">--</span>;
  }

  const { last2, prior2, change, trend } = snapTrend;

  // Math.abs drops the minus sign, since the arrow already says which way it went.
  return (
    <span title={`Last 2 games: ${last2}% of snaps. 2 games before that: ${prior2}%.`}>
      {last2}%{" "}
      <span className={`trend trend-${trend}`}>
        {TREND_ARROWS[trend]} {Math.abs(change)}
      </span>
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

const POSITION_COLUMNS = {
  QB: [
    SNAPS,
    {
      label: "Cmp/Att",
      value: (g) => (g.attempts == null ? null : `${g.completions}/${g.attempts}`),
      avg: false,
    },
    { label: "Pass Yds", value: (g) => g.passYards },
    { label: "Pass TD", value: (g) => g.passTds },
    { label: "INT", value: (g) => g.interceptions },
    { label: "Rush Yds", value: (g) => g.rushYards },
    // A rushing TD is worth 6 for a QB vs 4 for a passing TD, so it matters a lot.
    { label: "Rush TD", value: (g) => g.rushTds },
  ],
  RB: [
    SNAPS,
    { label: "Car", value: (g) => g.carries },
    { label: "Rush Yds", value: (g) => g.rushYards },
    { label: "Tar", value: (g) => g.targets },
    { label: "Rec", value: (g) => g.receptions },
    { label: "Rec Yds", value: (g) => g.recYards },
    { label: "TD", value: (g) => add(g.rushTds, g.recTds) },
    {
      label: "Touch",
      value: (g) => g.touches,
      color: (g) => rankColor(g.touchRank),
      hint: (g) => `${g.position}${g.touchRank} in touches that week`,
    },
  ],
  WR: [
    SNAPS,
    {
      label: "Tar",
      value: (g) => g.targets,
      // For a receiver, touches are basically targets, so the touch rank colors this.
      color: (g) => rankColor(g.touchRank),
      hint: (g) => `${g.position}${g.touchRank} in touches that week`,
    },
    { label: "Rec", value: (g) => g.receptions },
    { label: "Yds", value: (g) => g.recYards },
    { label: "TD", value: (g) => add(g.rushTds, g.recTds) },
    { label: "Tar%", value: (g) => g.targetShare },
  ],
};
// Tight ends get the same columns as receivers.
POSITION_COLUMNS.TE = POSITION_COLUMNS.WR;

// The panel that opens under a player's row: one line per game this season,
// plus his season average at the bottom.
function GameLog({ games }) {
  const pos = games[0].position;
  const middleColumns = POSITION_COLUMNS[pos] || POSITION_COLUMNS.WR;

  return (
    <div className="game-log">
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
function App() {
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
    return (
      <main className="app">
        <p className="message">Something went wrong: {error}</p>
      </main>
    );
  }

  if (!roster) {
    return (
      <main className="app">
        <p className="message">Loading your team...</p>
      </main>
    );
  }

  // Once roster has data, show the team.
  // This HTML-looking code is called JSX. Anything inside { } is regular JavaScript.
  // In JSX, CSS classes use className instead of class.
  return (
    <main className="app">
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
              <th className="num">Snaps</th>
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
                    {/* Snap % trend from the database (see SnapTrend at the top of this file). */}
                    <td className="num snaps">
                      <SnapTrend snapTrend={player.snapTrend} />
                    </td>
                    {/* The ? : is a short if/else. If they're on bye, show "--", otherwise their points. */}
                    <td className="num">{player.status === "BYE" ? "--" : player.projected}</td>
                  </tr>

                  {/* The panel: one extra row stretched across all 7 columns. */}
                  {isOpen && (
                    <tr className="log-row">
                      <td colSpan={7}>
                        <GameLog games={player.gameLog} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}

export default App;
