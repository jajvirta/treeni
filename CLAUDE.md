# CLAUDE.md

Guidance for working in **treeni**. See `PLAN.md` for the design/roadmap and
`README.md` for the user-facing overview.

## What this is

A **static, client-side gym training log**. Log sets (machine, weight × reps),
track **frequency** and **modest progress**. The point is motivation and steady
frequency — *not* maximizing strength. Workouts are stored in **DynamoDB** via a
personal serverless backend; the UI is served as static files from S3 behind
CloudFront. Architecture adapted from the `darts-count` app.

## Architecture — read before editing

- **No build step, no framework, no runtime deps.** `public/` ships as-is. Plain
  ES IIFE modules, each attaching one global. `<script>` tags load in a fixed
  order in `index.html`:
  `store.js → numpad.js → catalog.js → stats.js → workout.js → progress.js →
  program.js → app.js`. Keep this order; `app.js` loads last (boots on
  `DOMContentLoaded`).
- **PWA:** `manifest.webmanifest` + `icons/` (from the one-off `infra/make-icons.js`,
  pure Node) + Apple meta → installable to the phone home screen.
- **Module pattern:** each file is an IIFE attaching one global (`window.Catalog`,
  `Stats`, `Workout`, `Progress`, `Program`, `Settings`, `Sessions`, `Store`,
  `Numpad`). `stats.js` also has a Node `module.exports` shim for CLI unit tests.
- **Three views** (`#view-today`, `#view-progress`, `#view-program`) switched by
  the header tabs. `app.js` owns routing + a single global `keydown` bus that
  forwards to the active view's controller.
- **View-controller interface:** each view controller exposes
  `{ init, onActivate, onDeactivate, onKey }`. `app.js` calls these on tab
  switch. Follow this shape for any new view.
- **`Numpad` is a singleton** shared across views. `workout.js` re-`init`s it
  onto its own `#loggerPad` when you open an exercise.

## Storage & backend

- **DynamoDB is the source of truth for workouts.** `Sessions` (in `app.js`)
  reads/writes via `Store` (`store.js` → API Gateway + Lambda). A localStorage
  **mirror** (`trn.cache`) keeps recent data visible offline; the in-progress
  session (`trn.current`) is autosaved locally so a reload never loses reps.
  Writes hit the backend on **Finish** (and manual add); if unconnected/ offline,
  the entry stays in `trn.current` to retry.
- **Connect flow:** the app needs an `X-Api-Key` token pasted once in the
  **Program** tab (`Settings` → `trn.settings.apiToken`). If unset on boot,
  `app.js` routes to Program.
- **Backend infra** (`infra/backend.sh`, idempotent): DynamoDB table + IAM role +
  Node 20 Lambda + **public API Gateway HTTP API** (not a Function URL — org
  guardrail blocks anonymous, OAC can't sign POST bodies). Gated by
  CloudFront-injected `X-Origin-Secret` + user `X-Api-Key`. Full runbook:
  `infra/BACKEND.md`; troubleshoot with `infra/diagnose-backend.sh`.
- localStorage keys are prefixed **`trn.`** (`trn.settings`, `trn.catalog`,
  `trn.current`, `trn.cache`).

## Key invariants (don't break these)

- **`stats.js` is the single source of truth** for all analytics (volume,
  frequency/streak, per-exercise history + small-win detection, weekly
  sets-per-muscle, rest between sets, add-weight advice). Pure, no DOM/I/O. The
  views only format its output. After
  changing it, re-run the Node unit snippet (below).
- **Frequency is the headline, not load.** Keep the streak/frequency card the
  loudest thing on Progress; never build a 1RM leaderboard or a
  missed-schedule scold. `freqAim`/`freqFloor` default 2/1.
- **Sessions writes go through `Sessions.add/update/remove`** (which call
  `Store`), never straight to localStorage — the mirror is a read cache only.
- **A workout session shape** is `{ date, entries:[{exerciseId, sets:[{weight,reps,ts?}]}], notes? }`.
  The Lambda derives `volume/sets/reps` — don't duplicate that math on the client
  path that writes. `ts` is the epoch-ms stamp of when the set was logged (absent
  on legacy/manual sets); **rest is always derived from it, never stored**.
- **The session date is user-controlled** (change it on Today to log a past
  workout manually) — don't reintroduce auto-migration of "stale" sessions.
- **The superset group is `Settings.superset`** (default `[bench-press, seated-row]`,
  edited in Program). The Today logger is group-based: `group.length===1` is a
  single exercise; `>1` with `superMode` cycles + auto-advances with pre-fill.
  Default catalog is intentionally minimal (bench/row/leg press) — add more via
  the catalog editor, not by bloating the seed.

## Verifying changes

There are no automated tests; verify directly.

- **Analytics** (pure, Node-testable):
  ```sh
  node -e 'const S=require("./public/js/stats.js");
    const ses=[{date:"2026-07-01",entries:[{exerciseId:"leg-press",sets:[{weight:100,reps:10}]}]}];
    console.log(S.sessionVolume(ses[0]), S.weeklyFrequency(ses,{nowDay:S.dayNum("2026-07-02")}));'
  ```
- **UI / gameplay:** `npm run dev` and drive it. For e2e use **system headless
  Chrome over CDP** (mock `window.fetch` so `Store` returns canned sessions;
  dispatch `pointerdown` on `.np-*`/`.ex-btn`; read DOM; assert zero
  `Runtime.exceptionThrown`; screenshot ~390×760). Clean up temp dirs/processes.

## Deploy & infra

- Config in **`deploy.env` (gitignored)** — `BUCKET`, `REGION`, `DISTRIBUTION_ID`,
  `PATH_PATTERN` (e.g. `/treeni/*`), plus backend `API_TOKEN`/`ORIGIN_SECRET`/
  resource names. `deploy.env.example` is the committed template.
- **If this repo is ever made public, never commit** the bucket name,
  distribution id, account id, or secrets — keep them in `deploy.env` only.
- `bootstrap.sh` (one-time): private bucket + OAC + the `infra/index-rewrite.js`
  CloudFront Function, then additively an S3 origin + ordered behavior for
  `PATH_PATTERN`. `infra/backend.sh` (one-time): the workout backend. `deploy.sh`:
  `aws s3 sync public/` + CloudFront invalidation. Run as
  `aws-vault exec <profile> -- ./<script>.sh`. Need `aws`, `jq` (+ `zip` for the
  backend). Test any jq distribution transform against synthetic
  `get-distribution-config` output before applying.

## Conventions

- Terse, comment-light-but-purposeful. Plain ES (no TS, no modules), 2-space indent.
- Don't add a build tool/bundler/runtime dep — the zero-build static deploy is a feature.
- Commit/push only when asked.
