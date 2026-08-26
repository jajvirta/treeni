# treeni 🏋️

A simple, **motivation-first gym training log**. Log your sets (machine, weight ×
reps), and the app keeps you coming back — it makes **frequency** and **small
wins** (one more rep on set 4, +1.25 kg) the headline, not maximal strength.

Built for a **time-efficient, reasonable** routine: aim for **2 sessions/week, 1
is fine** on busy weeks. No forced schedule, no guilt.

## What it does

- **Today** — log a session set by set on the numeric keypad, with *last time's*
  numbers shown to beat. Change the date to add a **past workout** manually.
- **Progress** — your **week streak** and sessions/week up top (showing up is the
  win), then per-exercise trends and recent small wins, plus a weekly
  sets-per-muscle gauge against the minimum effective dose.
- **Body** *(experimental)* — a long, deliberate cut: **−15 kg over 1–2 years**.
  A daily weigh-in on the same keypad, a couple of habit checks, steps, and
  Zone 2 sessions. It shows what you *did* this week loudest, then the smoothed
  weight trend against a **corridor** between the 1-year and 2-year paths. No
  food logging, ever.
- **Program** — the built-in **time-efficient baseline** program (a short
  full-body superset routine), an editable exercise catalog, and the backend
  connection (paste your API token once).

## The baseline

The default program is the *minimum effective dose* drawn from Iversen, Norum,
Schoenfeld & Fimland (2021), *Sports Medicine* — **"No Time to Lift? Designing
Time-Efficient Training Programs for Strength and Hypertrophy: A Narrative
Review."** In short: a handful of compound machine lifts, 1–2 hard sets each
(close to failure), paired as supersets, 1–2×/week — meaningful results in ~30
min/session. A short session still **counts**.

## The cut (Body tab)

Same stance, transposed: the habits are the scoreboard and the scale is only the
instrument. **8-week deficit blocks with 2-week maintenance breaks**, giving
0.18–0.36 kg/week while in a deficit (≈200–390 kcal/day) — slow on purpose, so
the lifting keeps working and the muscle stays. Protein ~1.6 g/kg of goal weight,
steps above 9k, 2–3 Zone 2 sessions a week inside a heart-rate band.

The unusual part is the honesty about noise: daily weight swings ~±1 kg while the
signal is ~0.2 kg/week, so the app **never shows a rate without its uncertainty
band**, refuses to offer any advice on less than 8 weeks of data, and gives a
date *range* rather than a target date. A maintenance break is meant to be flat,
so the corridor is flat there too.

## Tech

Static, zero-build PWA (plain ES, no framework). Workouts are stored in DynamoDB
via a small personal serverless backend (API Gateway + Lambda), served from S3 +
CloudFront. See `PLAN.md` for the design, `CLAUDE.md` for dev guidance, and
`infra/BACKEND.md` for the backend runbook.

```sh
npm run dev          # serve public/ locally
# deploy (after filling deploy.env — see deploy.env.example):
aws-vault exec <profile> -- ./bootstrap.sh       # one-time static-site infra
aws-vault exec <profile> -- ./infra/backend.sh   # one-time backend
aws-vault exec <profile> -- ./deploy.sh          # every frontend deploy
```

Not affiliated with any product; a personal tool. Not medical or training advice.
