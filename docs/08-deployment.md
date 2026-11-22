# 08 — Deployment

The production site runs at https://game-hub.joura.info on a single Ubuntu VPS (`72.60.26.180`, SSH: `ssh root@72.60.26.180`) that also hosts other apps. Everything here is Docker, so the game does not touch the host's Node or any other project.

## How the pieces fit

```
browser ──https──> host nginx (TLS, certbot)
                       │  proxy to 127.0.0.1:3120
                       ▼
                  web container (nginx)
                   ├─ /          static client (Vite build)
                   ├─ /api/*  ─┐
                   └─ /ws*    ─┴─> server container (Node, port 2567)
```

- **Host nginx** only terminates TLS and forwards everything to the web container. The vhost is [deploy/host-nginx.conf](../deploy/host-nginx.conf).
- **web container** serves the compiled client and proxies `/api` and `/ws` to the game server, config in [deploy/nginx.conf](../deploy/nginx.conf). The client always uses its own origin for the API and WebSockets (see `NetClient.ts`), which is why one domain is enough and no CORS or URL config is needed.
- **server container** is the authoritative game server. Player ratings are written to the `ratings` volume (`/data/ratings.json`), so redeploying does not reset the leaderboard.
- The only published port is `127.0.0.1:3120`, so nothing is reachable except through the host nginx.

The [Dockerfile](../Dockerfile) builds once and produces two targets, `server` and `web`. [docker-compose.yml](../docker-compose.yml) wires them together.

## Deploy an update

On your machine, push to `main`. Then connect to the VPS (`ssh root@72.60.26.180`) and rebuild:

```bash
ssh root@72.60.26.180
cd /opt/game-hub
git pull
docker compose up -d --build
```

Compose only rebuilds what changed. The old containers keep running until the new ones are ready, but players in a live match are disconnected when the server container restarts.

Useful checks:

```bash
docker compose ps
docker compose logs -f server
curl https://game-hub.joura.info/api/health
```

## First-time setup (already done)

1. DNS: an `A` record for `game-hub` pointing at the VPS (the wildcard record also covers it).
2. `git clone https://github.com/abdullahalkafi-dev/game-hub.git /opt/game-hub`
3. `docker compose up -d --build`
4. Copy the vhost and enable it:
   ```bash
   cp deploy/host-nginx.conf /etc/nginx/sites-available/game-hub.joura.info
   ln -s /etc/nginx/sites-available/game-hub.joura.info /etc/nginx/sites-enabled/
   nginx -t && systemctl reload nginx
   ```
5. Certificate: `certbot --nginx -d game-hub.joura.info --redirect`. Certbot rewrites the vhost in place with the TLS lines and renews automatically.

## Things to know

- **Port 3120** was free when this was set up. If it is ever taken, change it in `docker-compose.yml` and in the host vhost together.
- **Build memory.** The client build (Babylon.js) needs a few GB. The VPS runs close to full, so build when nothing else heavy is going on if it ever gets killed.
- **Lockfile.** The image installs with `--frozen-lockfile`, so commit `pnpm-lock.yaml` whenever dependencies change.
- **`tsconfig.tsbuildinfo` must not be committed.** A stale one makes `tsc` skip emitting declarations in a clean checkout and breaks the server build.
