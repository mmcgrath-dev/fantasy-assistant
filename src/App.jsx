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
    return <p>Something went wrong: {error}</p>;
  }

  if (!roster) {
    return <p>Loading your team...</p>;
  }

  // Once roster has data, show the team.
  // This HTML-looking code is called JSX. Anything inside { } is regular JavaScript.
  return (
    <main>
      <h1>{roster.teamName}</h1>
      <p>
        Week {roster.week} | Projected total: <strong>{roster.projectedTotal}</strong>
      </p>

      <table>
        <thead>
          <tr>
            <th>Slot</th>
            <th>Player</th>
            <th>Pos</th>
            <th>Team</th>
            <th>Proj</th>
          </tr>
        </thead>
        <tbody>
          {/* .map turns each player into a table row.
              React needs a unique "key" on each row to keep track of them. */}
          {roster.players.map((player) => (
            <tr key={player.name}>
              <td>{player.slot}</td>
              <td>{player.name}</td>
              <td>{player.position}</td>
              <td>{player.nflTeam}</td>
              <td>{player.projected}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

export default App;
