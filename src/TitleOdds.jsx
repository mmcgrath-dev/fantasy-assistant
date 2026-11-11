// TitleOdds.jsx
// A small line for every trade card: "Title odds 18.2% → 21.4% (+3.2)".
//
// The league's scores, schedule and trades already made (loadOddsData in
// rosterTrades.js) are fetched once and kept,
// so ten trade cards don't mean ten trips to ESPN. Each trade's odds come from
// replaying the season with the trade in it (tradeOdds in odds.js): your lineup
// gets your +/wk, and the other team gets theirs, since making a rival better
// hurts too. If the odds can't load, the line just doesn't show.
//
// Keeping it fast:
//   - every answer is remembered, so flipping back to a trade is instant
//   - warmTitleOdds works out a whole list in the background, one trade at a
//     time between clicks, so the answers are usually ready before you look
//   - the card shows right away and the line fills in a moment later, instead
//     of the click waiting on the math

import { useState, useEffect } from "react";
import { simulate, tradeOdds } from "./odds.js";
import { loadOddsData } from "./rosterTrades.js";

let cached = null; // one shared fetch for the whole page
const answers = new Map(); // trade -> its title odds, so nothing is worked out twice

// The same deal always gets the same key: team, who goes, who comes, and the gains.
function keyOf(trade) {
  return [
    trade.team.id,
    trade.give.map((p) => p.espnId).join(),
    trade.get.map((p) => p.espnId).join(),
    trade.myGain,
    trade.theirGain,
  ].join("|");
}

function loadOdds() {
  if (!cached) {
    // Same data as the Odds page, trades already made included, so a card's
    // "before" matches the title odds there.
    cached = loadOddsData()
      .then((data) => {
        if (data.error) return null;
        const me = data.teams.find((t) => t.isMine);
        return me ? { data, me, base: simulate(data) } : null;
      })
      .catch(() => null);
  }
  return cached;
}

function answerFor(odds, trade) {
  const key = keyOf(trade);
  if (!answers.has(key)) answers.set(key, tradeOdds(odds.data, odds.me.id, trade, odds.base));
  return answers.get(key);
}

// Works out a list of trades in the background, one per pause, so a click is
// never stuck behind more than one replay of the season.
export function warmTitleOdds(trades) {
  loadOdds().then((odds) => {
    if (!odds) return;
    const todo = trades.filter((t) => !answers.has(keyOf(t)));
    function next() {
      const trade = todo.shift();
      if (!trade) return;
      answerFor(odds, trade);
      setTimeout(next, 0);
    }
    setTimeout(next, 0);
  });
}

// compact = the short version for one-line deal rows: "Title +2.1%".
export default function TitleOdds({ trade, compact = false }) {
  // Already worked out? Show it on the very first draw.
  const [result, setResult] = useState(() => answers.get(keyOf(trade)) || null);

  useEffect(() => {
    let stillHere = true; // don't update a card that's already gone
    const known = answers.get(keyOf(trade));
    if (known) {
      setResult(known);
      return;
    }
    setResult(null);
    loadOdds().then((odds) => {
      if (!stillHere) return;
      if (!odds) {
        setResult(false); // couldn't load: hide the line
        return;
      }
      // setTimeout lets the card show first; the math runs right after.
      setTimeout(() => {
        if (stillHere) setResult(answerFor(odds, trade));
      }, 0);
    });
    return () => {
      stillHere = false;
    };
  }, [trade]);

  if (result === false) return null;

  if (compact) {
    if (!result) return <span className="title-chip title-odds-neutral">Title …</span>;
    const chipTone = result.change >= 0.5 ? "good" : result.change <= -0.5 ? "bad" : "neutral";
    return (
      <span
        className={`title-chip title-odds-${chipTone}`}
        title={`Title odds ${result.before.toFixed(1)}% → ${result.after.toFixed(1)}%`}
      >
        Title {result.change > 0 ? "+" : ""}
        {result.change.toFixed(1)}%
      </span>
    );
  }

  // Same height while it's working, so the card doesn't jump when it fills in.
  if (!result) return <div className="title-odds title-odds-neutral">Title odds …</div>;

  const tone = result.change >= 0.5 ? "good" : result.change <= -0.5 ? "bad" : "neutral";
  return (
    <div className={`title-odds title-odds-${tone}`}>
      Title odds {result.before.toFixed(1)}% → {result.after.toFixed(1)}% ({result.change > 0 ? "+" : ""}
      {result.change.toFixed(1)})
      {Math.abs(result.playoffsChange) >= 1 && (
        <span className="muted small">
          {" "}
          · playoffs {result.playoffsChange > 0 ? "+" : ""}
          {result.playoffsChange}
        </span>
      )}
    </div>
  );
}
