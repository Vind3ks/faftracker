# FAF Tracker

`FAF Tracker` is a tool that allows you to check:

- player overview
- recent games
- win rate
- top opponents
- top teammates
- map performance

## Replay viewer

Look up any finished replay by id or link (`faforever.com/replay/<id>`) for a full
breakdown built from the replay command stream:

- game overview (map, mode, duration, winner, factions, rating change per player)
- clickable player list with in-game rating
- **effective APM** alongside raw APM — factory build-queue spam is excluded and
  Shift move/patrol chains are collapsed so it reflects meaningful actions
- a filterable **tech & event timeline** (factory upgrades, first unit of a tier,
  T4/experimentals, notable structures) with unit icons and an estimated economy
  snapshot, including side-by-side player comparison
- a Kazbek-style **best-timing leaderboard** indexing fastest unit/tech timings per map

Replay command streams record player *orders*, not the simulation, so completion
times and economy income are estimated from build costs and clearly labelled; order
("started") times are exact.

## Run it

```bash
npm install
npm start
```

Then open `http://localhost:4173`.

> `npm install` is required now that the replay parser depends on `fzstd` for
> decompressing modern (`zstd`) `.fafreplay` files.
