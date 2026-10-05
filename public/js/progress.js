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
  const SES_MAX = 20;    // sessions in the browsable/deletable list
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtRest = sec => sec >= 3600
    ? `${Math.floor(sec / 3600)}h${String(Math.round((sec % 3600) / 60)).padStart(2, '0')}`
    : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  const fmtSets = (sets, u) => Stats.groupSets(sets).map(g => `${g.weight}${u} × ${g.reps.join(', ')}`).join(' · ');

  let els = {};

  // Scaled from the first session's value, not zero — a dashed line marks the
  // start, so progress reads as distance above it (dips below still show).
  function sparkline(values, color, h) {
    if (!values.length) return '';
    const w = 100, start = values[0];
    const max = Math.max(...values), min = Math.min(...values, start);
    const span = (max - min) || 1;
    const yOf = v => r1(h - ((v - min) / span) * (h - 4) - 2);
    const pts = values.map((v, i) => {
      const x = values.length === 1 ? w : (i / (values.length - 1)) * w;
      return `${r1(x)},${yOf(v)}`;
    }).join(' ');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}">` +
      `<line x1="0" x2="${w}" y1="${yOf(start)}" y2="${yOf(start)}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3" opacity="0.6" vector-effect="non-scaling-stroke"/>` +
      `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
  }

  // Weight first (the thing to watch), volume small and quiet underneath.
  function trendCharts(hist, u) {
    const w = hist.map(p => p.topWeight), v = hist.map(p => p.volume);
    const dw = r1(w[w.length - 1] - w[0]), dv = r0(v[v.length - 1] - v[0]);
    const sign = n => (n > 0 ? '+' : '') + n;
    return sparkline(w, 'var(--accent)', 40) +
      `<div class="tk-cap">top-set weight · start ${w[0]}${u}${hist.length > 1 ? ` · ${sign(dw)}${u}` : ''}</div>` +
      `<div class="spark-minor">${sparkline(v, 'var(--muted)', 16)}` +
      `<div class="tk-cap">volume · start ${r0(v[0])}${hist.length > 1 ? ` · ${sign(dv)}` : ''}</div></div>`;
  }

  function freqCard(f) {
    const dots = f.perWeek.slice(-8).map(w =>
      `<span class="wk-dot ${w.off ? 'off' : w.count >= f.aim ? 'aim' : w.count >= f.floor ? 'floor' : ''}"></span>`).join('');
    const status = f.onAim ? 'on aim ✓' : f.aboveFloor ? 'above floor — streak safe'
      : f.off ? 'sick/off week — streak safe' : 'no session yet this week';
    return '<div class="tk-card tk-wide">' +
      `<div class="tk-row"><span class="tk-big gold">${f.streak}</span><span class="tk-unit">week streak (≥${f.floor}/wk)</span></div>` +
      `<div class="tk-sub">this week <b>${f.thisWeek}</b>/${f.aim} · ${status} · ${f.totalSessions} sessions all-time</div>` +
      `<div class="wk-dots">${dots}</div>` +
      `<label class="field checkbox off-toggle"><input type="checkbox" id="offWeekToggle"${f.off ? ' checked' : ''}> sick / off this week</label>` +
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
        trendCharts(hist, u) +
        historyDetails(hist, u) + '</div>';
    }).filter(Boolean);
    els.exercises.innerHTML = blocks.length ? blocks.join('') : '';
  }

  // ---- saved-session browser (the only place stored data can be deleted) ----
  // Sessions live in DynamoDB, so both actions are real network writes: dropping
  // a whole session, or one set out of one (which becomes a full-session delete
  // when it was the last set — the backend requires at least one).
  function sessionsHtml(sessions) {
    const rows = sessions.slice().reverse().slice(0, SES_MAX).map(s => {
      const tot = Stats.sessionVolume(s);
      const names = (s.entries || []).map(e => (Catalog.get(e.exerciseId) || {}).name || e.exerciseId).join(', ');
      const body = (s.entries || []).map(e => {
        const ex = Catalog.get(e.exerciseId) || { name: e.exerciseId, unit: 'kg' };
        const u = ex.unit || 'kg';
        const rests = Stats.restBetween(e.sets);
        const sets = e.sets.map((x, i) =>
          `<li class="set-row"><span class="s-i">${i + 1}</span><span>${x.weight}${u}</span>` +
          `<span>${x.reps} reps</span><span class="s-r">${rests[i] != null ? fmtRest(rests[i]) : ''}</span>` +
          `<button class="s-x" data-del-set="${esc(s.id)}" data-ex="${esc(e.exerciseId)}" data-i="${i}" aria-label="discard set">✕</button></li>`).join('');
        return `<div class="ses-ex"><div class="tk-cap">${esc(ex.name)}</div><ul class="set-list">${sets}</ul></div>`;
      }).join('');
      return `<details class="ses"><summary>${s.date} · ${tot.sets} set${tot.sets > 1 ? 's' : ''} · ${r0(tot.volume)} vol` +
        `<span class="ses-names">${esc(names)}</span></summary>${body}` +
        `<button class="btn-ghost danger" data-del-ses="${esc(s.id)}">Discard this session</button></details>`;
    }).join('');
    const more = sessions.length > SES_MAX ? `<div class="tk-cap">showing the last ${SES_MAX} of ${sessions.length}</div>` : '';
    return '<div class="tk-card tk-wide"><div class="tk-row"><span class="tk-unit">sessions · tap one to see or discard its sets</span></div>' +
      `<div class="ses-list">${rows}</div>${more}</div>`;
  }

  function setStatus(msg, kind) { els.status.textContent = msg || ''; els.status.className = 'log-status' + (kind ? ' ' + kind : ''); }

  async function delSession(id) {
    const s = global.Sessions.all().find(x => x.id === id);
    if (!s) return;
    const tot = Stats.sessionVolume(s);
    if (!global.confirm(`Discard the whole ${s.date} session (${tot.sets} set${tot.sets > 1 ? 's' : ''})? This deletes it from the database.`)) return;
    setStatus('Discarding…');
    try { await global.Sessions.remove(id); render(); setStatus('Session discarded.', 'ok'); }
    catch (e) { setStatus((e && e.message) || 'discard failed', 'err'); }
  }

  async function delSet(id, exId, idx) {
    const s = global.Sessions.all().find(x => x.id === id);
    if (!s) return;
    // deep copy — Sessions.all() hands out the live cache objects
    const entries = (s.entries || []).map(e => ({ exerciseId: e.exerciseId, sets: e.sets.map(x => ({ ...x })) }));
    const entry = entries.find(e => e.exerciseId === exId);
    if (!entry || !entry.sets[idx]) return;
    entry.sets.splice(idx, 1);
    const left = entries.reduce((a, e) => a + e.sets.length, 0);
    if (!left) return delSession(id);   // backend needs ≥1 set: drop the session
    if (!global.confirm('Discard this set?')) return;
    setStatus('Discarding…');
    try {
      await global.Sessions.update(id, { date: s.date, entries: entries.filter(e => e.sets.length), notes: s.notes || '' });
      render(); setStatus('Set discarded.', 'ok');
    } catch (e) { setStatus((e && e.message) || 'discard failed', 'err'); }
  }

  function render() {
    const sessions = global.Sessions.all();
    if (!sessions.length) {
      els.cards.innerHTML = '<div class="tk-card tk-wide"><div class="tk-row"><span class="tk-big">0</span>' +
        '<span class="tk-unit">sessions yet</span></div>' +
        '<div class="tk-sub">Log your first session on <b>Today</b> — that\'s the whole game. 💪</div></div>';
      els.exercises.innerHTML = '';
      els.sessions.innerHTML = '';
      return;
    }
    const f = Stats.weeklyFrequency(sessions, {
      freqAim: Settings.get('freqAim'), freqFloor: Settings.get('freqFloor'), offWeeks: Settings.get('offWeeks'),
    });
    els.cards.innerHTML = freqCard(f) + muscleCard(sessions);
    renderExercises(sessions);
    els.sessions.innerHTML = sessionsHtml(sessions);
    const toggle = $('offWeekToggle');
    if (toggle) toggle.addEventListener('change', toggleOffWeek);
  }

  function toggleOffWeek() {
    const now = Math.floor(Date.now() / 86400000);
    const wk = Stats.weekIndexFromDay(now);
    const offWeeks = new Set(Settings.get('offWeeks') || []);
    if (offWeeks.has(wk)) offWeeks.delete(wk); else offWeeks.add(wk);
    Settings.set('offWeeks', Array.from(offWeeks));
    render();
  }

  global.Progress = {
    init() {
      els = { cards: $('progCards'), exercises: $('progExercises'), sessions: $('progSessions'), status: $('progStatus') };
      // delegated: the list is re-rendered wholesale after every write
      els.sessions.addEventListener('click', e => {
        const ses = e.target.closest('[data-del-ses]');
        if (ses) { delSession(ses.getAttribute('data-del-ses')); return; }
        const set = e.target.closest('[data-del-set]');
        if (set) delSet(set.getAttribute('data-del-set'), set.getAttribute('data-ex'), parseInt(set.getAttribute('data-i'), 10));
      });
    },
    onActivate() { setStatus(''); render(); },
    onDeactivate() {},
    onKey() {},
  };
})(typeof window !== 'undefined' ? window : globalThis);
