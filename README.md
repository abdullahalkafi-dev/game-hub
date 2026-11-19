# game-hub

A browser game hub with two multiplayer games:

- **StrikeCore**, a tactical shooter (Aim Duel, Gunfight, Tactical Wipeout, Team Deathmatch, Warm-Up range)
- **ApexDrive**, a street and track racer

The client is Babylon.js with Rapier physics. The server is an authoritative Node WebSocket server. Both share one `@game/shared` package for the protocol and physics rules.

Live at https://game-hub.joura.info

## Run locally

```bash
pnpm install
pnpm dev:server   # game server, set PORT (defaults to 2567)
pnpm dev:client   # Vite on http://localhost:5173, proxies /api and /ws to the server
```

If you run the server on a port other than 2567, put `GAME_SERVER_PORT=<port>` in `packages/client/.env.local`.

```bash
pnpm typecheck
pnpm test
```

## Deploy

`docker compose up -d --build` builds the server and the static client and publishes the site on `127.0.0.1:3120`. A reverse proxy in front adds TLS. The full steps are in [docs/08-deployment.md](./docs/08-deployment.md).

More documentation lives in [docs/](./docs/README.md).
