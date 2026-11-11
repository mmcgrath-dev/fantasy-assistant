// league-odds.js
// The data behind the Odds page: every team's score every week, and the whole
// league schedule, so the page can work out
//   1. the luck meter: each team's all-play record (how it would do playing
//      every team every week) vs its real record
//   2. championship odds: play out the rest of the season and the playoffs
//      thousands of times (src/odds.js does the math)
//
// Everything comes from ESPN, no database needed:
//   mTeam     names, records, points for
//   mMatchup  the schedule: who plays who each week, and the scores
//   mSettings regular season length, playoff spots, weeks per playoff round
//
// Try it while netlify dev is running:
//   http://localhost:8888/.netlify/functions/league-odds

import { getEspnSettings, getFromEspn } from "../lib/espn.js";

export default async () => {
  const settings = getEspnSettings();
  if (!settings) {
    return Response.json({ error: "Missing one of the ESPN settings in .env" }, { status: 500 });
  }

  try {
    const league = await getFromEspn(
      settings,
      `${settings.leagueUrl}?view=mTeam&view=mMatchup&view=mSettings&view=mStatus`
    );

    const schedule = league.settings?.scheduleSettings || {};
    const season = {
      regularSeasonWeeks: schedule.matchupPeriodCount ?? 14,
      playoffTeams: schedule.playoffTeamCount ?? 4,
      // Some leagues play each playoff round over 2 weeks (scores added up).
      playoffRoundLength: schedule.playoffMatchupPeriodLength ?? 1,
      divisions: (schedule.divisions || []).length,
    };

    const teams = league.teams.map((team) => {
      const record = team.record?.overall || {};
      return {
        id: team.id,
        name: (team.name || `${team.location} ${team.nickname}`).trim(),
        isMine: team.id === settings.teamId,
        wins: record.wins ?? 0,
        losses: record.losses ?? 0,
        ties: record.ties ?? 0,
        pointsFor: Math.round((record.pointsFor ?? 0) * 10) / 10,
      };
    });

    // One entry per regular-season game. winner is HOME, AWAY, TIE, or
    // UNDECIDED (not played yet, or being played this week).
    // Playoff games are left out: the page simulates those itself.
    const games = (league.schedule || [])
      .filter((m) => m.matchupPeriodId <= season.regularSeasonWeeks && m.home && m.away)
      .map((m) => ({
        week: m.matchupPeriodId,
        homeId: m.home.teamId,
        awayId: m.away.teamId,
        homePoints: m.home.totalPoints ?? 0,
        awayPoints: m.away.totalPoints ?? 0,
        winner: m.winner || "UNDECIDED",
      }));

    return Response.json({
      currentWeek: league.status?.currentMatchupPeriod ?? league.scoringPeriodId,
      season,
      teams,
      games,
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 502 });
  }
};
