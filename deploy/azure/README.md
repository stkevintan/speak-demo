# Deploying Rehearsal to a single Docker host

This deploys the images that `.github/workflows/docker-publish.yml` publishes to
GHCR. Nothing is built on the host, so the machine needs no Node toolchain, no
pnpm store, and no checkout of this repo — just Docker and a `.env`.

`compose.yaml` in this directory is the deployment manifest.

## What runs

| Service | Image | Notes |
| --- | --- | --- |
| `redis` | `redis:7.4-alpine` | AOF on, backed by the `redis-data` volume |
| `control-plane` | `ghcr.io/stkevintan/speak-demo-control-plane` | NestJS API, SQLite on the `control-plane-data` volume |
| `agent-worker` | `ghcr.io/stkevintan/speak-demo-agent-worker` | Joins LiveKit rooms as the tutor; the memory-heavy container |
| `web` | `ghcr.io/stkevintan/speak-demo-web` | nginx serving the SPA and proxying `/api/*` |

All three GHCR packages are public, so no `docker login` is required.

## Two things that are easy to get wrong

**1. The API service must be named `control-plane`.** The published `web` image
ships `apps/web/nginx.conf` verbatim, and that file proxies `/api/*` to the
literal hostname `control-plane`. Rename the service and every API call 502s.
(The `NGINX_CONF` build arg in `apps/web/Dockerfile` exists, but the publish
workflow does not pass it, so it cannot be used to work around this.)

**2. `DEV_AUTH_ENABLED=true` with `NODE_ENV=development` is currently
mandatory.** There is no login endpoint in the control plane — the only way to
obtain a session cookie is the dev-auth bootstrap, which fires on a cookie-less
`GET /api/me` and mints a fixed `dev-user` identity. The SPA calls that endpoint
on load, so the app works with no login UI. Note that `config.ts` *throws* if
`DEV_AUTH_ENABLED=true` is combined with `NODE_ENV=production`.

## The `.env` contract

`compose.yaml` reads two variables from `.env` and passes the rest through to the
containers via `env_file`.

Required in `.env`:

| Variable | Notes |
| --- | --- |
| `WEB_ORIGIN` | The browser-facing origin, e.g. `https://speak.divcat.net`. Bare origin, no trailing slash. The auth guard 403s any request whose `Origin` is not in this list. Comma-separate to allow several. |
| `JWT_SECRET` | At least 32 characters. |
| `NODE_ENV` | `development` while dev-auth is in use. |
| `DEV_AUTH_ENABLED` | `true`. |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Used by both the control plane (to mint tokens) and the worker (to join rooms). |
| `STT_MODEL`, `LLM_MODEL`, `COACH_LLM_MODEL`, `TTS_MODEL` | Required by the agent worker; it exits at startup if any is missing. |

Optional: `COACH_API_KEY`, `COACH_BASE_URL`, `TTS_VOICE` (a blank value is
normalised to unset), `LOG_LEVEL`.

No separate provider key is needed when the `*_MODEL` values name LiveKit
inference models (`google/…`, `assemblyai/…`, `fishaudio/…`): those are billed and
authenticated by the `LIVEKIT_*` credentials above. Only set `COACH_API_KEY`
(and point `COACH_BASE_URL` away from its OpenAI default) if you route the coach
model at a non-LiveKit provider.

Do **not** set these in `.env` — compose supplies them because they are
container-internal facts: `HOST`, `PORT`, `REDIS_URL`, `DATA_DIR`, `COURSES_DIR`.
`DATA_DIR` and `COURSES_DIR` must be absolute or `config.ts` falls back to
looking for `pnpm-workspace.yaml` and throws; compose pins them to `/app/data`
and `/app/courses`.

Note that `WEB_ORIGIN` drives the cookie's `Secure` flag: if it starts with
`https:`, the session cookie is always `Secure`, so the app must be reached over
HTTPS. Terminate TLS in front of the `web` service.

## First deploy

```sh
sudo mkdir -p /opt/stacks/rehearsal
sudo cp compose.yaml .env /opt/stacks/rehearsal/
sudo chmod 600 /opt/stacks/rehearsal/.env
cd /opt/stacks/rehearsal
sudo docker compose config --quiet      # validates interpolation before you start
sudo docker compose up -d
sudo docker compose ps
```

The `web` port is bound to `127.0.0.1` only, so the host itself needs an ingress
in front of it (see below). To smoke-test before wiring ingress:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/
```

Curl will not send a `Secure` cookie over plain HTTP, so cookie-jar round-trips
against the loopback port fail with 401. Either test through the HTTPS hostname
or pass the cookie explicitly with `-H "Cookie: rehearsal_session=…"`.

## Updating and rolling back

`REHEARSAL_TAG` selects the GHCR tag; it defaults to `latest`. Pin it in `.env`
to make a rollback a one-line change:

```sh
# .env
REHEARSAL_TAG=sha-1a2b3c4
```

```sh
sudo docker compose pull && sudo docker compose up -d
```

Use `sha-<short>` rather than `latest` for anything you might need to revert.
`latest` and `master` both move.

## Operating

```sh
cd /opt/stacks/rehearsal
sudo docker compose ps
sudo docker compose logs -f agent-worker
sudo docker compose restart agent-worker
sudo docker compose down            # keep data
sudo docker compose down -v         # WIPE the SQLite DB and Redis, back to first-run
```

A healthy start shows the control plane logging its mapped routes and the agent
worker logging a successful LiveKit Cloud registration. Two `event loop blocked`
warnings from the worker at startup are expected — that is the stack sampler
coming up, not a fault.

## Ingress

The reference deployment puts a Cloudflare Tunnel in front of
`127.0.0.1:8080`, which handles TLS and the public hostname without opening a
port. The `web` image's nginx uses `server_name _`, so it accepts any `Host`
header and needs no config change for this.

```sh
cloudflared tunnel create <name>
cloudflared tunnel route dns <name> speak.example.com
cloudflared service install
```

with `/etc/cloudflared/config.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json
ingress:
  - hostname: speak.example.com
    service: http://127.0.0.1:8080
  - service: http_status:404
```

The credentials file and the tunnel config should be mode `600`.

Two traps here. `cloudflared tunnel list` needs the *origin certificate*, which
`cloudflared tunnel login` writes to the invoking user's `~/.cloudflared/`. Running
it under `sudo` therefore fails with "Cannot determine default origin certificate
path" even though the running tunnel is fine — it reads the credentials file, not
the cert. And DNS can appear broken right after `route dns`: a resolver that
cached the negative answer keeps returning NXDOMAIN for up to a minute after the
authoritative nameservers already have the record.

## Troubleshooting

If a session starts but the tutor never speaks, check `agent-worker` for
`worker.job_failed`. The worker's `entry` catch block logs only the session id and
then rethrows a deliberately redacted message ("consult redacted worker error
codes"), so the underlying cause is *not* in the logs — you have to reason from
the code path. Failures land in one of two places: a fast failure (well under a
second) happens before the VAD model loads, meaning the Redis bootstrap for that
session was missing or the dispatched room did not match; a slow failure means the
learner participant never joined. The worker will not begin speaking until the
learner is present, so a `POST /api/sessions` with no browser following it always
looks like a failure at the end of the session.

## Resource footprint

Roughly 500-700 MB resident for the agent worker (it peaks while loading the
VAD model), ~50 MB for the control plane, and single-digit MB for redis and web.
The worker is the container to watch on a small host — give the machine swap or
headroom if it shares the box with anything else. Note that the worker only
loads the VAD model once a job arrives, so a freshly started worker looks cheap
until the first session.

There is no rate limiting, no TLS config in this stack, and no backup of the
`control-plane-data` volume. Back that volume up if the progress data matters.
