# Deploying Rehearsal to Fly.io

Fly.io does not run `docker-compose.yml`. The Compose file is a single-host
description (one network namespace, container-name DNS, shared volumes), so the
translation here is one Fly **app per service** — three apps in the same Fly
organization, which automatically share the private `6pn` network — plus a
managed Redis.

| Compose service | Fly app            | Public? | Notes |
| --------------- | ------------------ | ------- | ----- |
| `web`           | `rehearsal-web`    | yes     | nginx serves the bundle and proxies `/api/` to the API app |
| `control-plane` | `rehearsal-api`    | no      | SQLite on a 1 GB volume; reached over private DNS |
| `agent-worker`  | `rehearsal-agent`  | no      | outbound WebSocket to LiveKit only; no inbound ports |
| `redis`         | Upstash (Fly Redis) | no     | see [Redis](#redis) for the self-hosted alternative |

The API is deliberately private. `fly.web.toml` builds the same nginx image but
installs `deploy/fly/nginx.fly.conf` instead of `apps/web/nginx.conf`, which
repoints the `/api/` upstream from the Compose name `control-plane` to
`rehearsal-api.internal`. The browser therefore keeps talking to a single
origin, so the auth cookie stays first-party and the generated API client needs
no change.

## Prerequisites

- A Fly.io account and a payment method (there is no free tier).
- [`flyctl`](https://fly.io/docs/flyctl/install/) installed and `fly auth login` completed.
- A filled-in `.env` — the same one `docker compose` uses. `LIVEKIT_URL`,
  `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` are required.

## Deploy

```sh
./deploy/fly/deploy.sh
```

The script is idempotent, so re-running it is the normal way to ship a change.
It will:

1. Read the app names out of `fly.*.toml` (so renaming an app there is enough).
2. Create the three apps if they do not exist.
3. Create the `rehearsal_api_data` volume in `$REGION` (default `sin`).
4. Create an Upstash Redis database, or reuse `$REDIS_NAME` if it exists.
5. Push secrets with `--stage`, so they are in place before any Machine starts.
6. Deploy the agent, then the API, then the web app.

```sh
REGION=hkg ./deploy/fly/deploy.sh                 # pick another region
REDIS_URL=rediss://... ./deploy/fly/deploy.sh     # bring your own Redis
ENV_FILE=./.env.production ./deploy/fly/deploy.sh # another env file
```

When it finishes, the app is at `https://rehearsal-web.fly.dev`.

> App names are global across all of Fly.io. If `rehearsal-web` is taken, change
> the `app` line in `fly.web.toml` — the script derives everything else,
> including `WEB_ORIGIN`, from it.

## Configuration

Non-secret values live in the `[env]` blocks of `fly.*.toml`. Everything
sensitive is a Fly secret, which takes precedence over `[env]`:

| Secret | Apps | Source |
| ------ | ---- | ------ |
| `JWT_SECRET` | api | `.env`, or generated if empty |
| `REDIS_URL` | api, agent | Upstash, or `$REDIS_URL` |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | api, agent | `.env` |
| `WEB_ORIGIN` | api | `https://<web app>.fly.dev` |
| `COACH_API_KEY` | agent | `.env`, optional |

`WEB_ORIGIN` is pushed as a secret rather than left to `[env]` so that renaming
the web app cannot silently break CORS and the cookie origin check. It must be a
bare origin with no trailing slash — `apps/control-plane/src/config.ts` rejects
anything else.

Two values are worth calling out:

- **`HOST = "::"`** on the API. The `6pn` network is IPv6-only, so the Nest
  listener has to accept IPv6; `::` also accepts IPv4, which is what keeps the
  app working if it is ever given a public address. The usual Fly advice to bind
  `fly-local-6pn` does not apply here, because the API is reached by nginx, not
  by a Fly Proxy.
- **`DATA_DIR = "/data"` and `COURSES_DIR = "/app/courses"`** are absolute
  because the runtime image does not ship `pnpm-workspace.yaml`, so
  `config.ts` cannot infer the workspace root and falls back to a path that does
  not exist inside the container.

`DEV_AUTH_ENABLED` is intentionally absent: `config.ts` refuses to start when it
is enabled together with `NODE_ENV=production`.

> **Do not run `fly secrets import < .env`.** The local `.env` is a development
> file: it sets `DEV_AUTH_ENABLED=true`, `NODE_ENV=development`,
> `HOST=127.0.0.1` and a `REDIS_URL` pointing at localhost. Secrets override
> `[env]`, so importing it wholesale stops the API from booting at all. The
> deploy script pushes an explicit whitelist of keys instead.

## Redis

By default the script provisions [Upstash](https://fly.io/docs/upstash/redis/)
through `fly redis create`. That is the supported path: it is managed, billed
through Fly, and lives outside the organization's private network.

To keep the cache inside your own `6pn` network instead:

```sh
fly apps create rehearsal-redis
fly volumes create rehearsal_redis_data -a rehearsal-redis -r sin -s 1 -y
fly deploy --config fly.redis.toml --ha=false

# then point both apps at it and redeploy (--app takes one app at a time)
fly secrets set -a rehearsal-api   REDIS_URL=redis://rehearsal-redis.internal:6379
fly secrets set -a rehearsal-agent REDIS_URL=redis://rehearsal-redis.internal:6379
fly deploy --config fly.api.toml --ha=false
fly deploy --config fly.agent.toml --ha=false
```

That instance is unauthenticated. It has no public IP, so only Machines in your
organization can reach it — which also means every app in the organization can
read live session data. Fine for a demo, not for real user data.

## Operating it

```sh
fly logs -a rehearsal-api           # or -a rehearsal-agent, -a rehearsal-web
fly status -a rehearsal-web
fly ssh console -a rehearsal-api    # shell inside the Machine
fly scale count 1 -a rehearsal-agent
```

To ship a single service:

```sh
fly deploy --config fly.api.toml --ha=false
```

To roll back, find the release and redeploy its image:

```sh
fly releases -a rehearsal-api
fly deploy --image <image ref from the release> -a rehearsal-api
```

### Why `--ha=false`

`--ha=false` keeps Fly from leaving a stopped standby Machine next to the
running one. The API cannot use one anyway — a volume is pinned to a single
Machine and cannot be shared — and for the other two apps a standby doubles the
bill for no benefit at this size.

For the same reason `fly.api.toml` sets `strategy = "rolling"`: the `canary` and
`bluegreen` strategies are not allowed for Machines with a volume attached.

### Troubleshooting

| Symptom | Cause |
| ------- | ----- |
| `/api/...` returns 502 | The API app is not running or was renamed. `fly logs -a rehearsal-api`, and check that the upstream in `deploy/fly/nginx.fly.conf` matches `fly.api.toml`'s `app`. |
| Login succeeds, then every request is unauthenticated | `WEB_ORIGIN` does not match the browser's origin exactly, or the app is being reached over plain HTTP — the cookie is `Secure` in production. |
| API exits at boot with a zod error | A required secret is missing. `fly secrets list -a rehearsal-api` shows names only; re-run the deploy script to reset values. |
| Sessions never get a coach or audio | The agent app is not registered with LiveKit. `fly logs -a rehearsal-agent` and confirm all four apps share one `LIVEKIT_API_KEY`/`LIVEKIT_AGENT_NAME` pair. |

## Alternative: deploy prebuilt images

`.github/workflows/docker-publish.yml` already publishes three images to GHCR.
If you would rather not build on Fly's remote builder, add an `[image]` block to
each config pointing at
`ghcr.io/stkevintan/speak-demo-<control-plane|agent-worker|web>` and deploy
with `fly deploy --image`. Note that the web image built there installs the
default `apps/web/nginx.conf`, whose upstream is the Compose name
`control-plane`, so it needs the `NGINX_CONF` build arg to work on Fly.
