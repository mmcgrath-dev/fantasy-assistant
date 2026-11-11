// StartSit.jsx
// The Start/Sit page: your best lineup this week, what to change from the
// lineup you have set on ESPN, and why for every player.
//
// It doesn't need a new Netlify function. It asks the two that already exist
// at the same time and joins them by ESPN ID:
//   /roster  your players, ESPN projections, game logs, role context,
//            injury history and this week's matchup areas
//   /trades  each player's rest-of-season value (tradeCall), his schedule
//            with defense softness and Vegas totals, his floor and ceiling,
//            and how every offense is playing
// The scoring rules live in startSit.js.

import { useState, useEffect } from "react";
import { tradeCall } from "./tradeCalls.js";
import { offenseInfo } from "./offense.js";
import { scorePlayer, buildLineup, lineupMoves, weekTiming } from "./startSit.js";
import { healthOf, latestWeekPlayed } from "./health.js";

// Puts one player's info from both functions together and scores him.
function mergePlayers(roster, trades) {
  const mine = trades.teams.find((t) => t.isMine);
  const extras = {};
  for (const p of mine ? mine.players : []) extras[p.espnId] = p;
  // The newest week anyone in the league has played, for counting missed games.
  const latestWeek = latestWeekPlayed(trades.teams.flatMap((team) => team.players));

  return roster.players.map((p) => {
    const t = extras[p.espnId] || {};
    const offenseRow = trades.offenses?.[p.nflTeam] || null;
    const offense = offenseRow ? offenseInfo(p.nflTeam, offenseRow) : null;
    const merged = {
      ...p,
      signals: t.signals || null,
      weeks: t.weeks || null,
      consistency: t.consistency || null,
      offenseRow,
    };
    // Hurt or missing games (health.js), same rules as the Trades page.
    merged.health = healthOf(merged, { latestWeek, byeWeek: offenseRow?.byeWeek ?? null, currentWeek: roster.week });
    merged.callInfo = t.signals ? tradeCall(t.signals, p.position, { ...t, health: merged.health }, offense) : null;
    merged.sit = scorePlayer(merged, roster.week);
    return merged;
  });
}

// How many of each spot you start. RB, WR, TE and FLEX come from your league
// settings (trades.js reads them from ESPN). QB, D/ST and K are one each,
// as long as you have one rostered.
function lineupSlots(players, slots) {
  const has = (pos) => players.some((p) => p.position === pos);
  return {
    QB: 1,
    RB: slots?.RB ?? 2,
    WR: slots?.WR ?? 2,
    TE: slots?.TE ?? 1,
    FLEX: slots?.FLEX ?? 1,
    "D/ST": has("D/ST") ? 1 : 0,
    K: has("K") ? 1 : 0,
  };
}

function Details({ player, alt, margin, tiebreak, sitReason }) {
  const s = player.sit;
  return (
    <div className="ss-details">
      {s.warnings.length > 0 && (
        <ul className="why-lines ss-warnings">
          {s.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <ul className="why-lines">
        {s.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
        {s.floor != null && s.ceiling != null && (
          <li>
            Bad week {s.floor}, good week {s.ceiling} this season.
          </li>
        )}
        {alt && (
          <li>
            Next man up on your bench: {alt.name} ({alt.sit.score}), {margin} behind.
          </li>
        )}
        {sitReason && <li>{sitReason}</li>}
      </ul>
      {tiebreak && <p className="ss-tiebreak">{tiebreak}</p>}
    </div>
  );
}

// One player row that opens to show the why.
function PlayerRow({ slot, player, row, bench }) {
  const [open, setOpen] = useState(false);
  if (!player) {
    return (
      <li className="ss-row">
        <div className="ss-row-top">
          <span className="ss-slot">{slot}</span>
          <span className="muted">Empty. Nobody healthy can play here, check waivers.</span>
        </div>
      </li>
    );
  }
  const s = player.sit;
  const moved = bench ? player.starter : !player.starter;

  return (
    <li className={`ss-row${bench ? " ss-bench" : ""}`}>
      <button className="row-toggle ss-row-top" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="ss-slot">{slot}</span>
        <span className="ss-player">
          <span className="chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
          <span className="trade-name">{player.name}</span>
          <span className="muted small">
            {" "}
            {player.position} · {player.nflTeam}
            {s.opp ? ` · ${s.opp}` : ""}
          </span>
          {player.status && <span className={`status status-${player.status}`}>{player.status}</span>}
          {moved && <span className={`ss-moved ${bench ? "ss-moved-out" : "ss-moved-in"}`}>{bench ? "Sit" : "Start"}</span>}
        </span>
        <span className="ss-right">
          {row?.confidence && (
            <span className={`ss-conf ss-conf-${row.confidence.tone}`} title={row.alt ? `${row.margin} ahead of ${row.alt.name}` : "Nobody healthy on your bench can play this spot"}>
              {row.confidence.label}
            </span>
          )}
          <span className="ss-score">{s.canStart ? s.score : "--"}</span>
        </span>
      </button>
      {!open && bench && player.sitReason && <div className="muted small ss-sub">{player.sitReason}</div>}
      {!open && !bench && s.warnings.length > 0 && <div className="ss-sub ss-warn-line small">{s.warnings[0]}</div>}
      {open && (
        <Details
          player={player}
          alt={row?.alt}
          margin={row?.margin}
          tiebreak={row?.tiebreak}
          sitReason={bench && s.canStart ? player.sitReason : null}
        />
      )}
    </li>
  );
}

function StartSit() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        // Both at once. Promise.all waits for both to finish.
        const [rosterRes, tradesRes] = await Promise.all([
          fetch("/.netlify/functions/roster"),
          fetch("/.netlify/functions/trades"),
        ]);
        const roster = await rosterRes.json();
        const trades = await tradesRes.json();
        if (roster.error || trades.error) setError(roster.error || trades.error);
        else setData({ roster, trades });
      } catch (err) {
        setError(err.message);
      }
    }
    load();
  }, []);

  if (error) return <p className="message">Something went wrong: {error}</p>;
  if (!data) return <p className="message">Working out your best lineup...</p>;

  const { roster, trades } = data;
  const players = mergePlayers(roster, trades);
  const best = buildLineup(players, lineupSlots(players, trades.slots));
  const { moves, currentTotal } = lineupMoves(players, best);
  const timing = weekTiming();
  const coinFlips = best.lineup.filter((r) => r.confidence?.label === "Coin flip");

  return (
    <>
      <header className="team-header">
        <div>
          <h1>Start / Sit</h1>
          <p className="week">
            Week {roster.week} · {timing.title}
          </p>
        </div>
        <div className="total">
          <div className="total-label">Best lineup</div>
          <div className="total-number">{best.total}</div>
          <div className="muted small">Yours now: {currentTotal}</div>
        </div>
      </header>

      <p className="trade-note">{timing.note}</p>

      <section className="why ss-moves">
        <div className="why-title">Changes to make on ESPN</div>
        {moves.length === 0 ? (
          <p className="why-verdict">Your ESPN lineup is already the best one. No changes.</p>
        ) : (
          <ul className="why-lines">
            {moves.map((m) => (
              <li key={(m.start?.espnId || "") + (m.sit?.espnId || "")}>
                {m.start ? (
                  <>
                    <strong className="lineup-in">Start {m.start.name}</strong>
                    {m.sit && (
                      <>
                        {" "}over <span className="lineup-out">{m.sit.name}</span>
                        {m.sit.sit.blocked ? ` (${m.sit.sit.blocked.toLowerCase()})` : ""}
                      </>
                    )}
                    <span className="trade-gain"> +{m.gain}</span>
                  </>
                ) : (
                  <>
                    <span className="lineup-out">Bench {m.sit.name}</span> ({(m.sit.sit.blocked || "not worth a spot").toLowerCase()}), but nobody healthy is left to replace him. Check waivers.
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {coinFlips.length > 0 && (
          <p className="trade-note">
            {coinFlips.length === 1 ? "1 spot is" : `${coinFlips.length} spots are`} a coin flip. Open{" "}
            {coinFlips.length === 1 ? "it" : "them"} for the tiebreaker, and look again Saturday.
          </p>
        )}
      </section>

      <section className="why trade-section">
        <div className="why-title">Best lineup</div>
        <ul className="trade-list">
          {best.lineup.map((row, i) => (
            <PlayerRow key={`${row.slot}${i}`} slot={row.slot} player={row.player} row={row} />
          ))}
        </ul>
        {/* Total of the best lineup, and how much better it is than what you have set on ESPN. */}
        <div className="ss-total">
          <span className="ss-slot">Total</span>
          <span className="ss-player muted small">
            {best.total > currentTotal
              ? `${Math.round((best.total - currentTotal) * 10) / 10} more than your ESPN lineup (${currentTotal})`
              : "Same as your ESPN lineup"}
          </span>
          <span className="ss-score">{best.total.toFixed(1)}</span>
        </div>
      </section>

      <section className="why trade-section">
        <div className="why-title">Bench</div>
        <ul className="trade-list">
          {best.bench.map((p) => (
            <PlayerRow key={p.espnId} slot={p.slot === "IR" ? "IR" : "BN"} player={p} bench />
          ))}
        </ul>
      </section>

      <p className="game-log-key">
        Score = half ESPN's projection, half our number (his value with TD luck taken out, bent by this defense, where he
        gets the ball, Vegas and his role trend). Questionable counts 90%, Doubtful 40%. Coin flip = under 1 point ahead
        of your best bench option, Lean = 1 to 3, Clear = 3+. Click anyone for the why.
      </p>
    </>
  );
}

export default StartSit;
