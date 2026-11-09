// why.js
// Turns a player's role context numbers (from get_role_context in the database)
// into a few short plain-English lines for the "Why" box in his panel.
//
// Everything compares his team's last 2 games to the 2 before.
// These are simple rules, not AI. Each rule checks one thing and, if it's
// big enough to matter, adds a line. Small wiggles get ignored.
//
// buildWhy(ctx, injury) takes his role context and his injury summary
// (from injurySummary in injury.js, or null) and returns { verdict, lines, tag }:
//   verdict: one short takeaway (or null if nothing stands out)
//   lines:   the evidence, one sentence each
//   tag:     a tiny label for the main roster row, like { label: "Role ▼", tone: "bad" }
//            (or null when nothing stands out). tone is good, warn or bad.

import { describeReport } from "./injury.js";

// How big a change has to be before it's worth a line.
const MIN_CHANGE = {
  carries: 3,      // per game
  targets: 2,      // per game
  plays: 6,        // team plays per game
  runPct: 5,       // percentage points
  share: 8,        // percentage points of his group's carries or team's targets
  mateSnaps: 8,    // percentage points of snaps a teammate gained
};

// "17 → 10". Numbers come in like 17.0, so Number() drops the ".0".
function fromTo(stat) {
  return `${Number(stat.prior)} → ${Number(stat.last)}`;
}

function change(stat) {
  if (stat.last == null || stat.prior == null) return 0;
  return stat.last - stat.prior;
}

// The usage line: carries for RBs, targets for WRs and TEs.
function usageLine(label, stat, min) {
  const diff = change(stat);
  if (diff <= -min) return `${label} down ${fromTo(stat)} a game.`;
  if (diff >= min) return `${label} up ${fromTo(stat)} a game.`;
  return `${label} steady at about ${Math.round(stat.last)} a game.`;
}

// Team volume: more or fewer plays, and more running or more passing.
// Returns null if neither moved enough to matter.
function teamLine(ctx) {
  const parts = [];

  const playsDiff = change(ctx.plays);
  if (playsDiff <= -MIN_CHANGE.plays) parts.push(`running fewer plays (${fromTo(ctx.plays)} a game)`);
  if (playsDiff >= MIN_CHANGE.plays) parts.push(`running more plays (${fromTo(ctx.plays)} a game)`);

  const runDiff = change(ctx.runPct);
  const runs = `${Number(ctx.runPct.prior)}% → ${Number(ctx.runPct.last)}% of plays`;
  if (runDiff <= -MIN_CHANGE.runPct) parts.push(`passing more (runs went ${runs})`);
  if (runDiff >= MIN_CHANGE.runPct) parts.push(`running more (runs went ${runs})`);

  if (parts.length === 0) return null;
  return `${ctx.team} is ${parts.join(" and ")}.`;
}

// His slice of the work: share of his position group's carries (RB) or
// share of his team's targets (WR/TE). Returns { line, direction }.
function shareLine(label, stat) {
  if (stat.last == null || stat.prior == null) return { line: null, direction: "steady" };
  const diff = change(stat);
  const nums = `${Number(stat.prior)}% → ${Number(stat.last)}%`;
  if (diff <= -MIN_CHANGE.share) return { line: `His share of ${label} dropped (${nums}).`, direction: "down" };
  if (diff >= MIN_CHANGE.share) return { line: `His share of ${label} grew (${nums}).`, direction: "up" };
  return { line: `His share of ${label} is holding (about ${Number(stat.last)}%).`, direction: "steady" };
}

// A teammate at his position who's getting more snaps.
function teammateLine(mate, pos) {
  if (!mate || mate.snapsChange < MIN_CHANGE.mateSnaps) return null;

  const extras = [`+${Number(mate.snapsChange)} snap %`];
  if (pos === "RB" && mate.carriesChange >= 1) extras.push(`+${Number(mate.carriesChange)} carries a game`);
  if (mate.targetsChange >= 1) extras.push(`+${Number(mate.targetsChange)} targets a game`);

  if (pos === "QB") return `Backup ${mate.name} is getting snaps (${extras.join(", ")}). Check for an injury or benching.`;
  return `${mate.name} is getting more work (${extras.join(", ")}).`;
}

// One line if an injury was affecting him during his last 2 games.
function injuryLine(injury) {
  if (!injury || !injury.recent) return null;
  return `Banged up in Week ${injury.recent.week}: ${describeReport(injury.recent)}.`;
}

export function buildWhy(ctx, injurySummary) {
  if (!ctx) return { verdict: null, lines: [], tag: null };

  const pos = ctx.position;
  const lines = [];
  let usageDiff = 0;
  let share = { line: null, direction: "steady" };

  if (pos === "RB") {
    lines.push(usageLine("Carries", ctx.carries, MIN_CHANGE.carries));
    usageDiff = change(ctx.carries) / MIN_CHANGE.carries;
    share = shareLine("RB carries", ctx.carryShare);
  } else if (pos === "WR" || pos === "TE") {
    lines.push(usageLine("Targets", ctx.targets, MIN_CHANGE.targets));
    usageDiff = change(ctx.targets) / MIN_CHANGE.targets;
    share = shareLine("team targets", ctx.targetShare);
  }

  const team = teamLine(ctx);
  if (team) lines.push(team);
  if (share.line) lines.push(share.line);

  const mate = teammateLine(ctx.teammate, pos);
  if (mate) lines.push(mate);

  // In PPR, an RB's targets are a big part of his floor, so mention them too.
  if (pos === "RB") lines.push(usageLine("Targets", ctx.targets, MIN_CHANGE.targets));

  const injury = injuryLine(injurySummary);
  if (injury) lines.push(injury);

  // ---------- The takeaway and the row tag ----------
  // usageDiff is how far his usage moved, measured in "notable changes"
  // (1 = exactly at the line, -2 = twice as big a drop). Only call it if it moved.
  // Each case sets both the sentence for the panel and the short tag for the row,
  // so the two always agree.
  let verdict = null;
  let tag = null;
  if (pos !== "QB") {
    if (usageDiff <= -1) {
      if (injury && injurySummary.stillHurt) {
        verdict = "Usage down and he's still on this week's injury report. Check his status before starting him.";
        tag = { label: "Injury", tone: "bad" };
      } else if (injury && share.direction === "down") {
        verdict = `Hurt in Week ${injurySummary.recent.week}, but his share of the work is shrinking too. Watch whether it comes back now that he's no longer limited.`;
        tag = { label: "Injury ▼", tone: "warn" };
      } else if (injury) {
        verdict = `Part of the drop came while he was hurt (Week ${injurySummary.recent.week}). He's past it on the latest report, so his role could come back.`;
        tag = { label: "Injury ▼", tone: "warn" };
      } else if (share.direction === "down" && team) {
        verdict = "Two things at once: a smaller slice and less team volume. The shrinking slice is the part to worry about.";
        tag = { label: "Role ▼", tone: "bad" };
      } else if (share.direction === "down") {
        verdict = "Losing work to teammates. A real role change, keep an eye on it.";
        tag = { label: "Role ▼", tone: "bad" };
      } else if (team) {
        verdict = "His slice is holding, the team just has less to go around. Could bounce back.";
        tag = { label: "Volume ▼", tone: "warn" };
      } else {
        verdict = "Usage down without a clear cause. Could be game script, watch one more week.";
        tag = { label: "Usage ▼", tone: "warn" };
      }
    } else if (usageDiff >= 1) {
      if (share.direction === "up") {
        verdict = "Role growing. He's earning a bigger share.";
        tag = { label: "Role ▲", tone: "good" };
      } else {
        verdict = "More volume, mostly from the team. Nice, but not a new role yet.";
        tag = { label: "Volume ▲", tone: "good" };
      }
    }
  } else if (mate) {
    verdict = "Watch the QB situation.";
    tag = { label: "QB watch", tone: "warn" };
  }

  // A game status on THIS week's report matters even if his usage looks fine.
  const thisWeek = injurySummary && injurySummary.thisWeek;
  if (!tag && thisWeek && thisWeek.status) {
    const serious = thisWeek.status === "Out" || thisWeek.status === "Doubtful";
    tag = { label: "Injury", tone: serious ? "bad" : "warn" };
  }

  return { verdict, lines, tag };
}
