// This function asks ESPN for basic info about your league.
// If it works, we know ESPN accepts your cookies and we can build from here.

export default async () => {
  // 1. Read your settings from the .env file.
  //    process.env is where Node keeps environment variables.
  const leagueId = process.env.ESPN_LEAGUE_ID;
  const season = process.env.ESPN_SEASON;
  const espnS2 = process.env.ESPN_S2;
  const swid = process.env.ESPN_SWID;

  // If any are missing, stop early with a clear message instead of a confusing ESPN error.
  if (!leagueId || !season || !espnS2 || !swid) {
    return Response.json(
      { error: "Missing one of the ESPN settings in .env" },
      { status: 500 }
    );
  }

  // 2. Build the ESPN address for your league.
  //    view=mTeam asks for the teams, view=mSettings asks for league settings like the name.
  const url =
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}` +
    `/segments/0/leagues/${leagueId}?view=mTeam&view=mSettings`;

  try {
    // 3. Ask ESPN, sending your cookies so it knows it's you.
    //    await means "wait here until ESPN answers."
    const espnResponse = await fetch(url, {
      headers: {
        Cookie: `espn_s2=${espnS2}; SWID=${swid}`,
      },
    });

    // 4. If ESPN said no, send back the status code so we can tell why.
    //    401 or 403 usually means the cookies are wrong or expired.
    if (!espnResponse.ok) {
      return Response.json(
        { error: "ESPN turned down the request", espnStatus: espnResponse.status },
        { status: 502 }
      );
    }

    // 5. Turn ESPN's reply from text into a JavaScript object.
    const league = await espnResponse.json();

    // 6. ESPN sends a LOT of data. Pick out just the team id and name for each team.
    const teams = league.teams.map((team) => ({
      id: team.id,
      name: team.name || `${team.location} ${team.nickname}`,
    }));

    // 7. Send back a small, readable summary.
    return Response.json({
      connected: true,
      leagueName: league.settings?.name,
      teamCount: teams.length,
      teams: teams,
    });
  } catch (err) {
    // This runs if something breaks entirely, like no internet connection.
    return Response.json(
      { error: "Could not reach ESPN", details: err.message },
      { status: 500 }
    );
  }
};
