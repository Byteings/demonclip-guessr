# Clip//Guess — Extreme Demon Edition

Watch a short, random slice of a Geometry Dash extreme demon verification video and name the level. All level data comes from the public [Pointercrate API](https://pointercrate.com/documentation/demons/).

## Run it

**A local server is required** — the game is server-authoritative, so the answer never reaches the browser until the round ends.

```bash
git clone https://github.com/Byteings/demonclip-guessr.git
cd demonclip-guessr
node scripts/sync-demons.mjs
node serve.mjs
```

Open **http://localhost:5173**. No dependencies or build step. The level snapshot is intentionally not committed, so the answer map is never sitting in the repository — run the sync once to fetch it from Pointercrate.

## How it works

- The server keeps the full demon database. The browser only receives a bare YouTube ID for the current clip.
- `data/`, `scripts/` and `server/` are not served over HTTP — a player cannot map a video ID to a level name by inspecting page data.
- Rounds are random: a random level and a random clip length (10–30 seconds) are chosen by the server. There are no clip-length, pool, play or skip controls.
- The embed is zoomed so only the gameplay is visible — no YouTube title bar, controls or related-video panel. Clips autoplay muted (browser policy); clicking the clip replays with sound.
- Hints are generated server-side. The first arrives **30 seconds** into the round, then one every 30 seconds.
- Replays are unlimited: click the clip or press `R` whenever you want during the round.
- The single **Your guess** box sits under the clip and unlocks when the clip ends. Press `Enter` to submit.
- Score, streak, accuracy and identified levels are kept on the server session; your browser only stores the session token and the names you have already identified.

## Modes

- **Pass & play** — the default screen. Add up to **6 players** with custom names, then pass the device around. Everyone is listed in the side panel; turns rotate after each reveal, with per-player scores and streaks and a shared collection.
- **Online rooms** — create a room and copy its **invite link**. Friends open the link, add their name and join from their own browser (up to 6). Everyone sees the same clip and hints; the round reveals when everyone has guessed (or after 2 minutes).

## Scoring

- Base **+100**, multiplied ×2 / ×1.6 / ×1.3 by rank tier.
- Speed bonus up to **+50**, streak bonus up to **+100**.
- Wrong answer **−20**; skip scores zero and breaks the streak.

## Updating the data

Bundled snapshot: **2026-11-24** — 724 listed demons, 707 with playable clips.

```bash
node scripts/sync-demons.mjs
```

This rewrites `data/demons.json`. The in-app **Refresh data** button on the *How to play* screen runs the same sync on the server and reloads its database; no page data is shipped to the client.

## Files

```
demonclip-guessr/
├── index.html            # UI: play / collection / multiplayer / how
├── styles.css            # styling
├── app.js                # UI state, rendering, round flow
├── js/
│   ├── core.js           # small DOM/fetch helpers
│   ├── player.js         # bounded YouTube clip player
│   └── session.js        # authenticated room/session client
├── server/
│   ├── index.mjs         # HTTP server, static whitelist, API routes
│   └── rooms.mjs         # authoritative rooms, hints, scoring, pool
├── data/demons.json      # Pointercrate snapshot (server-only)
├── scripts/sync-demons.mjs
└── serve.mjs
```

Fan-made trainer, not affiliated with Pointercrate, RobTop Games or any level creator. Videos remain the property of their creators.
