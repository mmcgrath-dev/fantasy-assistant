# Fantasy Football Assistant

A web app connected to my ESPN fantasy football league. It pulls my live roster from ESPN and adds the stuff ESPN doesn't show you: snap count trends, a game log for every player, and a short "why" note when a player's role is changing.

I built it to help with my own start/sit and waiver decisions, and it's still in progress. Next up are waiver pickups and trade analysis.

## What it does

- **My Team page:** my roster in ESPN's lineup order with projected points, bye weeks, and injury tags
- **Snap trends:** each player's snap % over his last 2 games vs. the 2 before, labeled up, down, or steady
- **Game log panel:** click a player to see his week-by-week stats, with columns that change by position
- **Weekly rank colors:** every stat is colored by how it ranks against other players that week
- **"Why" box:** plain-English lines explaining what changed, like carries going down, a teammate's snaps going up, or a new injury report. These come from simple rules in `src/why.js`, not AI.

## How it's built

| Part | What it uses |
|---|---|
| Frontend | React + Vite |
| Backend | Netlify Functions (Node.js) that talk to ESPN and the database |
| Database | PostgreSQL on Supabase |
| Data | Free NFL data from [nflverse](https://github.com/nflverse/nflverse-data): players, snap counts, play-by-play, weekly stats, injuries |
| Data refresh | GitHub Actions job that reloads everything every Tuesday and Saturday |
| Hosting | Netlify |

```
src/                 React app (App.jsx) and the "why" rules (why.js)
netlify/functions/   serverless functions: league.js, roster.js
supabase/            SQL files, run in order: tables first, then query functions
scripts/             Node scripts that load nflverse data into the database
.github/workflows/   the scheduled data refresh
```

### The database

The SQL files in `supabase/` are numbered in the order they need to run. The first group creates the tables (players, snap counts, targets, rushes, weekly stats, injuries, advanced stats). The last few create functions the app calls by name:

- `get_snap_trends` compares a player's last 2 games to the 2 before
- `get_game_logs` returns week-by-week stats for a roster
- `get_role_context` compares team volume, player usage, and target/carry share, and finds the teammate whose snaps went up the most

Each file has comments at the top explaining what it does and an example query to test it.

### Keeping the data fresh

`.github/workflows/weekly-data.yml` runs every loader script twice a week. Tuesday morning picks up Monday Night Football, and Saturday morning picks up Friday's final injury reports. It can also be run any time from the Actions tab.

`netlify.toml` tells Netlify to skip a deploy when a push only changes scripts, SQL, or the workflow, since those don't change the site.

## Security

ESPN login cookies and database keys are kept in environment variables and repository secrets, never in the code. Nothing sensitive is committed to this repo.
