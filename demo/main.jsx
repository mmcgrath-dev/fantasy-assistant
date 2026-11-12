// main.jsx (demo)
// The public demo's starting point. It runs your real app (../src/App.jsx)
// with two differences:
//   1. Every request the app makes to /.netlify/functions/... gets answered
//      from the frozen JSON files in demo/data/ instead of a real server.
//   2. A banner on top says it's a demo and which week the data is from.
// Nothing in src/ changes, so the real site doesn't know the demo exists.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../src/index.css";
import "./demo.css";
import App from "../src/App.jsx";
import roster from "./data/roster.json";
import trades from "./data/trades.json";
import leagueOdds from "./data/league-odds.json";

const frozen = { roster, trades, "league-odds": leagueOdds };

// The stand-in. Keep the browser's real fetch for anything else, and catch
// only the app's server calls.
const realFetch = window.fetch.bind(window);

window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url, window.location.href);
  const match = url.pathname.match(/\/\.netlify\/functions\/([\w-]+)$/);
  if (!match) return realFetch(input, init);

  const name = match[1];
  if (frozen[name]) return Response.json(frozen[name]);

  // Player search reads the whole NFL database, which the demo doesn't have.
  // League players still show up (the page finds those on its own).
  if (name === "player-search") {
    if (url.searchParams.has("id")) {
      return Response.json({ error: "The demo only has players on a team in the league." });
    }
    return Response.json({ matches: [] });
  }

  return Response.json({ error: `The demo doesn't have ${name}.` }, { status: 404 });
};

function DemoBanner() {
  return (
    <div className="demo-banner">
      Demo with real data frozen from Week {roster.week}, 2026. Other teams' names are hidden.{" "}
      <a href="https://github.com/mmcgrath-dev/fantasy-assistant">See the code on GitHub</a>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <DemoBanner />
    <App />
  </StrictMode>
);
