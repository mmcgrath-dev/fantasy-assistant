// espn.js
// Shared ESPN helpers for the Netlify functions, so each function doesn't have
// to repeat the same lookup tables and fetch code.
//
// Lives in netlify/lib (not netlify/functions) on purpose: every file in
// netlify/functions becomes its own web address, and this one is just a helper.

// ESPN uses numbers instead of names for positions, NFL teams, and lineup spots.
export const POSITIONS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };

export const NFL_TEAMS = {
  0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN",
  8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA",
  16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT",
  24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL",
  34: "HOU",
};

export const LINEUP_SLOTS = {
  0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "D/ST", 17: "K", 20: "Bench", 21: "IR", 23: "FLEX",
};

// Reads the ESPN settings from .env (or Netlify's environment variables).
// Returns null if any are missing, so the caller can send back a clear error.
export function getEspnSettings() {
  const settings = {
    leagueId: process.env.ESPN_LEAGUE_ID,
    season: process.env.ESPN_SEASON,
    teamId: Number(process.env.ESPN_TEAM_ID), // .env values are text, so turn "2" into the number 2
    espnS2: process.env.ESPN_S2,
    swid: process.env.ESPN_SWID,
  };
  const { leagueId, season, teamId, espnS2, swid } = settings;
  if (!leagueId || !season || !teamId || !espnS2 || !swid) return null;

  // Two ESPN addresses: one for the whole NFL season, one for your league inside it.
  settings.seasonUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}`;
  settings.leagueUrl = `${settings.seasonUrl}/segments/0/leagues/${leagueId}`;
  return settings;
}

// Asks ESPN for a full address, sending your cookies so it knows it's you.
// extraHeaders is optional, for the few requests that need more (like the
// player list's filter).
export async function getFromEspn(settings, url, extraHeaders = {}) {
  const response = await fetch(url, {
    headers: { Cookie: `espn_s2=${settings.espnS2}; SWID=${settings.swid}`, ...extraHeaders },
  });
  if (!response.ok) {
    throw new Error(`ESPN turned down the request (status ${response.status})`);
  }
  return response.json();
}
