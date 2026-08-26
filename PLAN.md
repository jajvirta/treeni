# treeni — plan

A **static, client-side gym training log** whose primary job is to **keep you
coming back**, not to maximize strength. It tracks granular data (machine,
weight, sets, reps-per-set), surfaces **modest progress** (one extra rep on set
4, +1.25 kg), and treats **steady frequency** as the headline metric. Adapted
from the `darts-count` architecture (same zero-build PWA + optional backend).

## Design goals (in priority order)

1. **Motivation & frequency first.** The app celebrates *showing up* and small
   wins. Frequency (sessions/week) and the "you beat last time" nudge are the
   loudest things on screen — never a 1RM leaderboard.
2. **No forced schedule.** Target **2 sessions/week, 1 is fine** on some weeks.
   A week with ≥1 session is "above floor" (kept the streak); ≥2 is "on aim".
   Never a red "you missed leg day" scold.
3. **Time-efficient & reasonable.** The default program is the *minimum
   effective dose* — a short full-body session you can finish in ~30 min, so a
   busy week still counts.
4. **Granular tracking, gentle framing.** Log every set (weight × reps) so
   progress is visible at the rep level, but present it as encouragement.

## The baseline / minimum — from the "No Time to Lift?" review

> Iversen, Norum, Schoenfeld & Fimland (2021), *Sports Medicine* — "No Time to
> Lift? Designing Time-Efficient Training Programs for Strength and Hypertrophy:
> A Narrative Review."

Evidence-based, time-efficient defaults the app encodes (see `program.js`):

- **Volume is the main driver, with diminishing returns.** ~**4 hard sets per
  muscle group per week** already produces measurable growth; ~10+ maximizes it.
  We set the **floor at ~4 sets/muscle/week** (the "minimum effective dose"
  gauge) and a comfortable target around ~10 — *not* a push-to-the-max number.
- **Low volume works if effort is high.** With few sets, train **close to
  failure** (leave ~1–2 reps in reserve). One or two hard sets per exercise is
  enough for maintenance + modest gains.
- **Compound, multi-joint exercises** recruit lots of muscle per exercise, so a
  handful covers the whole body → fewer exercises, less time.
- **Time-saving structures:** agonist–antagonist **supersets** (e.g. chest
  press + row) roughly halve session time with little performance loss; drop
  sets / rest-pause / myo-reps bank effort fast.
- **Load is flexible.** ~30–80% 1RM all builds muscle if taken near failure;
  go heavier for strength. Pick whatever load hits the target reps near failure.
- **Full range of motion; minimal, specific warm-up.** Don't burn time.
- **Frequency:** total weekly volume matters more than how it's split; **2×/week
  full-body** is the time-efficiency sweet spot, **1×/week maintains**.

**Encoded default (the "counts as a session" baseline):** a small fixed set of
compound machines — **Bench press, Seated row, Leg press** — with bench + row run
as an alternating **superset** (one set each per round, close to failure, 6–15
reps), **1–2×/week**. The catalog and the superset group are both editable in
the Program tab (add other machines as needed).

## The Body view — an experimental long cut (−15 kg over 1–2 years)

A fourth, deliberately separate tab. Same motivation-first stance as the rest of
the app, transposed: **what you did this week is the loud thing, the scale is the
quiet instrument underneath it.**

**The program** (all of it derived from the setup numbers; worked here for a
~105 kg start → 90 kg target):

- **A corridor, not a deadline.** 8-week deficit blocks separated by 2-week
  maintenance breaks (80 % duty), giving **0.36 kg/week** on the 1-year path and
  **0.18 kg/week** on the 2-year path while in a deficit — 0.17–0.34 %
  BW/week, well under the ~0.5–1 %/week range where lean-mass loss and adherence
  problems concentrate. That's a deficit of roughly **200–390 kcal/day**.
- **Zone 2, 2–3 × 40–50 min/week**, logged as minutes + average HR. The band
  comes from age (Tanaka: HRmax ≈ 208 − 0.7 × age; Zone 2 ≈ 60–70 % HRmax) and
  sessions that ran above it are flagged — drifting into Zone 3 is the classic
  failure mode.
- **Protein ~1.6 g/kg of goal weight**, as a daily checkbox rather than grams.
  The single highest-yield rule, and what preserves lean mass in a deficit.
- **Steps above 9k (aim 11k)**, *measured*, not self-reported. NEAT collapse is
  the main hidden failure mode of a long deficit, so the step count is the
  early-warning system for it.
- **Maintenance breaks are part of the program**, not a pause: they blunt
  adaptation and are mostly what makes an 18-month project survivable. The
  corridor goes flat through them, so a flat scale there is exactly on plan.
- **Lifting is unchanged.** Expect progression to slow in a deficit; holding your
  weights while losing is the win.

**Why the maths looks the way it does.** Daily weight noise (~±1 kg) dwarfs the
signal (~0.2 kg/week). The 95 % band on a trend slope is roughly ±0.32 kg/week
over 4 weeks of daily weigh-ins, ±0.11 over 8, ±0.06 over 12 — and ~1.5× wider
again at three weigh-ins a week over the same span. So: the rate is never shown
without its band, `stallCheck` refuses to speak under 8 weeks, projections are
date *ranges*, and the first 10 days after a phase change are excluded from every
window (that's water and glycogen, not fat).

**What it is not:** no calorie or food logging, no BMI/body-fat estimates from
scale weight, no habit-versus-loss correlation claims, no "behind schedule" red
state, no weigh-in streak to break (coverage is reported instead).

## Architecture (inherited from darts-count)

- **Static, no build, no framework.** `public/` shipped as-is; plain ES IIFE
  modules each attaching one global; `<script>` tags in a fixed order, `app.js`
  last (boots on `DOMContentLoaded`).
- **localStorage-first.** All state lives in the browser. The **optional**
  DynamoDB backend (`infra/backend.sh` → API Gateway + Lambda, gated by
  `X-Api-Key` + CloudFront `X-Origin-Secret`) is copied in and ready but **not
  required** — start local, add sync later for multi-device. `store.js` is the
  client; `Store.configured()` is false until a token is pasted.
- **PWA** (`manifest.webmanifest` + icons + Apple meta) → installable to the
  phone home screen (you log at the gym on your phone).
- **View-controller interface** `{ init, onActivate, onDeactivate, onKey }`;
  `app.js` owns tab routing + a single keydown bus. **Numpad is a singleton**
  re-`init`'d onto the active view's keypad.
- **Deploy:** S3 + CloudFront via `bootstrap.sh` / `deploy.sh` (same conventions,
  `deploy.env` gitignored). Analytics are pure and client-side (`stats.js`, with
  a Node `module.exports` shim for CLI unit tests, like `scoring-stats.js`).

## Data model (localStorage keys prefixed `trn.`)

- **Exercise** (`trn.catalog`): `{ id, name, muscles: [group], machine?, unit:'kg'|'lb', targetReps, step, notes? }`.
  Seeded from the default program; user-editable (incl. target reps & weight step in Program).
  `group ∈ {legs, push, pull, core}` (coarse on purpose — motivation, not sports science).
- **Session** (`trn.sessions[]`): `{ id, date:'yyyy-mm-dd', entries: [ { exerciseId, sets: [ { weight, reps, ts? } ] } ], notes?, durationMin? }`.
  `ts` = epoch ms when the set was logged; rest between sets is derived from it in
  `stats.js` (never stored). Absent on legacy/manually added sets → rest unknown.
- **In-progress** (`trn.current`): autosaved today-session so a reload/leave never loses reps.
- **Day log** (`trn.days[]`, mirror of `pk='log'` in DynamoDB): one sparse record
  per calendar date — `{ date, kg?, steps?, cardio:[{min,avgHr?,kind}], habits:{protein,sleep}, notes? }`.
  Keyed by date, so a write is an upsert. Habits are two-state: `true` or absent.
- **Settings/goals** (`trn.settings`): `{ freqAim:2, freqFloor:1, unit, plan, habitKeys, ... }`,
  where `plan` is the cut config: `{ planStart, startKg, targetKg, deficitWeeks:8,
  maintWeeks:2, fastMonths:12, slowMonths:24, age|hrMax, stepAim, z2Aim, gPerKg, blocks? }`.
  Config, not data — it stays local; `blocks` is only materialised when you
  hand-edit a phase (e.g. extend a break).

## Modules (`public/js/`, load order)

`store.js → numpad.js → catalog.js → stats.js → bodystats.js → workout.js →
progress.js → program.js → body.js → app.js`

- **catalog.js** (`Catalog`) — exercise CRUD over localStorage; seeds the default
  program on first run.
- **stats.js** (`Stats`, pure + Node shim) — the analytics single source of truth:
  - `sessionVolume(session)` = Σ weight×reps (tonnage) + total sets.
  - `isoWeek(date)`, `weeklyFrequency(sessions, now)` → sessions this week,
    **week streak** (consecutive weeks with ≥floor), on-aim/above-floor flags.
  - `exerciseHistory(sessions, exId)` → per-session series (volume, top set,
    est. 1RM Epley) **+ `beatLastTime`** small-win detector (more reps at ≥ weight,
    or ≥ reps at more weight — even on a single set).
  - `weeklySetsByMuscle(sessions, catalog, week)` → sets/muscle vs the ~4 floor.
  - De-emphasize 1RM; it exists but is never the headline.
- **workout.js** (`Workout`, the **Today** view) — the primary screen. Two flows,
  both group-based internally: **single exercise** (straight sets) and
  **superset** (cycles through `Settings.superset`, e.g. bench ↔ row — after each
  set it auto-advances to the next exercise with weight & reps **pre-filled** from
  your last set, so each round is one tap; shows a round counter + per-exercise
  chip counts). Last time's numbers shown to beat. The **session date is
  editable** → log a past workout manually. Autosave to `trn.current`; Finish
  saves to the backend via `Sessions.add`.
- **progress.js** (`Progress`, the **Progress** view) — the motivation dashboard:
  frequency streak + "sessions this week" up top (the loudest tile), then
  per-exercise trends (volume line, rep progress, recent PRs/small wins).
- **program.js** (`Program`, the **Program** view) — the baseline guide (the
  bullet summary above) + editable exercise catalog + the default template.
- **bodystats.js** (`BodyStats`, pure + Node shim) — the body/energy counterpart
  to `stats.js`: `trend` (gap-tolerant EMA), `rate` (OLS slope **with an AR(1)-
  widened interval**), `phases`/`phaseAt` (the deficit/maintenance schedule),
  `planRates`/`corridor`/`corridorSeries`/`corridorStatus`, `deficitRate`
  (settled deficit days only), `projection` (a range, duty-cycle aware),
  `proteinTarget`, `hrZone2`, `weighinStats`, `zone2Stats`, `stepStats`,
  `habitStats`, and `stallCheck` — the only function that gives advice, and only
  after 8 weeks.
- **body.js** (`Body`, the **Body** view) — check-in (weigh-in on the shared
  Numpad, habit chips, steps, Zone 2) → the "showing up" card → the trend chart
  (corridor band + daily ticks + trend line) → phase strip → day log.

## Views / tabs

**Today** (log) · **Progress** (frequency + per-exercise) · **Program** (guide + catalog).

## Phases

1. **DONE (scaffold):** project set up, infra + shell + numpad/store copied &
   rebranded, theme, `catalog.js` seed + default program, `stats.js` pure core
   with unit tests, a minimal working **Today** logging loop and a **Progress**
   frequency card, **Program** guide. App boots and logs a session locally.
2. **Progress depth:** per-exercise trend charts (volume/reps), PR/small-win
   feed, weekly sets-vs-baseline gauge, streak visualization.
3. **Ergonomics:** superset pairing in the logger, rest timer (optional),
   quick-repeat "same as last time" set entry, per-set RIR/near-failure tag.
4. **Optional sync:** wire the DynamoDB backend (adapt `validateSession` for
   workout sessions — already stubbed), paste-token flow like darts, multi-device.
5. **DONE — the Body view:** `bodystats.js` + `body.js` + the `/logs` backend
   routes (`pk='log'`, keyed by date) and the `Days` store with an offline
   outbox. The experimental long cut described above.
6. **Nice-to-have:** unit auto-detect, plate calculator, deload week suggestion
   when frequency dips, body measurements (waist) alongside the weigh-in,
   pulling steps/HR from a watch instead of typing them.

## Verifying changes (same as darts-count)

- **Pure analytics:** `node -e` unit tests against `stats.js` (Node shim).
- **UI:** `npm run dev` and drive it; for e2e use **system headless Chrome over
  CDP** (mock `Store`/localStorage, dispatch pointer events on the numpad, read
  DOM, assert zero `Runtime.exceptionThrown`, screenshot ~390px). Clean up temp
  dirs/processes after.

## Non-goals

- Not a periodization/coaching engine. Not a social/leaderboard app. Not chasing
  1RM. No forced schedules, streak-loss guilt, or "you're behind" messaging.
- Not a food diary. The Body view never asks what you ate, and no amount of
  future convenience justifies adding it — the whole design assumes it isn't
  there.
