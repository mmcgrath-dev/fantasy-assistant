// Trades.jsx
// The Trades page:
//   1. Your roster: every RB, WR and TE with a call (sell high, sell low, hold)
//   2. Suggested trades that help both you and the other team, with the why
//   3. Drop candidates: your weakest bench guys
//   4. Buy-low targets around the league
// The calls come from tradeCall (tradeCalls.js), the trades from findTrades
// (tradeEngine.js), and the numbers behind both from get_trade_signals in the database.
// How each NFL offense is playing comes from get_offense_context, turned into
// a small ▲ / ▼ tag and a click-to-open box by offense.js.

import { useState, useEffect } from "react";
import { tradeCall } from "./tradeCalls.js";
import { findTrades, dropCandidates, weekPoints } from "./tradeEngine.js";
import { offenseInfo } from "./offense.js";

// ---------- offense tag and box ----------

// Next to the team: "CIN ▲" in green, "ARI ▼" in red, just "DEN" if average.
function TeamTag({ player }) {
  const o = player.offense;
  if (!o || !o.tone) return <>{player.nflTeam}</>;
  return (
    <span className={`offense-tag offense-${o.tone}`} title={o.takeaway}>
      {player.nflTeam} {o.tone === "up" ? "▲" : "▼"}
    </span>
  );
}

// Rest-of-season schedule, shown when a player is clicked open: every
// remaining week with the opponent and his projected points there (value bent
// by the matchup). Playoff weeks are marked.
function ScheduleBox({ player, currentWeek }) {
  if (!player.weeks) return null;
  const weeks = [];
  for (let w = currentWeek; w <= 17; w++) {
    const g = player.weeks[w];
    weeks.push({
      week: w,
      opp: g ? `${g.isHome ? "" : "@"}${g.opp}` : "BYE",
      pts: g ? Math.round(weekPoints(player, "value", w, currentWeek) * 10) / 10 : null,
      soft: g && g.defAllowed != null && g.leagueAllowed > 0 ? g.defAllowed / g.leagueAllowed : null,
      playoffs: w >= 15,
    });
  }
  return (
    <div className="offense-box">
      <div className="why-title">Rest of season</div>
      <div className="sched-row">
        {weeks.map((w) => (
          <div key={w.week} className={`sched-cell${w.playoffs ? " sched-playoffs" : ""}`}>
            <div className="muted small">
              {w.playoffs ? "P" : ""}W{w.week}
            </div>
            <div className="small">{w.opp}</div>
            <div className={w.soft == null ? "" : w.soft >= 1.08 ? "sched-soft" : w.soft <= 0.92 ? "sched-tough" : ""}>
              {w.pts == null ? "—" : w.pts}
            </div>
          </div>
        ))}
      </div>
      <p className="muted small sched-note">
        Projected points each week: his value bent by how generous that defense is to his position. Green = soft
        matchup, red = tough. P = your fantasy playoffs (they count extra in trade math).
      </p>
    </div>
  );
}

// Shows when a player is clicked open.
function OffenseBox({ offense }) {
  if (!offense) return null;
  return (
    <div className="offense-box">
      <div className="why-title">{offense.name} offense</div>
      <p className="offense-takeaway">{offense.takeaway}</p>
      <ul className="why-lines">
        {offense.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

// On your own team, a "buy" means he's due to bounce back: hold him, don't sell low.
function myLabel(callInfo) {
  return callInfo.label === "Buy" ? "Hold · due" : callInfo.label;
}

// CSS class for the badge color
function labelClass(label) {
  if (label === "Out") return "call-sell";
  if (label.startsWith("Sell")) return "call-sell";
  if (label === "Buy" || label === "Hold · due") return "call-buy";
  return "call-hold";
}

// Sort order for your roster: the calls you should act on first.
const LABEL_ORDER = { "Sell high": 0, "Sell low": 1, "Hold · due": 2, Hold: 3, Out: 4 };

// ---------- 1. Your roster ----------

function RosterRow({ player, currentWeek, shopPlayer }) {
  const [open, setOpen] = useState(false);
  const [shop, setShop] = useState(null); // null = not asked, [] = no deals, [...] = deals
  const c = player.callInfo;
  const label = myLabel(c);

  function onShop(e) {
    e.stopPropagation(); // don't close the row
    setShop(shopPlayer(player));
  }

  return (
    <li className="trade-player clickable-row" onClick={() => setOpen(!open)}>
      <div className="trade-player-top">
        <div>
          <span className="chevron">{open ? "▾" : "▸"}</span>
          <span className="trade-name">{player.name}</span>
          <span className="muted">
            {" "}
            {player.position} · <TeamTag player={player} />
          </span>
        </div>
        <div className="trade-player-right">
          <span className="muted" title="Our estimate of his points per game the rest of the way">
            {c.value}/wk
          </span>
          <span className={`call ${labelClass(label)}`}>{label}</span>
        </div>
      </div>
      {/* First reason always shows; click for the rest and the offense box. */}
      {c.reasons.length > 0 && (
        <ul className="why-lines">
          {(open ? c.reasons : c.reasons.slice(0, 1)).map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
          {!open && c.reasons.length > 1 && <li className="muted more">+{c.reasons.length - 1} more</li>}
        </ul>
      )}
      {open && <ScheduleBox player={player} currentWeek={currentWeek} />}
      {open && <OffenseBox offense={player.offense} />}
      {open && shopPlayer && shop == null && (
        <button className="shop-button" onClick={onShop}>
          Find trades for {player.name.split(" ")[0]}
        </button>
      )}
      {open && shop != null && (
        <div className="shop-results" onClick={(e) => e.stopPropagation()}>
          <div className="shop-head">
            <div className="why-title">Shopping {player.name}</div>
            <button className="shop-close" onClick={() => setShop(null)}>
              ✕ Close
            </button>
          </div>
          {shop.length === 0 ? (
            <p className="muted small">
              No deals found where a team gives up fair value for him. His price is probably below what you'd
              accept right now, so holding is the move.
            </p>
          ) : (
            <>
              <p className="muted small">
                Every deal sends him out; a second piece of yours gets added when that's what closes it. Click a
                deal for the lineup change and the reasons.
              </p>
              <ul className="trade-list">
                {shop.map((t) => (
                  <CompactTrade
                    key={`${t.team.id}-${t.give.map((p) => p.espnId).join()}-${t.get.map((p) => p.espnId).join()}`}
                    trade={t}
                  />
                ))}
              </ul>
              <button className="shop-close shop-close-bottom" onClick={() => setShop(null)}>
                ✕ Close trades
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

// ---------- buy-low rows (other teams' players) ----------

function BuyRow({ player, currentWeek }) {
  const [open, setOpen] = useState(false);
  const p = player;
  return (
    <li className="trade-player clickable-row" onClick={() => setOpen(!open)}>
      <div className="trade-player-top">
        <div>
          <span className="chevron">{open ? "▾" : "▸"}</span>
          <span className="trade-name">{p.name}</span>
          <span className="muted">
            {" "}
            {p.position} · <TeamTag player={p} /> · {p.owner}
          </span>
        </div>
        <div className="trade-player-right">
          <span className="muted">{p.callInfo.value}/wk</span>
          <span className="call call-buy">Buy</span>
        </div>
      </div>
      <ul className="why-lines">
        {p.callInfo.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      {open && <ScheduleBox player={p} currentWeek={currentWeek} />}
      {open && <OffenseBox offense={p.offense} />}
    </li>
  );
}

// ---------- 2. Suggested trades ----------

function PlayerChips({ players }) {
  return players.map((p) => (
    <div key={p.espnId} className="trade-chip">
      <span className="trade-name">{p.name}</span>
      <span className="muted">
        {" "}
        {p.position} · {p.callInfo.value}/wk
      </span>
    </div>
  ));
}

function WhyList({ title, lines }) {
  if (lines.length === 0) return null;
  return (
    <>
      <div className="why-title">{title}</div>
      <ul className="why-lines">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </>
  );
}

// Your starters now vs after the trade, side by side. Rows that change are highlighted.
function LineupTable({ before, after }) {
  if (!before || !after) return null;
  const rows = Math.max(before.length, after.length);
  const beforeIds = new Set(before.map((r) => r.espnId));
  const afterIds = new Set(after.map((r) => r.espnId));
  const total = (list) => Math.round(list.reduce((sum, r) => sum + r.value, 0) * 10) / 10;
  return (
    <table className="lineup-compare">
      <thead>
        <tr>
          <th></th>
          <th>Your lineup now</th>
          <th>After the trade</th>
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }, (_, i) => {
          const b = before[i];
          const a = after[i];
          return (
            <tr key={i}>
              <td className="muted">{(a || b).slot}</td>
              <td className={b && !afterIds.has(b.espnId) ? "lineup-out" : ""}>
                {b ? `${b.name} ${b.value}` : ""}
              </td>
              <td className={a && !beforeIds.has(a.espnId) ? "lineup-in" : ""}>
                {a ? `${a.name} ${a.value}` : ""}
              </td>
            </tr>
          );
        })}
        <tr className="lineup-total">
          <td></td>
          <td>{total(before)}</td>
          <td>{total(after)}</td>
        </tr>
      </tbody>
    </table>
  );
}

// One compact row per deal: who goes, who comes, what it's worth. Click it
// for the lineup table and all the reasons. Used in the shopping box, where a
// page of full cards was too much to scroll through.
function CompactTrade({ trade }) {
  const [open, setOpen] = useState(false);
  const t = trade;
  return (
    <li className="trade-card">
      <div className="compact-trade clickable-row" onClick={() => setOpen(!open)}>
        <div>
          <span className="chevron">{open ? "▾" : "▸"}</span>
          <span className="trade-name">{t.give.map((p) => p.name).join(" + ")}</span>
          <span className="trade-arrow-small"> ⇄ </span>
          <span className="trade-name">{t.get.map((p) => p.name).join(" + ")}</span>
          <span className="muted small"> with {t.team.name}</span>
        </div>
        <span className="trade-gain">
          You +{t.myGain} · Them +{t.theirGain}
        </span>
      </div>
      {open && (
        <div onClick={(e) => e.stopPropagation()}>
          <LineupTable before={t.lineupBefore} after={t.lineupAfter} />
          <div className="trade-why">
            <WhyList title={`Why give ${t.give.length > 1 ? "them" : "him"} up`} lines={t.whyGive} />
            <WhyList title={`Why get ${t.get.length > 1 ? "them" : "him"}`} lines={t.whyGet} />
            <WhyList title="Why they'd say yes" lines={t.whyThem} />
            {t.notes.map((note) => (
              <p key={note} className="trade-note">
                {note}
              </p>
            ))}
          </div>
        </div>
      )}
    </li>
  );
}

function TradeCard({ trade }) {
  const t = trade;
  return (
    <li className="trade-card">
      <div className="trade-card-head">
        <span>
          With <strong>{t.team.name}</strong>{" "}
          <span className="muted">
            ({t.team.wins}-{t.team.losses}
            {t.situation ? ` · ${t.situation.mode}` : ""})
          </span>
        </span>
        <span className="trade-gain">
          You +{t.myGain}/wk · Them +{t.theirGain}/wk
        </span>
      </div>

      <div className="trade-sides">
        <div>
          <div className="why-title">You give</div>
          <PlayerChips players={t.give} />
        </div>
        <div className="trade-arrow">⇄</div>
        <div>
          <div className="why-title">You get</div>
          <PlayerChips players={t.get} />
        </div>
      </div>

      <LineupTable before={t.lineupBefore} after={t.lineupAfter} />

      <div className="trade-why">
        <WhyList title={`Why give ${t.give.length > 1 ? "them" : "him"} up`} lines={t.whyGive} />
        <WhyList title={`Why get ${t.get.length > 1 ? "them" : "him"}`} lines={t.whyGet} />
        <WhyList title="Why they'd say yes" lines={t.whyThem} />
        {t.notes.map((note) => (
          <p key={note} className="trade-note">
            {note}
          </p>
        ))}
      </div>
    </li>
  );
}

// ---------- the page ----------

function Trades() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

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

  if (error) return <p className="message">Something went wrong: {error}</p>;
  if (!data) return <p className="message">Loading the league and looking for trades...</p>;

  // How every NFL offense is playing, keyed by team ("CIN").
  const offenses = {};
  for (const [team, row] of Object.entries(data.offenses || {})) {
    offenses[team] = offenseInfo(team, row);
  }

  // Give every player his offense and his call (null for QB, K, D/ST and
  // anyone with under 4 games).
  const teams = data.teams.map((team) => ({
    ...team,
    players: team.players.map((p) => {
      const offense = offenses[p.nflTeam] || null;
      const byeWeek = data.offenses?.[p.nflTeam]?.byeWeek ?? null;
      return { ...p, offense, byeWeek, callInfo: tradeCall(p.signals, p.position, p, offense) };
    }),
  }));

  const myTeam = teams.find((t) => t.isMine);
  const myPlayers = myTeam.players
    .filter((p) => p.callInfo)
    .sort(
      (a, b) =>
        LABEL_ORDER[myLabel(a.callInfo)] - LABEL_ORDER[myLabel(b.callInfo)] || b.callInfo.value - a.callInfo.value
    );
  const noData = myTeam.players.filter((p) => !p.callInfo && ["RB", "WR", "TE"].includes(p.position));

  const season = data.season || { playoffTeams: 4, regularSeasonWeeks: 14 };
  const trades = findTrades(teams, data.slots, season, data.week);

  // The trade calculator: shop one player around the whole league.
  const shopPlayer = (player) => findTrades(teams, data.slots, season, data.week, { forPlayer: player.espnId });
  const drops = dropCandidates(teams, data.slots);

  const buyLow = [];
  for (const team of teams) {
    if (team.isMine) continue;
    for (const p of team.players) {
      if (p.callInfo && p.callInfo.worthIt && !p.callInfo.absent && p.callInfo.label === "Buy") buyLow.push({ ...p, owner: team.name });
    }
  }
  buyLow.sort((a, b) => b.callInfo.strength - a.callInfo.strength || b.callInfo.value - a.callInfo.value);

  const slotText = `${data.slots.RB} RB, ${data.slots.WR} WR, ${data.slots.TE} TE, ${data.slots.FLEX} FLEX`;

  return (
    <>
      <header className="team-header">
        <div>
          <h1>Trades</h1>
          <p className="week">
            Week {data.week} · {myTeam.name} ({myTeam.wins}-{myTeam.losses})
          </p>
        </div>
      </header>

      <section className="why trade-section">
        <div className="why-title">Your roster</div>
        <p className="trade-note">
          Sell high = scoring above his usage, his price won't get better. Sell low = his role is fading, get something
          before it fades more. Hold · due = his usage says better days are coming, don't sell him cheap. ▲ / ▼
          next to the team = that offense is rolling or struggling. Click a player for every reason and how his
          offense is playing.
        </p>
        <ul className="trade-list">
          {myPlayers.map((p) => (
            <RosterRow key={p.espnId} player={p} currentWeek={data.week} shopPlayer={shopPlayer} />
          ))}
        </ul>
        {noData.length > 0 && (
          <p className="muted small">Not enough games to judge yet: {noData.map((p) => p.name).join(", ")}.</p>
        )}
      </section>

      <section className="why trade-section">
        <div className="why-title">Suggested trades</div>
        <p className="trade-note">
          Only trades where your lineup gets better by our numbers AND theirs gets better by the numbers they'd look
          at (recent points, ESPN's projection and where he was drafted), and where they don't give up more than they
          get on paper. Lineups use your league's {slotText} and are scored week by week, so byes and players out
          this week count. +/wk is the average over the weeks left. A team that needs wins now only counts the next
          few weeks. Two of your starting backs from one NFL team count for less. Injury risk is counted too: a
          thin bench costs points, and giving two players for one has to win by at least 2.5 a week. A player
          whose role has warning signs is treated as discounted: he gets paid for with players we're selling
          anyway, never with a solid hold. The lineup
          table is a normal week; the +/wk also counts byes and injuries, so they won't match exactly.
        </p>
        {trades.length === 0 ? (
          <p className="muted">No trades this week that clearly help both sides.</p>
        ) : (
          <ul className="trade-list">
            {trades.map((t) => (
              <TradeCard
                key={`${t.team.id}-${t.give.map((p) => p.espnId).join()}-${t.get.map((p) => p.espnId).join()}`}
                trade={t}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="why trade-section">
        <div className="why-title">Drop candidates</div>
        <p className="trade-note">Your weakest bench guys: the first to go for a waiver pickup.</p>
        {drops.length === 0 ? (
          <p className="muted">Nobody on your bench stands out as a drop.</p>
        ) : (
          <ul className="trade-list">
            {drops.map((p) => (
              <RosterRow key={p.espnId} player={p} currentWeek={data.week} />
            ))}
          </ul>
        )}
      </section>

      <section className="why trade-section">
        <div className="why-title">Buy low · around the league</div>
        <p className="trade-note">Usage ahead of his points, and he's actually doing something with it. Top 6.</p>
        {buyLow.length === 0 ? (
          <p className="muted">No clear buy-low targets this week.</p>
        ) : (
          <ul className="trade-list">
            {buyLow.slice(0, 6).map((p) => (
              <BuyRow key={p.espnId} player={p} currentWeek={data.week} />
            ))}
          </ul>
        )}
      </section>

      <p className="game-log-key">
        /wk is our estimate of points per game the rest of the way: half his last 3 games, half the games before, with
        most of his TD luck taken out, and adjusted for lost goal-line work and inefficient running. The other
        manager's side is judged on what they'd see: recent points, ESPN's weekly projection, and draft position. Still
        treat these as conversation starters: every manager is different. RB, WR and TE with 4+ games only.
      </p>
    </>
  );
}

export default Trades;
