# Fantasy Football Assistant

A web app hooked up to my ESPN fantasy football league. ESPN tells you who's on your team and what they're projected to score. This tells you why: who's gaining or losing work, which defense is soft where a player actually gets the ball, who's been lucky with touchdowns, which trades would actually help, and what any of it does to my chances of winning the league.

I built it to win my own league (10 teams, PPR, keeper), so everything in it is something I actually use every week.

## What it does

### My Team
- My roster in ESPN's lineup order with projections, byes and injury tags
- Snap % trend for each player (last 2 games vs the 2 before)
- Click any player for a game log with every stat colored by how it ranked that week
- A "Why" box that explains in plain English what changed: carries down, a teammate taking snaps, a new QB, a new teammate from a trade
- Injury box with his report history, games he's missed, and how he played while hurt
- Matchup box: where he gets the ball (short left, deep right, run up the middle...) lined up against how this week's defense does on those exact spots

### Start/Sit
- My best lineup for the week, the changes to make on ESPN, and the reason behind every call
- Each player's score blends ESPN's projection with my own number (his real per-game value, the defense, where he gets the ball, Vegas's projected team total, his role trend)
- A confidence label on every starter: Clear, Lean or Coin flip
- My win chance against this week's opponent. Coin flips go to the safer player when I'm favored and the boom-or-bust player when I'm not

### Trades
- A sell high / sell low / hold call on every player on my team, with the reasons
- Suggested trades that help both sides, judged the way the other manager would see it (recent points, ESPN projection, draft position), not just my numbers
- Every trade shows how it changes my title odds, and it counts the boost the other team gets too, since helping a rival hurts me
- Buy-low targets, and a "Buy them hurt" list: good players who are injured now but should be back by my playoffs, when they're cheapest
- Hurt players are priced in week by week instead of being thrown out, so a team that needs wins now will sell an injured star for less

### Trade Finder and Build a Trade
- Look up any NFL player and see what it would take to get him, or what my player could get
- Build any trade by hand and see what it does to both lineups, my title odds, and whether they'd likely say yes (with a check or an X on each reason)
- Save deals and compare them side by side

### Odds
- My title odds and playoff odds, from playing out the rest of the season and the playoffs 10,000 times
- A luck meter for every team: their real record vs their all-play record (what they'd be if they played everyone every week), so I can see who's better or worse than their record
- How much one extra point a week is worth to my title odds

## How it works

A few pieces worth explaining, since they're what make the advice better than a projection:

- **Real value, not just points.** A player's value is half his last 3 games, half the games before, with most of his touchdown luck taken out. Every carry and target gets an "expected TD" value based on where on the field it happened, so a guy with 6 TDs on 2.5 expected gets marked down. Inefficient running backs and lost goal-line work count against him too.
- **Injuries done properly.** The app tracks games a player missed (his team played, he didn't), games where he got hurt and left early (those don't count in his averages), and players ESPN isn't projecting this week. Hurt players get priced week by week: zero for the weeks he'll probably miss, about 90% once he's back.
- **Changes the day they happen.** The database only knows who played in each game, so it can't know about a trade until the player suits up. The app checks ESPN's live rosters and projections to catch new starting QBs and players who just changed teams, and warns their new teammates that their numbers came before the move.
- **Trades that would actually get accepted.** A trade only gets suggested if it helps my lineup, helps theirs by the numbers they'd look at, and doesn't make them give up more trade value than they get. Two mid players can't buy a star.
- **Title odds.** Each team's strength comes from its weekly scores (recent weeks count more), and the randomness comes from how much scores really bounce around in my league. The simulation uses a fixed random seed, so the same data always gives the same odds and comparing two trades is fair.

## How it's built

| Part | What it uses |
|---|---|
| Frontend | React + Vite |
| Backend | Netlify Functions (Node.js) that talk to ESPN and the database |
| Database | PostgreSQL on Supabase, with 20+ SQL functions that do the heavy math |
| Data | Free NFL data from [nflverse](https://github.com/nflverse/nflverse-data): players, snap counts, every target and carry, weekly stats, injury reports, Next Gen Stats, schedule and Vegas lines |
| Live data | ESPN's fantasy API: my league's rosters, projections, records, schedule and scores |
| Data refresh | A GitHub Actions job that reloads everything every Tuesday and Saturday |
| Hosting | Netlify |

```
src/                   React app
  App.jsx                tabs and the My Team page
  StartSit.jsx           Start/Sit page       (rules in startSit.js)
  Trades.jsx             Trades page          (calls in tradeCalls.js, trade search in tradeEngine.js)
  TradeFinder.jsx        look up any player
  TradeBuilder.jsx       build and compare your own trades
  Odds.jsx               title odds and luck meter (simulation in odds.js)
  why.js, injury.js,     the plain-English rules behind the Why and Injury boxes
  health.js, offense.js  injury status, missed games, and how each offense is playing
netlify/functions/     serverless functions: roster, trades, league-odds, player-search, league
netlify/lib/           shared helpers: ESPN requests, the database client,
                         this week's starting QBs (qb.js), players who just changed teams (movers.js)
supabase/              SQL files, numbered in the order they run
scripts/               Node scripts that load nflverse data into the database
.github/workflows/     the scheduled data refresh
```

### The database

The SQL files in `supabase/` are numbered in the order they need to run. Files 01 to 09 and 14 create the tables. The rest create views and functions the app calls by name:

| File | What it gives the app |
|---|---|
| 10 `get_snap_trends` | snap % last 2 games vs the 2 before |
| 11 `get_game_logs` | week-by-week stats with weekly ranks for every stat |
| 12 `get_role_context` | team volume, his share of the work, and which teammate is gaining snaps |
| 13 `get_injury_history` | every injury report he's been on this season |
| 15, 17 | how every defense does against throws to each area and runs to each lane |
| 16 `get_matchup_areas` | where he gets the ball vs how this week's defense handles those spots |
| 18 `get_trade_signals` | usage vs points, TD luck, boom weeks, efficiency, goal-line role |
| 19 `get_offense_context` | how every offense is playing, who's at QB, what Vegas expects |
| 20 `get_backfield_share` | each running back's share of his team's backfield |
| 21 `get_player_weeks`, `get_consistency` | rest-of-season schedule with matchup softness, and floor/ceiling |
| 22 `get_last_teams` | the team each player played his last game for (to catch trades) |
| 23 `shortened_games` | games a player got hurt in and left early, so they can be left out |

Each file has comments at the top explaining what it does and an example query to test it.

### Keeping the data fresh

`.github/workflows/weekly-data.yml` runs every loader script twice a week. Tuesday morning picks up Monday Night Football, and Saturday morning picks up Friday's final injury reports. It can also be run any time from the Actions tab.

`netlify.toml` tells Netlify to skip a deploy when a push only changes scripts, SQL or the workflow, since those don't change the site.

## Running it locally

1. `npm install`
2. Make a `.env` file in the project folder with:
   ```
   ESPN_LEAGUE_ID=
   ESPN_SEASON=
   ESPN_TEAM_ID=
   ESPN_S2=
   ESPN_SWID=
   SUPABASE_URL=
   SUPABASE_SECRET_KEY=
   ```
   `ESPN_S2` and `SWID` are the cookies from a logged-in ESPN session (they're how ESPN knows you can see a private league).
3. Run the SQL files in `supabase/` in order in Supabase's SQL editor, then load the data with the scripts in `scripts/` (or run the GitHub Actions job).
4. `netlify dev` and open http://localhost:8888

## Security

ESPN cookies and database keys live in environment variables and repository secrets, never in the code. Each place that needs the database (my laptop, GitHub Actions, the live site) has its own key, so any one can be shut off without breaking the others. Every database function is locked so only those secret keys can call it.
