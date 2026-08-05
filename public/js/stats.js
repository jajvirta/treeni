/* ============================================================
 * stats.js — training analytics (pure, no DOM, no I/O).
 * Single source of truth for the progress/frequency math, used by the
 * browser (window.Stats) and unit-testable via the Node export shim.
 * A "session" is { date:'yyyy-mm-dd', entries:[{ exerciseId, sets:[{weight,reps,ts?}] }] }.
 * `ts` (epoch ms, stamped when the set was logged) is optional — older and
 * manually added sets have none, so rest times are simply unknown there.
 * Frequency is the headline metric — the app is about showing up, not maxing.
 * ============================================================ */
(function (global) {
  'use strict';

  const DAY = 86400000;
  const sum = a => a.reduce((x, y) => x + y, 0);
  const round = n => Math.round(n * 10) / 10;
  const dayNum = iso => Math.floor(Date.parse(iso + 'T00:00:00Z') / DAY);
  // Monday-aligned week bucket (epoch day 0 = Thursday → +3 shifts Monday to 0).
  const weekIndex = iso => Math.floor((dayNum(iso) + 3) / 7);
  const weekIndexFromDay = d => Math.floor((d + 3) / 7);

  // Estimated 1RM (Epley). De-emphasised in the UI — never the headline.
  const epley1RM = (w, reps) => (reps > 1 ? w * (1 + reps / 30) : w);

  // Volume/sets/reps for one session.
  function sessionVolume(session) {
    let volume = 0, sets = 0, reps = 0;
    (session.entries || []).forEach(e => (e.sets || []).forEach(s => {
      volume += (s.weight || 0) * (s.reps || 0);
      reps += (s.reps || 0);
      sets += 1;
    }));
    return { volume, sets, reps };
  }

  // Sessions/week, current-week count, and the consecutive-week STREAK — the
  // motivation centrepiece. An empty in-progress week never breaks the streak.
  function weeklyFrequency(sessions, opts) {
    opts = opts || {};
    const floor = opts.freqFloor || 1;
    const aim = opts.freqAim || 2;
    const now = (opts.nowDay != null) ? opts.nowDay : Math.floor(Date.now() / DAY);
    const curWeek = weekIndexFromDay(now);

    const counts = {};
    let firstWeek = curWeek;
    sessions.forEach(s => {
      const w = weekIndex(s.date);
      counts[w] = (counts[w] || 0) + 1;
      if (w < firstWeek) firstWeek = w;
    });

    const thisWeek = counts[curWeek] || 0;
    // Count back from the current week; a not-yet-met current week is skipped
    // (in progress), not treated as a miss.
    let streak = 0;
    let w = (thisWeek >= floor) ? curWeek : curWeek - 1;
    for (; w >= firstWeek; w--) {
      if ((counts[w] || 0) >= floor) streak++; else break;
    }

    const perWeek = [];
    for (let k = firstWeek; k <= curWeek; k++) perWeek.push({ week: k, count: counts[k] || 0 });

    return {
      thisWeek, streak, floor, aim,
      onAim: thisWeek >= aim,
      aboveFloor: thisWeek >= floor,
      weeksActive: Object.keys(counts).length,
      perWeek,
      totalSessions: sessions.length,
    };
  }

  // Rest between consecutive sets of ONE exercise, in seconds: element i is the
  // gap from set i-1 to set i. null where unknowable (first set, missing `ts`).
  function restBetween(sets) {
    sets = sets || [];
    return sets.map((s, i) => {
      if (!i) return null;
      const a = (sets[i - 1] || {}).ts, b = s && s.ts;
      if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
      return Math.round((b - a) / 1000);
    });
  }
  function avgRest(sets) {
    const xs = restBetween(sets).filter(n => n != null);
    return xs.length ? Math.round(sum(xs) / xs.length) : null;
  }

  // Collapse consecutive same-weight sets so a view can print
  // "48kg × 10, 10, 9, 6" instead of four rows. Data only — views format.
  function groupSets(sets) {
    const out = [];
    (sets || []).forEach(s => {
      const w = s.weight || 0;
      const last = out[out.length - 1];
      if (last && last.weight === w) last.reps.push(s.reps || 0);
      else out.push({ weight: w, reps: [s.reps || 0] });
    });
    return out;
  }

  // A small, comparable snapshot of one exercise in one session.
  function point(session, exId) {
    const entry = (session.entries || []).find(e => e.exerciseId === exId);
    if (!entry || !(entry.sets || []).length) return null;
    const sets = entry.sets;
    let volume = 0, reps = 0, top = sets[0];
    sets.forEach(s => {
      volume += (s.weight || 0) * (s.reps || 0);
      reps += (s.reps || 0);
      if ((s.weight || 0) > (top.weight || 0) ||
        ((s.weight || 0) === (top.weight || 0) && (s.reps || 0) > (top.reps || 0))) top = s;
    });
    return {
      date: session.date, volume, reps, setCount: sets.length,
      topWeight: top.weight || 0, topReps: top.reps || 0,
      topSet: { weight: top.weight || 0, reps: top.reps || 0 },
      e1rm: round(epley1RM(top.weight || 0, top.reps || 0)),
      sets: sets.slice(),
      avgRest: avgRest(sets),
    };
  }

  // Same sets, same order — weight AND reps identical.
  const sameSets = (a, b) => a.length === b.length && a.every((s, i) =>
    (s.weight || 0) === (b[i].weight || 0) && (s.reps || 0) === (b[i].reps || 0));

  // "Time to add a little weight?" — a nudge, never a scold. Two triggers:
  //   'repeat' — the last session repeated the previous one set-for-set
  //   'target' — every set at the top weight hit the exercise's target reps
  // Both need two logged sessions of this exercise: one session is a baseline,
  // not a trend, and nudging off it just pushes the weight up before you've seen
  // how the lift actually feels.
  // Takes an exerciseHistory() series; suggests topWeight + step.
  function progressionAdvice(history, opts) {
    opts = opts || {};
    const targetReps = opts.targetReps || 10;
    const step = opts.step || 2.5;
    const n = (history || []).length;
    const base = { bump: false, reason: 'none', targetReps, step, suggestWeight: null, topWeight: null, date: null };
    if (!n) return base;

    const cur = history[n - 1];
    const prev = n > 1 ? history[n - 2] : null;
    const out = { ...base, suggestWeight: round(cur.topWeight + step), topWeight: cur.topWeight, date: cur.date };
    const atTop = cur.sets.filter(s => (s.weight || 0) === cur.topWeight);

    if (!prev) return { ...out, reason: 'baseline' };
    if (sameSets(cur.sets, prev.sets)) return { ...out, bump: true, reason: 'repeat' };
    if (atTop.length && atTop.every(s => (s.reps || 0) >= targetReps)) return { ...out, bump: true, reason: 'target' };
    return { ...out, reason: 'progressing' };
  }

  // Structured "did I beat last time?" — deltas only; the UI formats the note.
  function smallWin(prev, cur) {
    if (!prev) return { first: true, improved: false, dv: 0, dw: 0, dr: 0 };
    const dv = round(cur.volume - prev.volume);
    const dw = round(cur.topWeight - prev.topWeight);
    const dr = cur.topReps - prev.topReps;
    const improved = dw > 0 || (dw === 0 && dr > 0) || dv > 0;
    return { first: false, improved, dv, dw, dr, matched: dv === 0 && dw === 0 && dr === 0 };
  }

  // Per-session series for one exercise, each point tagged with its win vs the
  // previous session it appeared in.
  function exerciseHistory(sessions, exId) {
    const pts = sessions.slice()
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map(s => point(s, exId)).filter(Boolean);
    pts.forEach((p, i) => { p.win = smallWin(i ? pts[i - 1] : null, p); });
    return pts;
  }

  // Sets per muscle group for a given week — gauged against the ~4-set/week
  // "minimum effective dose" floor (see program.js / the review).
  function weeklySetsByMuscle(sessions, catalog, weekIdx) {
    const byId = {};
    (catalog || []).forEach(e => { byId[e.id] = e; });
    const out = { legs: 0, push: 0, pull: 0, core: 0 };
    sessions.filter(s => weekIndex(s.date) === weekIdx).forEach(s =>
      (s.entries || []).forEach(e => {
        const ex = byId[e.exerciseId];
        if (!ex) return;
        const n = (e.sets || []).length;
        (ex.muscles || []).forEach(m => { if (m in out) out[m] += n; });
      }));
    return out;
  }

  global.Stats = {
    dayNum, weekIndex, weekIndexFromDay, epley1RM,
    sessionVolume, weeklyFrequency, point, smallWin, exerciseHistory, weeklySetsByMuscle,
    restBetween, avgRest, groupSets, progressionAdvice,
    MIN_SETS_PER_MUSCLE: 4, TARGET_SETS_PER_MUSCLE: 10,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).Stats;
}
