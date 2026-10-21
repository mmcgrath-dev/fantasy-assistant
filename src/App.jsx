// useState and useEffect are React "hooks," built-in tools that give a component extra powers.
import { useState, useEffect } from "react";
import "./App.css";

// A component is a function that returns what should appear on the page.
// App is the main component, the whole page lives inside it.
function App() {
  // STATE: values React keeps track of. When state changes, React redraws the page.
  // roster starts as null (nothing loaded yet). setRoster is how we change it.
  const [roster, setRoster] = useState(null);
  const [error, setError] = useState(null);

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
              <th className="num">Proj</th>
            </tr>
          </thead>
          <tbody>
            {/* .map turns each player into a table row.
                React needs a unique "key" on each row to keep track of them.
                Bench and IR rows get the "bench" class so the CSS can fade them. */}
            {roster.players.map((player) => (
              <tr key={player.name} className={player.starter ? "" : "bench"}>
                <td className="slot">{player.slot}</td>
                <td className="player-name">{player.name}</td>
                <td>{player.position}</td>
                <td>{player.nflTeam}</td>
                <td>
                  {/* && means "only show this if status isn't empty."
                      The class becomes status-Q, status-BYE, and so on, so each gets its own color. */}
                  {player.status && (
                    <span className={`status status-${player.status}`}>{player.status}</span>
                  )}
                </td>
                {/* The ? : is a short if/else. If they're on bye, show "--", otherwise their points. */}
                <td className="num">{player.status === "BYE" ? "--" : player.projected}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

export default App;
