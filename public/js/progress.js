/* ============================================================
 * progress.js — the Progress view. Frequency & streak are the headline
 * (the app is about showing up); per-exercise trends and small wins below.
 * Exposes window.Progress { init, onActivate, onDeactivate, onKey }.
 * ============================================================ */
(function (global) {
  'use strict';

  const $ = id => document.getElementById(id);
  const r0 = n => Math.round(n);
  const r1 = n => (Math.round(n * 10) / 10);
  const HIST_MAX = 12;   // sessions listed per exercise before "+N earlier"
  const fmtRest = sec => sec >= 3600
    ? `${Math.floor(sec / 3600)}h${String(Math.round((sec % 3600) / 60)).padStart(2, '0')}`
    : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  const fmtSets = (sets, u) => Stats.groupSets(sets).map(g => `${g.weight}${u} × ${g.reps.join(', ')}`).join(' · ');

  let els = {};

  function sparkline(values, color) {
    if (!values.length) return '';
    const w = 100, h = 26, max = Math.max(...values, 1), min = Math.min(...values, 0);
    const span = (max - min) || 1;
    const pts = values.map((v, i) => {
      const x = values.length === 1 ? w : (i / (values.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 4) - 2;
      return `${r1(x)},${r1(y)}`;
    }).join(' ');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="26">` +
      `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
  }

  function freqCard(f) {
    const dots = f.perWeek.slice(-8).map(w =>
      `<span class="wk-dot ${w.count >= f.aim ? 'aim' : w.count >= f.floor ? 'floor' : ''}"></span>`).join('');
    const status = f.onAim ? 'on aim ✓' : f.aboveFloor ? 'above floor — streak safe' : 'no session yet this week';
    return '<div class="tk-card tk-wide">' +
      `<div class="tk-row"><span class="tk-big gold">${f.streak}</span><span class="tk-unit">week streak (≥${f.floor}/wk)</span></div>` +
      `<div class="tk-sub">this week <b>${f.thisWeek}</b>/${f.aim} · ${status} · ${f.totalSessions} sessions all-time</div>` +
      `<div class="wk-dots">${dots}</div>` +
      '<div class="tk-cap">weekly frequency · last 8 weeks</div></div>';
  }

  function muscleCard(sessions) {
    const now = Math.floor(Date.now() / 86400000);
    const wk = Stats.weekIndexFromDay(now);
    const m = Stats.weeklySetsByMuscle(sessions, Catalog.all(), wk);
    const floor = Stats.MIN_SETS_PER_MUSCLE, target = Stats.TARGET_SETS_PER_MUSCLE;
    const rows = ['legs', 'push', 'pull', 'core'].map(g => {
      const n = m[g] || 0;
      const pct = Math.min(100, n / target * 100);
      return `<div class="gauge-row"><span>${g}</span>` +
        `<div class="gauge-track"><div class="gauge-fill ${n < floor ? 'under' : ''}" style="width:${pct}%"></div></div>` +
        `<span class="gauge-val">${n}/${floor}+</span></div>`;
    }).join('');
    return '<div class="tk-card tk-wide">' +
      '<div class="tk-row"><span class="tk-unit">this week · sets per muscle vs the ~4-set minimum</span></div>' +
      `<div class="gauge">${rows}</div>` +
      '<div class="tk-cap">gold = below the minimum effective dose</div></div>';
  }

  // Every set of every session, newest first — "was bench 48kg × 10,10,9,6 last
  // time?" is the question this answers. Collapsed by default.
  function historyDetails(hist, u) {
    const rows = hist.slice().reverse().slice(0, HIST_MAX).map(p =>
      '<div class="hist-row">' +
      `<span class="h-date">${p.date}</span>` +
      `<span class="h-sets">${fmtSets(p.sets, u)}</span>` +
      `<span class="h-meta">${p.setCount} set${p.setCount > 1 ? 's' : ''}` +
      `${p.avgRest != null ? ' · rest ~' + fmtRest(p.avgRest) : ''} · ${r0(p.volume)} vol</span>` +
      '</div>').join('');
    const more = hist.length > HIST_MAX ? `<div class="tk-cap">+${hist.length - HIST_MAX} earlier session(s)</div>` : '';
    return `<details class="hist"><summary>All sets · ${hist.length} session${hist.length > 1 ? 's' : ''}</summary>${rows}${more}</details>`;
  }

  function renderExercises(sessions) {
    const blocks = Catalog.all().map(ex => {
      const hist = Stats.exerciseHistory(sessions, ex.id);
      if (!hist.length) return '';
      const u = ex.unit || 'kg';
      const last = hist[hist.length - 1];
      const win = last.win || {};
      let note = '';
      if (win.first) note = 'first session logged';
      else if (win.dw > 0) note = `+${win.dw}${u} on top set`;
      else if (win.dw === 0 && win.dr > 0) note = `+${win.dr} rep${win.dr > 1 ? 's' : ''} on top set`;
      else if (win.dv > 0) note = `+${r0(win.dv)} volume`;
      else if (win.matched) note = 'matched last time';
      const best = hist.reduce((b, p) => p.e1rm > b ? p.e1rm : b, 0);
      const adv = Stats.progressionAdvice(hist, { targetReps: Catalog.target(ex.id), step: Catalog.step(ex.id) });
      const bump = adv.bump
        ? `<div class="advice-note">⬆ ${adv.reason === 'repeat' ? 'Same sets as the session before' : `${adv.targetReps} reps on every set`}` +
          ` — try <b>${adv.suggestWeight}${u}</b> next time.</div>`
        : '';
      return '<div class="tk-card tk-wide">' +
        `<div class="tk-row"><span class="tk-big">${last.topWeight}${u}</span><span class="tk-unit">× ${last.topReps} top set · ${hist.length} session${hist.length > 1 ? 's' : ''}</span></div>` +
        `<div class="tk-sub"><b>${ex.name}</b> · ${note ? '<span style="color:var(--gold)">' + note + '</span> · ' : ''}target ${adv.targetReps} reps · est. 1RM ~${r0(best)}${u}</div>` +
        bump +
        sparkline(hist.map(p => p.volume), 'var(--accent)') +
        '<div class="tk-cap">session volume (weight × reps)</div>' +
        historyDetails(hist, u) + '</div>';
    }).filter(Boolean);
    els.exercises.innerHTML = blocks.length ? blocks.join('') : '';
  }

  function render() {
    const sessions = global.Sessions.all();
    if (!sessions.length) {
      els.cards.innerHTML = '<div class="tk-card tk-wide"><div class="tk-row"><span class="tk-big">0</span>' +
        '<span class="tk-unit">sessions yet</span></div>' +
        '<div class="tk-sub">Log your first session on <b>Today</b> — that\'s the whole game. 💪</div></div>';
      els.exercises.innerHTML = '';
      return;
    }
    const f = Stats.weeklyFrequency(sessions, { freqAim: Settings.get('freqAim'), freqFloor: Settings.get('freqFloor') });
    els.cards.innerHTML = freqCard(f) + muscleCard(sessions);
    renderExercises(sessions);
  }

  global.Progress = {
    init() { els = { cards: $('progCards'), exercises: $('progExercises') }; },
    onActivate() { render(); },
    onDeactivate() {},
    onKey() {},
  };
})(typeof window !== 'undefined' ? window : globalThis);
