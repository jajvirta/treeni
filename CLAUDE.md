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
  `store.js → numpad.js → catalog.js → stats.js → bodystats.js → workout.js →
  progress.js → program.js → body.js → app.js`. Keep this order; `bodystats.js`
  reads calendar helpers off `Stats`, and `app.js` loads last (boots on
  `DOMContentLoaded`).
- **PWA:** `manifest.webmanifest` + `icons/` (from the one-off `infra/make-icons.js`,
  pure Node) + Apple meta → installable to the phone home screen.
- **Module pattern:** each file is an IIFE attaching one global (`window.Catalog`,
  `Stats`, `BodyStats`, `Workout`, `Progress`, `Program`, `Body`, `Settings`,
  `Sessions`, `Days`, `Store`, `Numpad`). `stats.js` and `bodystats.js` also have
  a Node `module.exports` shim for CLI unit tests.
- **Four views** (`#view-today`, `#view-progress`, `#view-body`, `#view-program`)
  switched by the header tabs. `app.js` owns routing + a single global `keydown` bus that
  forwards to the active view's controller.
- **View-controller interface:** each view controller exposes
  `{ init, onActivate, onDeactivate, onKey }`. `app.js` calls these on tab
  switch. Follow this shape for any new view.
- **`Numpad` is a singleton** shared across views. `workout.js` re-`init`s it
  onto its own `#loggerPad` when you open an exercise (`bindPad()`); `body.js`
  claims it for `#bodyPad` on every render. Leaving Today always closes the
  logger (`showHome()` clears `group`), so re-binding on open is sufficient — if
  that ever changes, `Workout.onActivate` has to re-bind too.

## Storage & backend

- **DynamoDB is the source of truth for workouts.** `Sessions` (in `app.js`)
  reads/writes via `Store` (`store.js` → API Gateway + Lambda). A localStorage
  **mirror** (`trn.cache`) keeps recent data visible offline; the in-progress
  session (`trn.current`) is autosaved locally so a reload never loses reps.
  Writes hit the backend on **Finish** (and manual add); if unconnected/ offline,
  the entry stays in `trn.current` to retry.
- **Deleting** is deliberately split: *Today* → "Discard session" only drops the
  local in-progress session (never a network call); the ✕ on a set row drops one
  unsaved set. *Progress* → the session browser is the only place stored data can
  be removed (`Sessions.remove`, or `Sessions.update` to drop one set). Both
  confirm first, and discarding a saved session's last set becomes a full-session
  delete — the Lambda rejects a session with zero sets.
- **Connect flow:** the app needs an `X-Api-Key` token pasted once in the
  **Program** tab (`Settings` → `trn.settings.apiToken`). If unset on boot,
  `app.js` routes to Program.
- **Backend infra** (`infra/backend.sh`, idempotent): DynamoDB table + IAM role +
  Node 20 Lambda + **public API Gateway HTTP API** (not a Function URL — org
  guardrail blocks anonymous, OAC can't sign POST bodies). Gated by
  CloudFront-injected `X-Origin-Secret` + user `X-Api-Key`. Full runbook:
  `infra/BACKEND.md`; troubleshoot with `infra/diagnose-backend.sh`.
- localStorage keys are prefixed **`trn.`** (`trn.settings`, `trn.catalog`,
  `trn.current`, `trn.cache`, `trn.days`).
- **Day logs** (the Body view) are a second record type: one sparse record per
  calendar date, `pk='log'`/`sk=<date>` in the same table, reached through
  `Days` (app.js) → `Store.listLogs/putLog/removeLog` → `/logs` routes. Keyed by
  date, so a write is an upsert. `Days` has an **outbox**: a write that can't
  reach the backend stays in the `trn.days` mirror flagged `pending` and is
  retried on the next `refresh()`. The plan itself (`Settings.plan`) is config,
  not data, and deliberately stays local.

## Key invariants (don't break these)

- **`stats.js` is the single source of truth** for all *training* analytics (volume,
  frequency/streak, per-exercise history + small-win detection, weekly
  sets-per-muscle, rest between sets, add-weight advice). Pure, no DOM/I/O. The
  views only format its output. After
  changing it, re-run the Node unit snippet (below).
- **`bodystats.js` is the single source of truth for the body/energy side**
  (weight trend + EMA, rate of loss *with its interval*, deficit/maintenance
  phase schedule, the plan corridor, habit adherence, Zone 2 volume, stall
  detection). Same rules: pure, no DOM/I/O, Node-testable. It owns the maths
  `stats.js` deliberately doesn't; don't duplicate either way. Two invariants
  worth keeping: a rate is **never** reported without its band, and
  `stallCheck` **never fires under 8 weeks** of settled deficit data — at
  ~0.2 kg/week against ~1 kg of daily noise, a 4-week window can't tell losing
  from flat, so advising off one would be noise dressed as coaching.
- **The cut is a corridor, not a deadline.** The plan spans the 1-year and
  2-year paths and its slow edge is a success; maintenance blocks flatten it, so
  a flat scale during a planned break is exactly on plan. Never a red
  "behind schedule" state, and no weigh-in streak to break — coverage is
  reported instead. No calorie/food logging, no BMI or body-fat estimates from
  scale weight, and no habit-versus-loss correlation claims (the sample is far
  too small and too noisy to support one).
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

- **Analytics** (both pure, Node-testable):
  ```sh
  node -e 'const S=require("./public/js/stats.js");
    const ses=[{date:"2026-07-01",entries:[{exerciseId:"leg-press",sets:[{weight:100,reps:10}]}]}];
    console.log(S.sessionVolume(ses[0]), S.weeklyFrequency(ses,{nowDay:S.dayNum("2026-07-02")}));'

  node -e 'const B=require("./public/js/bodystats.js");
    const plan={planStart:"2026-09-01",startKg:105,targetKg:90,age:45};
    const days=[...Array(84)].map((_,i)=>({date:new Date(Date.UTC(2026,8,1+i)).toISOString().slice(0,10),
      kg:105-0.24*i/7+Math.sin(i*2.3)}));
    console.log(B.planRates(plan), B.rate(days,{lookbackDays:28}), B.rate(days,{lookbackDays:84}));'
  ```
  Sanity checks worth keeping: the 4-week band includes zero while the 12-week
  band doesn't; `planRates` gives ~0.36 / ~0.18 kg/week for the 12/24-month
  paths; `corridor` is flat across a maintenance block.
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
