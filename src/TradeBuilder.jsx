// TradeBuilder.jsx
// Build a trade yourself and see what it does: pick your players, pick a team
// and their players, and get the same breakdown the suggested trades show
// (points a week for both sides, title odds, lineup before and after, the
// reasons), plus whether they'd likely say yes and why.
//
// "Save to compare" keeps a deal in a table under it, so you can try
// Taylor for Gordon + Deebo, save it, swap Deebo for Rice, save that, and
// see both side by side. Click a saved row to load it back.
//
// The scoring is evaluateTrade in tradeEngine.js: the same math as the
// suggestions, just for the exact players you picked.

import { useState, useEffect, useMemo } from "react";
import { tradeCall } from "./tradeCalls.js";
import { offenseInfo } from "./offense.js";
import { addHealth, healthTag } from "./health.js";
import { evaluateTrade } from "./tradeEngine.js";
import { TradeCard } from "./Trades.jsx";
import TitleOdds from "./TitleOdds.jsx";

const POSITIONS = ["RB", "WR", "TE"];

// Same build the Trades page does: offenses, health, and every player's call.
function prepareLeague(data) {
  const offenses = {};
  const byeWeeks = {};
  for (const [team, row] of Object.entries(data.offenses || {})) {
    offenses[team] = offenseInfo(team, row);
    byeWeeks[team] = row.byeWeek;
  }
  addHealth(data.teams.flatMap((team) => team.players), byeWeeks, data.week);
  return data.teams.map((team) => ({
    ...team,
    players: team.players.map((p) => {
      const offense = offenses[p.nflTeam] || null;
      return { ...p, offense, byeWeek: byeWeeks[p.nflTeam] ?? null, callInfo: tradeCall(p.signals, p.position, p, offense) };
    }),
  }));
}

// Only players the trade math can score: RB, WR, TE with enough games.
function tradeable(team) {
  return team.players
    .filter((p) => p.callInfo && POSITIONS.includes(p.position))
    .sort((a, b) => b.callInfo.value - a.callInfo.value);
}

function optionLabel(p, week) {
  const tag = healthTag(p.health, week);
  return `${p.name} · ${p.position} · ${p.callInfo.value}/wk${tag ? ` · ${tag}` : ""}`;
}

// One side's picked players as removable chips.
function Picked({ players, onRemove, week }) {
  if (players.length === 0) return <p className="muted small">Nobody yet.</p>;
  return (
    <ul className="builder-picked">
      {players.map((p) => {
        const tag = healthTag(p.health, week);
        return (
          <li key={p.espnId}>
            <span className="trade-name">{p.name}</span>
            <span className="muted small">
              {" "}
              {p.position} · {p.nflTeam} · {p.callInfo.value}/wk
            </span>
            {tag && <span className="hurt-tag">{tag}</span>}
            <button className="builder-remove" aria-label={`Remove ${p.name}`} onClick={() => onRemove(p.espnId)}>
              ✕
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function verdictClass(verdict) {
  if (verdict === "Likely yes") return "good";
  if (verdict === "Likely no") return "bad";
  return "neutral";
}

function TradeBuilder() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [giveIds, setGiveIds] = useState([]);
  const [teamId, setTeamId] = useState("");
  const [getIds, setGetIds] = useState([]);
  const [saved, setSaved] = useState([]); // deals kept for comparing

  useEffect(() => {
    async function load() {
      try {
        const response = await fetch("/.netlify/functions/trades");
        const json = await response.json();
        if (json.error) setError(json.error);
        else setData(json);
      } catch (err) {
        setError(err.message);
      }
    }
    load();
  }, []);

  // The league only gets built once per load, not on every click.
  const teams = useMemo(() => (data ? prepareLeague(data) : null), [data]);
  // Score the current deal whenever either side changes.
  const result = useMemo(() => {
    if (!teams || giveIds.length === 0 || getIds.length === 0) return null;
    const season = data.season || { playoffTeams: 4, regularSeasonWeeks: 14 };
    return evaluateTrade(teams, data.slots, season, data.week, giveIds, getIds);
  }, [teams, data, giveIds, getIds]);

  if (error) return <p className="message">Something went wrong: {error}</p>;
  if (!teams) return <p className="message">Loading the league...</p>;

  const me = teams.find((t) => t.isMine);
  const myOptions = tradeable(me).filter((p) => !giveIds.includes(p.espnId));
  const others = teams.filter((t) => !t.isMine).sort((a, b) => a.name.localeCompare(b.name));
  const team = others.find((t) => String(t.id) === teamId) || null;
  const theirOptions = team ? tradeable(team).filter((p) => !getIds.includes(p.espnId)) : [];
  const byId = (list, ids) => ids.map((id) => list.find((p) => p.espnId === id)).filter(Boolean);
  const giving = byId(tradeable(me), giveIds);
  const getting = team ? byId(tradeable(team), getIds) : [];

  // Picking a different team starts their side over (a trade is with one team).
  function pickTeam(id) {
    setTeamId(id);
    setGetIds([]);
  }

  const key = (r) => `${r.team.id}|${r.give.map((p) => p.espnId).join()}|${r.get.map((p) => p.espnId).join()}`;

  function save() {
    if (!result || saved.some((s) => key(s) === key(result))) return;
    setSaved([...saved, result]);
  }

  function load(r) {
    setGiveIds(r.give.map((p) => p.espnId));
    setTeamId(String(r.team.id));
    setGetIds(r.get.map((p) => p.espnId));
  }

  return (
    <>
      <header className="team-header">
        <div>
          <h1>Build a Trade</h1>
          <p className="week">Week {data.week} · put a deal together and see what it does</p>
        </div>
      </header>

      <div className="builder-grid">
        <section className="why builder-side">
          <div className="why-title">You give</div>
          <Picked players={giving} week={data.week} onRemove={(id) => setGiveIds(giveIds.filter((x) => x !== id))} />
          <select
            className="builder-select"
            value=""
            onChange={(e) => e.target.value && setGiveIds([...giveIds, e.target.value])}
          >
            <option value="">+ Add one of your players</option>
            {myOptions.map((p) => (
              <option key={p.espnId} value={p.espnId}>
                {optionLabel(p, data.week)}
              </option>
            ))}
          </select>
        </section>

        <section className="why builder-side">
          <div className="why-title">You get</div>
          <select className="builder-select" value={teamId} onChange={(e) => pickTeam(e.target.value)}>
            <option value="">Pick a team</option>
            {others.map((t) => (
              <option key={t.id} value={String(t.id)}>
                {t.name} ({t.wins}-{t.losses})
              </option>
            ))}
          </select>
          {team && (
            <>
              <Picked players={getting} week={data.week} onRemove={(id) => setGetIds(getIds.filter((x) => x !== id))} />
              <select
                className="builder-select"
                value=""
                onChange={(e) => e.target.value && setGetIds([...getIds, e.target.value])}
              >
                <option value="">+ Add one of their players</option>
                {theirOptions.map((p) => (
                  <option key={p.espnId} value={p.espnId}>
                    {optionLabel(p, data.week)}
                  </option>
                ))}
              </select>
            </>
          )}
        </section>
      </div>

      {!result && (
        <p className="muted builder-hint">
          Add at least one player on each side. RB, WR and TE with 4+ games only, since those are the ones the trade math
          can score.
        </p>
      )}

      {result && (
        <>
          <section className={`why builder-verdict verdict-${verdictClass(result.verdict)}`}>
            <div className="builder-verdict-head">
              <div>
                <div className="why-title">Would they say yes?</div>
                <p className="why-verdict">{result.verdict}</p>
              </div>
              <button className="shop-button" onClick={save} disabled={saved.some((s) => key(s) === key(result))}>
                {saved.some((s) => key(s) === key(result)) ? "Saved" : "Save to compare"}
              </button>
            </div>
            <ul className="builder-checks">
              {result.checks.map((c) => (
                <li key={c.text} className={c.ok ? "check-ok" : "check-miss"}>
                  <span aria-hidden="true">{c.ok ? "✓" : "✗"}</span> {c.text}
                </li>
              ))}
            </ul>
            <p className={`builder-foryou ${result.forYou.ok ? "check-ok" : "check-miss"}`}>
              <strong>For you:</strong> {result.forYou.text}
            </p>
          </section>

          <ul className="trade-list">
            <TradeCard trade={result} />
          </ul>
        </>
      )}

      {saved.length > 0 && (
        <section className="why trade-section">
          <div className="why-title">Compare</div>
          <div className="table-wrap">
            <table className="roster compare-table">
              <thead>
                <tr>
                  <th>Deal</th>
                  <th className="num">You</th>
                  <th className="num">Them</th>
                  <th className="num">Title</th>
                  <th>They'd say</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {saved.map((r) => (
                  <tr key={key(r)} className={result && key(r) === key(result) ? "odds-mine" : "clickable"} onClick={() => load(r)}>
                    <td className="compare-deal">
                      {r.give.map((p) => p.name).join(" + ")} ⇄ {r.get.map((p) => p.name).join(" + ")}
                      <span className="muted small"> · {r.team.name}</span>
                    </td>
                    <td className="num">{r.myGain > 0 ? "+" : ""}{r.myGain}</td>
                    <td className="num">{r.theirGain > 0 ? "+" : ""}{r.theirGain}</td>
                    <td className="num">
                      <TitleOdds trade={r} compact />
                    </td>
                    <td className={`verdict-text-${verdictClass(r.verdict)}`}>{r.verdict}</td>
                    <td>
                      <button
                        className="builder-remove"
                        aria-label="Remove from compare"
                        onClick={(e) => {
                          e.stopPropagation(); // don't load it
                          setSaved(saved.filter((s) => key(s) !== key(r)));
                        }}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="game-log-key">
            You and Them are points a week the rest of the way (yours by our numbers, theirs by what they'd look at).
            Title is the change in your championship odds. Click a row to load that deal back up.
          </p>
        </section>
      )}
    </>
  );
}

export default TradeBuilder;
