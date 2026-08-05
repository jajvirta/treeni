# treeni workout backend

A minimal, single-user serverless backend that durably stores **workout
sessions**. Required — the app reads/writes all workouts here. All analytics
stay client-side (`stats.js`); the backend is thin storage only. (Architecture
adapted from the darts-count reference app; the wiring is identical, only the
session shape differs.)

## Shape

```
Browser (Log view)
   │  fetch  X-Api-Key: <API_TOKEN>
   ▼
CloudFront  ──  behavior "/<prefix>/api/*"  (CachingDisabled + a custom origin
   │            request policy: forwards X-Api-Key + query strings, not Host)
   │            injects  X-Origin-Secret: <ORIGIN_SECRET>
   ▼
API Gateway HTTP API  (public; Lambda proxy, payload format 2.0)
   ▼
Lambda  (Node 20, no bundled deps — SDK from runtime)
   │            checks X-Origin-Secret (origin guard) + X-Api-Key (user)
   ▼
DynamoDB table  (pk="me", sk=<id>)   on-demand billing
```

Why this shape: it reuses your existing CloudFront distribution (same-origin —
no CORS) and costs ~nothing at personal volume.

**Why API Gateway and not a Lambda Function URL.** This was hard-won. A Lambda
Function URL could not work here:
- *Anonymous (`auth NONE`)* URLs are blocked by the AWS Organizations guardrail
  in this account — persistent `AccessDeniedException` no matter how correct the
  function's own policy is.
- *`AWS_IAM` + CloudFront OAC* (CloudFront SigV4-signs each request) authenticates
  fine for bodyless GETs but **cannot sign a POST**: OAC signs neither the
  request body nor (correctly) the query string, so every write failed with
  `The request signature we calculated does not match …`. That's a CloudFront OAC
  limitation, not a misconfiguration.

API Gateway is the sanctioned way to expose a Lambda, isn't subject to the
Function-URL guardrail, and needs no request signing — so bodies and query
strings just work. We keep it private-in-practice with the `X-Origin-Secret`
header (only CloudFront sends it; the Lambda rejects requests without it).

**Why the user secret is `X-Api-Key`:** convention; the Lambda reads it there.
Writes still pass their fields in the **query string** (a carry-over that's
harmless and keeps the client identical to the OAC era; bodies would also work
now).

## API

All under `/<prefix>/api` (e.g. `/treeni/api`). Every request needs
`X-Api-Key: <API_TOKEN>`; CloudFront additionally injects `X-Origin-Secret`.
Writes send a **JSON body** (the workout has a nested `entries[]`/`sets[]`).

| Method | Path             | Body (JSON)                              | Returns            |
|--------|------------------|------------------------------------------|--------------------|
| GET    | `/sessions`      | —                                        | `{ sessions: [] }` |
| POST   | `/sessions`      | `{ date, entries:[{exerciseId,sets:[{weight,reps,ts?}]}], notes? }` | `{ session }` |
| PUT    | `/sessions/{id}` | same                                     | `{ session }`      |
| DELETE | `/sessions/{id}` | —                                        | `{ deleted }`      |

The Lambda derives `volume` (Σ weight×reps), `sets`, and `reps` from `entries`.
Per-set `ts` (epoch ms, when the set was logged) is optional and stored verbatim —
the client derives rest times from it; a non-integer/out-of-range `ts` is a 400
rather than being silently dropped.

**Writes carry data in the query string, not a JSON body.** This started as an
OAC workaround (OAC doesn't sign bodies) and is kept now because it's harmless
and the client is already written that way — with API Gateway a JSON body would
work too. The Lambda reads fields from `queryStringParameters` (and still
accepts a JSON body). Payloads are tiny, so URL-length limits are a non-issue.

## One-time setup

1. Fill in `deploy.env` (gitignored). Generate the secrets:
   ```sh
   openssl rand -hex 24   # -> API_TOKEN
   openssl rand -hex 24   # -> ORIGIN_SECRET
   ```
   Set `API_TOKEN`, `ORIGIN_SECRET`, and (optionally) `TABLE_NAME` /
   `LAMBDA_NAME` / `LAMBDA_ROLE`. `REGION`, `DISTRIBUTION_ID`, and `PATH_PATTERN`
   are the same values the static deploy already uses.

2. Provision (idempotent; prompts before mutating the distribution):
   ```sh
   aws-vault exec <profile> -- ./infra/backend.sh
   #   APPLY=1 aws-vault exec <profile> -- ./infra/backend.sh   # skip prompt
   ```
   This creates the DynamoDB table, the IAM role, the Lambda, a public API
   Gateway HTTP API in front of it, and adds a CloudFront origin (pointing at
   API Gateway) + an **ordered** `/<prefix>/api/*` behavior placed *before* the
   app behavior so it wins precedence.

3. Deploy the static files as usual (`./deploy.sh`) — the new `Log` view, the
   manifest, and the icons ship with it.

4. Open the app → **Log** tab → paste `API_TOKEN` once (stored only in that
   browser's `localStorage`). Add it on each device you log from.

## Re-running / updating

`backend.sh` is idempotent. Re-run it to push new Lambda code (it updates the
function and skips the distribution change when the origin/behavior already
exist). Requires `aws`, `jq`, `zip`.

## Notes & caveats

- **Auth is single-user and simple by design.** Two shared secrets: the
  `X-Origin-Secret` header (CloudFront-injected; stops direct hits to the public
  API Gateway endpoint) and the `X-Api-Key` user secret — right for a personal
  app, not multi-tenant. Rotate `API_TOKEN`/`ORIGIN_SECRET` in `deploy.env` and
  re-run `backend.sh` (then re-paste the token in the app).
- **The API Gateway endpoint is public** — anyone who discovers it can reach it,
  so `ORIGIN_SECRET` must be set (the Lambda rejects requests without the
  matching `X-Origin-Secret`, which only CloudFront sends).
- **DynamoDB is the single source of truth** for sessions. Enter everything via
  the app's Log tab. (The progress math lives in `public/js/scoring-stats.js`,
  which the Log view uses and which has a Node export shim for unit tests.)
- **`.webmanifest` content-type:** `aws s3 sync` may upload it as
  `application/octet-stream`. Browsers still honor the `apple-touch-icon` +
  Apple meta tags for iOS home-screen install, so this is cosmetic. If you want
  the manifest served correctly, re-put it with
  `--content-type application/manifest+json`.
- **Cost:** DynamoDB on-demand + Lambda + a trickle of CloudFront requests —
  effectively free at one user logging a few sessions a day.

## Local verification

The pure logic is testable without AWS: the `scoring-stats.js` math (Node export
shim) and the Lambda's router/auth/validation (exported helpers in `index.mjs`,
which dynamic-imports the AWS SDK only inside the handler). The Log view itself
is exercised via headless Chrome over CDP against a mocked backend — see
`CLAUDE.md` "Verifying changes".
