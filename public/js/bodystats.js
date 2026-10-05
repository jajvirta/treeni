/* ============================================================
 * bodystats.js — body / energy analytics (pure, no DOM, no I/O).
 * Sibling of stats.js: that file owns TRAINING analytics, this one owns the
 * fat-loss side — weight trend, rate of loss *with its uncertainty*, the
 * deficit/maintenance phase schedule, the plan corridor, habit adherence and
 * Zone 2 volume. Both are pure and unit-testable from Node via the shim below.
 *
 * A "day" is one sparse record per calendar date:
 *   { date:'yyyy-mm-dd', kg?, steps?, cardio?:[{min,avgHr?,kind}],
 *     habits?:{protein,steps,sleep}, notes? }
 *
 * Two ideas drive everything here:
 *  1. Daily weight noise (~±1 kg) dwarfs the signal (~0.2 kg/week), so a rate
 *     is meaningless without an interval. `rate()` always returns one, widened
 *     for autocorrelation, and `stallCheck()` refuses to speak before 8 weeks.
 *  2. The plan is a CORRIDOR (1-year path .. 2-year path), not a deadline. The
 *     slow edge is a success, and maintenance blocks are expected to be flat.
 *
 * Calendar primitives come from Stats so the app has ONE definition of a week.
 * ============================================================ */
(function (global, req) {
  'use strict';

  const S = global.Stats || (req && req('./stats.js'));
  const DAY = 86400000;
  const KCAL_PER_KG = 7700;        // energy density of body-mass change
  const TRANSITION_DAYS = 10;      // water/glycogen swing after a phase change
  const MIN_WEEKS_FOR_ADVICE = 8;  // below this the interval is uselessly wide
  const Z = 1.96;

  const r1 = n => Math.round(n * 10) / 10;
  const r2 = n => Math.round(n * 100) / 100;
  const r3 = n => Math.round(n * 1000) / 1000;
  // null/''/undefined are "absent", not 0 — normPlan is applied to already
  // normalised plans, so a coerced 0 would silently poison derived targets.
  const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(+v) ? null : +v);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const isoFromDay = d => new Date(d * DAY).toISOString().slice(0, 10);

  // ---- plan -----------------------------------------------------------
  // The plan is config, not data: a start, a target, the cycle lengths, and the
  // two horizons that form the corridor. `blocks` is normally empty — the
  // schedule is derived — and only gets materialised when you hand-edit a phase
  // (e.g. extend a maintenance break).
  function normPlan(plan) {
    plan = plan || {};
    return {
      planStart: plan.planStart || null,
      startKg: num(plan.startKg),
      targetKg: num(plan.targetKg),
      deficitWeeks: num(plan.deficitWeeks) || 8,
      maintWeeks: num(plan.maintWeeks) || 2,
      fastMonths: num(plan.fastMonths) || 12,
      slowMonths: num(plan.slowMonths) || 24,
      blocks: Array.isArray(plan.blocks) ? plan.blocks : [],
      gPerKg: num(plan.gPerKg) || 1.6,
      z2Aim: num(plan.z2Aim) || 3,
      z2Floor: num(plan.z2Floor) || 2,
      stepAim: num(plan.stepAim) || 11000,
      weighAim: num(plan.weighAim) || 7,
      weighFloor: num(plan.weighFloor) || 4,
      age: num(plan.age),
      hrMax: num(plan.hrMax),
    };
  }

  // ---- weigh-ins ------------------------------------------------------
  // One weight per date (last record wins), chronological, day-numbered.
  function weighins(days) {
    const byDate = {};
    (days || []).forEach(d => { if (d && d.date && num(d.kg) != null) byDate[d.date] = num(d.kg); });
    return Object.keys(byDate).sort().map(date => ({ date, day: S.dayNum(date), kg: byDate[date] }));
  }

  // Exponentially-weighted trend. Gap-tolerant: a 7-day gap moves the line as
  // seven single days would, so a missed week doesn't leave a stale flat spot.
  function trend(days, opts) {
    opts = opts || {};
    const alpha = num(opts.alpha) || 0.1;
    let ema = null, prev = null;
    return weighins(days).map(p => {
      if (ema == null) ema = p.kg;
      else {
        const a = 1 - Math.pow(1 - alpha, Math.max(1, p.day - prev));
        ema += a * (p.kg - ema);
      }
      prev = p.day;
      return { date: p.date, day: p.day, kg: p.kg, ema: r2(ema) };
    });
  }

  // ---- rate of change -------------------------------------------------
  function slice(pts, opts) {
    opts = opts || {};
    let a = -Infinity, b = Infinity;
    if (opts.from) a = S.dayNum(opts.from);
    if (opts.fromDay != null) a = opts.fromDay;
    if (opts.to) b = S.dayNum(opts.to);
    if (opts.toDay != null) b = opts.toDay;
    if (opts.lookbackDays) {
      const end = Number.isFinite(b) ? b : (pts.length ? pts[pts.length - 1].day : 0);
      a = Math.max(a, end - opts.lookbackDays + 1);
      b = end;
    }
    let out = pts.filter(p => p.day >= a && p.day <= b);
    if (opts.onlyDays) out = out.filter(p => opts.onlyDays.has(p.day));
    return out;
  }

  // Least-squares slope of weight against day, in kg/week, WITH an interval.
  // The interval is the whole point: at ~0.2 kg/week against ~1 kg of daily
  // noise, four weeks of weigh-ins cannot separate "on plan" from "flat".
  // Naive OLS understates it (daily weights are autocorrelated — water
  // retention persists for days), so the reported band is widened by the AR(1)
  // effective-sample factor.
  function rate(days, opts) {
    const pts = slice(weighins(days), opts);
    const n = pts.length;
    const base = {
      n, kgPerWeek: null, lo: null, hi: null, band: null, se: null,
      spanDays: n ? pts[n - 1].day - pts[0].day + 1 : 0,
      from: n ? pts[0].date : null, to: n ? pts[n - 1].date : null,
      sigma: null, ar1: null, losing: false, flat: false,
    };
    if (n < 4) return base;

    const xs = pts.map(p => p.day), ys = pts.map(p => p.kg);
    const mx = mean(xs), my = mean(ys);
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) * (xs[i] - mx); sxy += (xs[i] - mx) * (ys[i] - my); }
    if (!sxx) return base;

    const slope = sxy / sxx;                       // kg/day
    const intercept = my - slope * mx;
    const res = ys.map((y, i) => y - (intercept + slope * xs[i]));
    const sigma = Math.sqrt(res.reduce((a, r) => a + r * r, 0) / (n - 2));
    let cross = 0, sq = 0;
    for (let i = 1; i < n; i++) cross += res[i] * res[i - 1];
    for (let i = 0; i < n; i++) sq += res[i] * res[i];
    const ar1 = sq ? clamp(cross / sq, 0, 0.9) : 0;
    const se = (sigma / Math.sqrt(sxx)) * Math.sqrt((1 + ar1) / (1 - ar1));

    const perWeek = v => v * 7;
    const lo = perWeek(slope - Z * se), hi = perWeek(slope + Z * se);
    return {
      ...base,
      kgPerWeek: r2(perWeek(slope)), lo: r2(lo), hi: r2(hi),
      band: r2(Z * perWeek(se)), se: r3(perWeek(se)),
      sigma: r2(sigma), ar1: r2(ar1),
      losing: hi < 0,            // confidently going down
      flat: lo <= 0 && hi >= 0,  // can't tell it apart from no change
      kgNow: r2(intercept + slope * xs[n - 1]),
    };
  }

  // kcal/day equivalent of a rate of change (negative rate = deficit).
  const energy = kgPerWeek => (kgPerWeek == null ? null : Math.round(kgPerWeek * KCAL_PER_KG / 7));

  // ---- phase schedule -------------------------------------------------
  // Deficit blocks separated by planned maintenance blocks. Maintenance isn't a
  // pause in the program, it's part of it: it blunts adaptation and, mostly, it
  // is what makes an 18-month project survivable.
  function phases(plan, untilIso) {
    const p = normPlan(plan);
    if (!p.planStart) return [];
    const start = S.dayNum(p.planStart);
    const until = (untilIso ? S.dayNum(untilIso) : start) + 400;   // always know the next block
    const out = [];
    let day = start, idx = 0;

    const push = (kind, weeks) => {
      const w = Math.max(1, Math.round(weeks));
      out.push({
        index: idx++, kind, weeks: w,
        fromDay: day, toDay: day + w * 7 - 1,
        from: isoFromDay(day), to: isoFromDay(day + w * 7 - 1),
      });
      day += w * 7;
    };

    p.blocks.forEach(b => push(b.kind === 'maintenance' ? 'maintenance' : 'deficit', num(b.weeks) || 1));
    let kind = out.length ? (out[out.length - 1].kind === 'deficit' ? 'maintenance' : 'deficit') : 'deficit';
    while (day <= until) {
      push(kind, kind === 'deficit' ? p.deficitWeeks : p.maintWeeks);
      kind = kind === 'deficit' ? 'maintenance' : 'deficit';
    }
    return out;
  }

  function phaseAt(plan, iso) {
    const list = phases(plan, iso);
    const d = S.dayNum(iso);
    const cur = list.find(b => d >= b.fromDay && d <= b.toDay);
    if (!cur) return { kind: 'pre', weekOfPhase: 0, weeks: 0, next: list[0] || null };
    return {
      ...cur,
      weekOfPhase: Math.floor((d - cur.fromDay) / 7) + 1,
      dayOfPhase: d - cur.fromDay + 1,
      settled: (d - cur.fromDay) >= TRANSITION_DAYS,
      next: list[cur.index + 1] || null,
    };
  }

  // Calendar days inside deficit blocks over [fromDay, toDay].
  function deficitDays(plan, fromDay, toDay, list) {
    const blocks = list || phases(plan, isoFromDay(toDay));
    let n = 0;
    blocks.forEach(b => {
      if (b.kind !== 'deficit') return;
      const a = Math.max(b.fromDay, fromDay), z = Math.min(b.toDay, toDay);
      if (z >= a) n += z - a + 1;
    });
    return n;
  }

  // ---- the corridor ---------------------------------------------------
  // Two paths to the same target: the fast horizon and the slow one. Loss is
  // only budgeted against DEFICIT days, so maintenance blocks flatten the
  // corridor and a flat scale during one is exactly on plan.
  function planRates(plan) {
    const p = normPlan(plan);
    if (!p.planStart || p.startKg == null || p.targetKg == null) return null;
    const total = p.startKg - p.targetKg;
    const start = S.dayNum(p.planStart);
    const horizon = m => start + Math.round(m * 30.44) - 1;
    const list = phases(p, isoFromDay(horizon(Math.max(p.fastMonths, p.slowMonths))));
    const fastWeeks = deficitDays(p, start, horizon(p.fastMonths), list) / 7;
    const slowWeeks = deficitDays(p, start, horizon(p.slowMonths), list) / 7;
    return {
      total,
      fast: fastWeeks ? r2(total / fastWeeks) : null,   // kg/week while in deficit
      slow: slowWeeks ? r2(total / slowWeeks) : null,
      fastWeeks: r1(fastWeeks), slowWeeks: r1(slowWeeks),
      duty: p.deficitWeeks / (p.deficitWeeks + p.maintWeeks),
    };
  }

  // Expected weight band at one date.
  function corridor(plan, iso) {
    const p = normPlan(plan);
    const rates = planRates(p);
    if (!rates) return null;
    const start = S.dayNum(p.planStart), d = S.dayNum(iso);
    if (d < start) return { date: iso, fast: p.startKg, slow: p.startKg, deficitDays: 0 };
    const dd = deficitDays(p, start, d);
    return {
      date: iso, deficitDays: dd,
      fast: r2(p.startKg - rates.fast / 7 * dd),   // ahead-of-plan edge
      slow: r2(p.startKg - rates.slow / 7 * dd),   // behind-but-fine edge
    };
  }

  // Same thing as a series, for the chart — phases generated once.
  function corridorSeries(plan, fromIso, toIso) {
    const p = normPlan(plan);
    const rates = planRates(p);
    if (!rates) return [];
    const start = S.dayNum(p.planStart);
    const a = Math.max(start, S.dayNum(fromIso)), b = S.dayNum(toIso);
    const list = phases(p, isoFromDay(b));
    const out = [];
    for (let d = a; d <= b; d++) {
      const dd = deficitDays(p, start, d, list);
      out.push({
        date: isoFromDay(d), day: d,
        fast: r2(p.startKg - rates.fast / 7 * dd),
        slow: r2(p.startKg - rates.slow / 7 * dd),
      });
    }
    return out;
  }

  // Where the trend sits relative to the band. 'inside' and 'ahead' are both
  // wins; 'behind' is information, not a verdict.
  function corridorStatus(plan, days, iso) {
    const c = corridor(plan, iso);
    const t = trend(days);
    if (!c || !t.length) return null;
    const ema = t[t.length - 1].ema;
    const zone = ema < c.fast ? 'ahead' : ema > c.slow ? 'behind' : 'inside';
    const p = normPlan(plan);
    return {
      ema, zone, fast: c.fast, slow: c.slow,
      lost: r2(p.startKg - ema), toGo: r2(ema - p.targetKg),
      pct: p.startKg > p.targetKg ? Math.round((p.startKg - ema) / (p.startKg - p.targetKg) * 100) : null,
    };
  }

  // ---- targets --------------------------------------------------------
  // 1.6 g/kg is the plateau for training adults; computed off GOAL weight,
  // which is the convention when there's a good deal of fat mass to lose.
  function proteinTarget(plan) {
    const p = normPlan(plan);
    const base = p.targetKg != null ? p.targetKg : p.startKg;
    if (base == null) return null;
    const g = base * p.gPerKg;
    return { grams: Math.round(g / 5) * 5, gPerKg: p.gPerKg, basedOn: base, perMeal: Math.round(g / 4 / 5) * 5 };
  }

  // Zone 2 heart-rate band. Tanaka (208 − 0.7×age) beats 220−age for adults;
  // 60–70 % HRmax is the conventional Zone 2 window. Crude by nature — the
  // talk test is the cross-check — so an explicit hrMax always wins.
  function hrZone2(plan) {
    const p = normPlan(plan);
    const hrMax = p.hrMax != null ? p.hrMax : (p.age != null ? 208 - 0.7 * p.age : null);
    if (hrMax == null) return null;
    return { hrMax: Math.round(hrMax), lo: Math.round(hrMax * 0.6), hi: Math.round(hrMax * 0.7), estimated: p.hrMax == null };
  }

  // ---- showing up -----------------------------------------------------
  // Weigh-in coverage. Reported as coverage, never as a streak you can break:
  // a missed morning is a gap the trend absorbs, not a failure.
  function weighinStats(days, opts) {
    opts = opts || {};
    const p = normPlan(opts.plan);
    const pts = weighins(days);
    const now = opts.nowDay != null ? opts.nowDay : Math.floor(Date.now() / DAY);
    const logged = new Set(pts.map(p2 => p2.day));
    const since = pts.length ? pts[0].day : now;
    const cover = n => {
      const from = Math.max(since, now - n + 1);
      const of = now - from + 1;
      let hit = 0;
      for (let d = from; d <= now; d++) if (logged.has(d)) hit++;
      return { of, hit, pct: of ? Math.round(hit / of * 100) : null };
    };
    const curWeek = S.weekIndexFromDay(now);
    const perWeekMap = {};
    pts.forEach(p2 => { const w = S.weekIndexFromDay(p2.day); perWeekMap[w] = (perWeekMap[w] || 0) + 1; });
    const perWeek = [];
    for (let w = S.weekIndexFromDay(since); w <= curWeek; w++) perWeek.push({ week: w, count: perWeekMap[w] || 0 });
    return {
      total: pts.length, thisWeek: perWeekMap[curWeek] || 0,
      aim: p.weighAim, floor: p.weighFloor,
      last7: cover(7), last14: cover(14), last28: cover(28),
      perWeek, latest: pts.length ? pts[pts.length - 1] : null,
    };
  }

  const cardioOf = day => (Array.isArray(day && day.cardio) ? day.cardio : [])
    .filter(c => c && num(c.min) != null && num(c.min) > 0);

  // Zone 2 volume per week — deliberately the same shape as
  // Stats.weeklyFrequency, so the view can render it with the same card.
  function zone2Stats(days, opts) {
    opts = opts || {};
    const p = normPlan(opts.plan);
    const band = opts.band || hrZone2(p);
    const now = opts.nowDay != null ? opts.nowDay : Math.floor(Date.now() / DAY);
    const curWeek = S.weekIndexFromDay(now);
    const wk = {};
    let firstWeek = curWeek, sessions = 0, minutes = 0;
    let recent = 0, recentAbove = 0;   // last 28 days — "10 all-time" says nothing
    (days || []).forEach(d => {
      const list = cardioOf(d);
      if (!list.length || !d.date) return;
      const w = S.weekIndex(d.date);
      if (w < firstWeek) firstWeek = w;
      const fresh = S.dayNum(d.date) > now - 28 && S.dayNum(d.date) <= now;
      wk[w] = wk[w] || { count: 0, min: 0 };
      list.forEach(c => {
        wk[w].count++; wk[w].min += num(c.min);
        sessions++; minutes += num(c.min);
        if (!fresh) return;
        recent++;
        if (band && num(c.avgHr) != null && num(c.avgHr) > band.hi) recentAbove++;
      });
    });
    const perWeek = [];
    for (let w = firstWeek; w <= curWeek; w++) perWeek.push({ week: w, count: (wk[w] || {}).count || 0, min: (wk[w] || {}).min || 0 });
    // Weeks at or above the floor, counted back from now; the in-progress week
    // is skipped rather than treated as a miss.
    let streak = 0;
    let w = ((wk[curWeek] || {}).count || 0) >= p.z2Floor ? curWeek : curWeek - 1;
    for (; w >= firstWeek; w--) { if (((wk[w] || {}).count || 0) >= p.z2Floor) streak++; else break; }
    const cur = wk[curWeek] || { count: 0, min: 0 };
    return {
      thisWeek: cur.count, minutesThisWeek: cur.min,
      aim: p.z2Aim, floor: p.z2Floor,
      onAim: cur.count >= p.z2Aim, aboveFloor: cur.count >= p.z2Floor,
      streak, perWeek, totalSessions: sessions, totalMinutes: minutes,
      sessions28: recent, aboveBand28: recentAbove, band,
    };
  }

  // Steps: unlogged days are UNKNOWN, not zero — so this reports coverage
  // alongside the average instead of quietly averaging in blanks. `hit` counts
  // days at or above the aim, which is the steps equivalent of a habit tick —
  // measured, so there's nothing to self-report.
  function stepStats(days, opts) {
    opts = opts || {};
    const p = normPlan(opts.plan);
    const now = opts.nowDay != null ? opts.nowDay : Math.floor(Date.now() / DAY);
    const win = n => {
      const xs = (days || []).filter(d => d && d.date && num(d.steps) != null)
        .filter(d => S.dayNum(d.date) > now - n && S.dayNum(d.date) <= now)
        .map(d => num(d.steps));
      const hit = xs.filter(v => v >= p.stepAim).length;
      return {
        avg: xs.length ? Math.round(mean(xs)) : null, days: xs.length, of: n,
        hit, pct: Math.round(hit / n * 100),   // against calendar days, like habits
      };
    };
    const a7 = win(7), a14 = win(14), a28 = win(28);
    return { aim: p.stepAim, last7: a7, last14: a14, last28: a28, onAim: a7.avg != null && a7.avg >= p.stepAim };
  }

  // ---- habits ---------------------------------------------------------
  // Adherence is measured against CALENDAR days, not logged days: skipping the
  // check-in on a bad day would otherwise flatter the number. The comparison of
  // the last fortnight against the one before it is what makes a stall
  // actionable — "protein went 80 % → 45 %" instead of "eat less".
  function habitStats(days, keys, opts) {
    opts = opts || {};
    const now = opts.nowDay != null ? opts.nowDay : Math.floor(Date.now() / DAY);
    const byDay = {};
    (days || []).forEach(d => { if (d && d.date) byDay[S.dayNum(d.date)] = (d.habits || {}); });
    const first = Object.keys(byDay).length ? Math.min(...Object.keys(byDay).map(Number)) : now;
    const list = (keys && keys.length) ? keys : ['protein', 'steps', 'sleep'];

    const pct = (key, fromDay, toDay) => {
      const from = Math.max(first, fromDay);
      const of = toDay - from + 1;
      if (of <= 0) return { pct: null, hit: 0, of: 0 };
      let hit = 0;
      for (let d = from; d <= toDay; d++) if (byDay[d] && byDay[d][key] === true) hit++;
      return { pct: Math.round(hit / of * 100), hit, of };
    };

    const byKey = {};
    list.forEach(k => {
      const cur = pct(k, now - 13, now);
      const prev = pct(k, now - 27, now - 14);
      byKey[k] = {
        key: k, last14: cur, prev14: prev, last28: pct(k, now - 27, now),
        delta: (cur.pct != null && prev.pct != null) ? cur.pct - prev.pct : null,
      };
    });
    const rank = arr => arr.filter(Boolean).sort((a, b) => a.v - b.v)[0] || null;
    const weakest = rank(list.map(k => byKey[k].last14.pct != null ? { key: k, v: byKey[k].last14.pct } : null));
    const dropped = rank(list.map(k => byKey[k].delta != null ? { key: k, v: byKey[k].delta } : null));
    return { byKey, keys: list, weakest, dropped: dropped && dropped.v < 0 ? dropped : null };
  }

  // ---- rate during deficit blocks only --------------------------------
  // Averaging maintenance blocks into the rate makes the program look like it's
  // failing when it's working as designed. For projection and stall detection,
  // regress only settled deficit days.
  function deficitRate(days, plan, iso, opts) {
    opts = opts || {};
    const p = normPlan(plan);
    const d = S.dayNum(iso);
    const lookback = opts.lookbackDays || 112;
    const list = phases(p, iso);
    const ok = new Set();
    list.forEach(b => {
      if (b.kind !== 'deficit') return;
      for (let x = b.fromDay + TRANSITION_DAYS; x <= Math.min(b.toDay, d); x++) if (x > d - lookback) ok.add(x);
    });
    const r = rate(days, { onlyDays: ok, toDay: d });
    return { ...r, deficitDaysUsed: ok.size, lookbackDays: lookback };
  }

  // Weeks-to-target as a RANGE, from the interval — never a single date, which
  // this data can't support. Calendar weeks account for the maintenance duty
  // cycle: you only lose during the deficit blocks.
  function projection(days, plan, iso) {
    const p = normPlan(plan);
    const rates = planRates(p);
    const st = corridorStatus(p, days, iso);
    const r = deficitRate(days, p, iso);
    if (!st || !rates || r.kgPerWeek == null) return null;
    const toGo = st.toGo;
    if (toGo <= 0) return { done: true, toGo: 0 };
    // Use the confident end of the interval for the slow bound and vice versa;
    // if the band still straddles zero, we honestly can't project yet.
    const weeksFrom = kgWk => (kgWk < 0 ? toGo / -kgWk / rates.duty : null);
    const best = weeksFrom(r.lo), worst = weeksFrom(r.hi), mid = weeksFrom(r.kgPerWeek);
    const at = w => (w == null ? null : isoFromDay(S.dayNum(iso) + Math.round(w * 7)));
    return {
      done: false, toGo, rate: r,
      weeksLo: best != null ? Math.round(best) : null,
      weeksHi: worst != null ? Math.round(worst) : null,
      weeksMid: mid != null ? Math.round(mid) : null,
      dateLo: at(best), dateHi: at(worst), dateMid: at(mid),
      certain: r.losing,
    };
  }

  // ---- the one piece of advice ----------------------------------------
  // Fires only inside a deficit block, only with ≥8 weeks of settled data, and
  // only when the whole interval sits on the wrong side of the corridor's slow
  // edge. The output is a habit diff — never a calorie instruction.
  function stallCheck(days, plan, iso, opts) {
    opts = opts || {};
    const p = normPlan(plan);
    const ph = phaseAt(p, iso);
    const rates = planRates(p);
    const no = reason => ({ fire: false, reason, phase: ph });
    if (!rates) return no('no-plan');
    if (ph.kind !== 'deficit') return no('maintenance');

    const r = deficitRate(days, p, iso);
    const weeks = r.deficitDaysUsed / 7;
    if (weeks < MIN_WEEKS_FOR_ADVICE) {
      return { ...no('too-soon'), weeksOfData: r1(weeks), weeksNeeded: MIN_WEEKS_FOR_ADVICE };
    }
    if (r.n < 20 || r.kgPerWeek == null) return { ...no('not-enough-weighins'), n: r.n };

    const expected = -rates.slow;               // the slow edge, as a signed rate
    if (r.lo <= expected) return { ...no('on-plan'), rate: r, expected };

    return {
      fire: true, reason: 'stalled', phase: ph, rate: r, expected,
      weeksOfData: r1(weeks),
      habits: habitStats(days, opts.habitKeys, { nowDay: S.dayNum(iso) }),
      steps: stepStats(days, { plan: p, nowDay: S.dayNum(iso) }),
      zone2: zone2Stats(days, { plan: p, nowDay: S.dayNum(iso) }),
    };
  }

  global.BodyStats = {
    normPlan, weighins, trend, rate, slice, energy,
    phases, phaseAt, deficitDays, planRates,
    corridor, corridorSeries, corridorStatus,
    proteinTarget, hrZone2,
    weighinStats, zone2Stats, stepStats, habitStats,
    deficitRate, projection, stallCheck,
    isoFromDay,
    KCAL_PER_KG, TRANSITION_DAYS, MIN_WEEKS_FOR_ADVICE,
  };
})(typeof window !== 'undefined' ? window : globalThis,
  typeof require === 'function' ? require : null);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).BodyStats;
}
