# FAF Scout

`FAF Scout` is a fresh local-first replacement for the old FAF analytics tool. It focuses on the same core player workflows:

- player overview
- recent games
- win rate
- top opponents
- top teammates
- map performance
- replay links

It is built around a provider layer so we can keep evolving the UI and analytics even while FAF access rules change.

## Why this shape

The old browser-only approach is brittle now because FAF is protected by Cloudflare and the modern FAF stack expects authenticated traffic. This project therefore uses:

- a small local Node server
- a pluggable provider contract
- a bundled sample provider so the dashboard is usable immediately
- a real FAF OAuth flow with localhost callback
- authenticated FAF API calls using both `Authorization: Bearer ...` and `X-HMAC: ...`

## Run it

```bash
npm start
```

Then open `http://localhost:4173`.

## Current providers

### `sample`

Works out of the box. Use player `ZLO` to see the full analytics dashboard with seeded data.

### `official`

This provider now uses FAF OAuth and the same style of authenticated API access as the modern client stack.

1. Start the app.
2. Click `Log in with FAF`.
3. Finish the FAF login flow in your browser.
4. Return to the app and switch the provider to `official`.

Notes:

- the app mirrors the current FAF client flow by opening a `127.0.0.1` callback on a free local port
- the authorization request includes the `offline` scope so FAF can return a refresh token
- refresh tokens are rotated by FAF, so the app stores the latest returned token locally under your user profile
- if FAF issues us a dedicated OAuth client later, you can paste it into the advanced auth settings without code changes

## Project structure

- `server.js`: local HTTP server and API routes
- `src/faf-client.js`: FAF OAuth, token refresh, HMAC extraction, and authenticated requests
- `src/analytics.js`: derived stats for players, maps, opponents, and streaks
- `src/providers/official.js`: live FAF adapter and normalization
- `src/jsonapi.js`: small JSON:API relationship helpers
- `src/providers/sample.js`: bundled sample data for UI and analytics development
- `public/`: dashboard UI

## Good next steps

- add rating history charts from `leaderboardRatingJournal`
- add replay parsing adapter support
- add player-vs-player matchup history
- add searchable cache and compare views
