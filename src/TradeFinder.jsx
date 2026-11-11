// TradeFinder.jsx
// The Trade Finder tab: type any NFL player's name, get a scouting card (is he
// a buy low, a sell high, fairly priced, or stay away, with the data behind
// it), then one button that answers the money question:
//   - he's on another team in your league -> what it takes to get him
//   - he's on YOUR team                   -> who to trade him to
//   - he's a free agent                   -> nothing to trade, just add him
// The deals load automatically at the bottom of the card, no extra click.
//
// League rosters come from the trades function (one load when the tab opens).
// Players outside the league come from player-search, which reads the whole
// NFL database, so you can scout anyone.

import { useState, useEffect, useRef } from "react";
import { tradeCall } from "./tradeCalls.js";
import { offenseInfo } from "./offense.js";
import { addHealth, healthOf, latestWeekPlayed } from "./health.js";
import { findTrades } from "./tradeEngine.js";
import { warmTitleOdds } from "./TitleOdds.jsx";
import { ScheduleBox, OffenseBox, CompactTrade, labelClass } from "./Trades.jsx";

// What the label means for YOU, depending on who owns him.
function verdict(player, owned) {
  const label = player.callInfo?.label;
  if (!label) {
    return {
      tone: "hold",
      title: "No rating",
      text: "QBs, kickers, D/ST and players with under 4 games don't get trade ratings (yet).",
    };
  }
  if (owned === "mine") {
    const map = {
      "Sell high": ["sell", "Sell high", "He's scoring above what his usage supports. His price won't get better than now."],
      "Sell low": ["sell", "Sell low", "His role is fading. Get something for him before it fades more."],
      "Hold · due": ["buy", "Hold — he's due", "His usage says better days are coming. Don't sell him cheap."],
      Buy: ["buy", "Hold — he's due", "His usage says better days are coming. Don't sell him cheap."],
      Hold: ["hold", "Hold", "Fairly valued right now. Trade him only for a clear upgrade."],
      Out: ["hold", "Out", "He's been out. His old numbers don't say what his job will be when he's back."],
    };
    const [tone, title, text] = map[label] || ["hold", label, ""];
    return { tone, title, text };
  }
  // someone else's player, or a free agent: you're the buyer
  const map = {
    Buy: ["buy", "Buy low", "His usage is ahead of his points. Get him before the scoring catches up."],
    "Sell high": ["sell", "Stay away right now", "You'd be paying peak price: he's scoring above what his usage supports."],
    "Sell low": ["sell", "Only at a discount", "His role is fading. Don't pay anything close to full price."],
    Hold: ["hold", "Fairly priced", "No edge either way. Only trade for him if he fills a real hole."],
    Out: ["hold", "Wait", "He's been out, and someone else has had the job. See his role when he's back before paying."],
  };
  const [tone, title, text] = map[label] || ["hold", label, ""];
  return { tone, title, text };
}

function TradeFinder() {
  const [data, setData] = useState(null); // the league, from the trades function
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [sel, setSel] = useState(null); // the picked player, ready to show
  const [deals, setDeals] = useState(null);

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

  // Search as you type. League players match instantly on every keystroke;
  // after a short pause (so we don't hit the server on every letter) the
  // whole NFL database joins the list.
  // Each search gets a number, so a slow database answer from an OLD search
  // can't reopen the dropdown after you've already picked someone.
  const searchSeq = useRef(0);

  useEffect(() => {
    if (!data) return;
    const mySeq = ++searchSeq.current;
    const q = query.trim().toLowerCase();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    const ownedIds = new Set(data.teams.flatMap((t) => t.players.map((p) => p.espnId)));
    const inLeague = [];
    for (const team of data.teams) {
      for (const p of team.players) {
        if (p.name.toLowerCase().includes(q)) {
          inLeague.push({ espnId: p.espnId, name: p.name, position: p.position, nflTeam: p.nflTeam });
        }
      }
    }
    setResults(inLeague.slice(0, 10));
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/.netlify/functions/player-search?q=${encodeURIComponent(query.trim())}`);
        const json = await response.json();
        if (searchSeq.current !== mySeq) return; // an older search finishing late
        const outside = (json.matches || []).filter((m) => !ownedIds.has(m.espnId));
        setResults([...inLeague, ...outside].slice(0, 10));
      } catch {
        // league matches are already showing; the database just doesn't join in
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, data]);

  if (error) return <p className="message">Something went wrong: {error}</p>;
  if (!data) return <p className="message">Loading the league...</p>;

  // Same build the Trades page does: offenses, then every rostered player
  // with his offense and his call.
  const offenses = {};
  for (const [team, row] of Object.entries(data.offenses || {})) {
    offenses[team] = offenseInfo(team, row);
  }
  // Who's hurt or missing games, judged the same way on every page (health.js).
  const byeWeeks = {};
  for (const [team, row] of Object.entries(data.offenses || {})) byeWeeks[team] = row.byeWeek;
  addHealth(data.teams.flatMap((team) => team.players), byeWeeks, data.week);

  const teams = data.teams.map((team) => ({
    ...team,
    players: team.players.map((p) => {
      const offense = offenses[p.nflTeam] || null;
      const byeWeek = data.offenses?.[p.nflTeam]?.byeWeek ?? null;
      return { ...p, offense, byeWeek, callInfo: tradeCall(p.signals, p.position, p, offense) };
    }),
  }));
  const season = data.season || { playoffTeams: 4, regularSeasonWeeks: 14 };

  // Who owns whom, by ESPN player id.
  const owners = {};
  for (const team of teams) {
    for (const p of team.players) owners[p.espnId] = team;
  }

  async function pick(result) {
    searchSeq.current++; // anything still searching is out of date now
    setResults(null);
    setDeals(null);
    setQuery("");
    const owner = owners[result.espnId] || null;
    if (owner) {
      const player = owner.players.find((p) => p.espnId === result.espnId);
      setSel({ player, owner });
      // the deals load right away, so the answer is always at the bottom of the card
      if (player.callInfo) {
        const opts = owner.isMine ? { forPlayer: player.espnId } : { forTarget: player.espnId };
        const found = findTrades(teams, data.slots, season, data.week, opts);
        warmTitleOdds(found); // title odds ready by the time you open a deal
        setDeals(found);
      }
      return;
    }
    // outside the league: fetch his full packet and rate him the same way
    setSel({ loading: true });
    try {
      const response = await fetch(`/.netlify/functions/player-search?id=${encodeURIComponent(result.espnId)}`);
      const d = await response.json();
      if (d.error) {
        setSel({ failed: d.error });
        return;
      }
      const offense = offenses[d.nflTeam] || null;
      const player = {
        espnId: d.espnId,
        name: d.name,
        position: d.position,
        nflTeam: d.nflTeam,
        slot: "FA",
        injuryStatus: "ACTIVE",
        signals: d.signals,
        weeks: d.weeks,
        consistency: d.consistency,
        offense,
        byeWeek: data.offenses?.[d.nflTeam]?.byeWeek ?? null,
      };
      // Same health check as everyone in the league (missed games count here too).
      player.health = healthOf(player, {
        latestWeek: latestWeekPlayed(data.teams.flatMap((team) => team.players)),
        byeWeek: player.byeWeek,
        currentWeek: data.week,
      });
      player.callInfo = tradeCall(player.signals, player.position, player, offense);
      setSel({ player, owner: null });
    } catch (err) {
      setSel({ failed: err.message });
    }
  }

  const v = sel?.player ? verdict(sel.player, sel.owner ? (sel.owner.isMine ? "mine" : "theirs") : "fa") : null;

  return (
    <>
      <header className="team-header">
        <div>
          <h1>Trade Finder</h1>
          <p className="week">Scout any NFL player, then see the trade that gets him (or moves him).</p>
        </div>
      </header>

      <div className="finder-box">
        <label className="sr-only" htmlFor="finder-input">
          Search for a player by name or team
        </label>
        <input
          id="finder-input"
          className="finder-input"
          type="search"
          autoComplete="off"
          placeholder="Start typing a player's name or team (CIN)..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setResults(null);
            if (e.key === "Enter" && results?.length) {
              e.preventDefault();
              pick(results[0]);
            }
          }}
        />
        {results != null && (
          <ul className="finder-dropdown">
            {results.length === 0 && <li className="muted small finder-empty">Nobody by that name yet...</li>}
            {results.map((r) => (
              <li key={r.espnId}>
                <button className="finder-item" onClick={() => pick(r)}>
                  <span>
                    <span className="trade-name">{r.name}</span>
                    <span className="muted">
                      {" "}
                      {r.position} · {r.nflTeam}
                    </span>
                  </span>
                  <span className="muted small">
                    {owners[r.espnId] ? (owners[r.espnId].isMine ? "Your roster" : owners[r.espnId].name) : "Free agent"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {sel?.loading && <p className="message">Pulling his numbers...</p>}
      {sel?.failed && <p className="message">Couldn't load him: {sel.failed}</p>}

      {sel?.player && (
        <section className="why trade-section">
          <div className="trade-player-top">
            <div>
              <span className="trade-name">{sel.player.name}</span>
              <span className="muted">
                {" "}
                {sel.player.position} · {sel.player.nflTeam} ·{" "}
                {sel.owner ? (sel.owner.isMine ? "your roster" : `owned by ${sel.owner.name}`) : "free agent"}
              </span>
            </div>
            {sel.player.callInfo && (
              <span className="muted">{sel.player.callInfo.value}/wk</span>
            )}
          </div>

          <div className={`finder-verdict call-${v.tone}`}>
            <strong>{v.title}.</strong> {v.text}
          </div>

          {sel.player.callInfo?.reasons.length > 0 && (
            <ul className="why-lines">
              {sel.player.callInfo.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}

          <ScheduleBox player={sel.player} currentWeek={data.week} />
          <OffenseBox offense={sel.player.offense} />

          {!sel.owner && (
            <p className="muted small">
              He's a free agent: no trade needed. If you want him, add him from waivers (and check the Waivers
              math first).
            </p>
          )}

          {deals != null && (
            <div className="shop-results">
              <div className="why-title">
                {sel.owner.isMine ? `Shopping ${sel.player.name}` : `Getting ${sel.player.name}`}
              </div>
              {deals.length === 0 ? (
                <p className="muted small">
                  {sel.owner.isMine
                    ? "No deals found where a team gives up fair value for him. Holding is the move."
                    : `No deal found that ${sel.owner.name} would take without you giving up more than he's worth. Watch him another week.`}
                </p>
              ) : (
                <ul className="trade-list">
                  {deals.map((t) => (
                    <CompactTrade
                      key={`${t.team.id}-${t.give.map((q) => q.espnId).join()}-${t.get.map((q) => q.espnId).join()}`}
                      trade={t}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}

export default TradeFinder;
