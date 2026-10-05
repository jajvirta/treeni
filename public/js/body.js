/* ============================================================
 * body.js — the Body view: the experimental long-horizon cut.
 * Same contract as the other views: window.Body { init, onActivate,
 * onDeactivate, onKey }. All the maths lives in bodystats.js; this file only
 * formats it and writes day records through Days (app.js → Store).
 *
 * The ordering on screen is the argument: what you DID this week is the loud
 * thing, the scale is the quiet instrument underneath it. A −15 kg goal is
 * still a scale goal, so the counterweight is that the number never appears
 * without its uncertainty and never appears as a deadline.
 * ============================================================ */
(function (global) {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const r1 = n => Math.round(n * 10) / 10;
  // Real minus sign, so "−0.19 kg/week" lines up with "−5.0 kg so far".
  const signed = n => (n < 0 ? '−' + Math.abs(n) : '+' + n);
  const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const B = () => global.BodyStats;

  // Only genuinely self-reported things are checkboxes. Steps are a *measured*
  // number, so they get a gauge derived from the count instead of a daily tap
  // that could disagree with it.
  const HABITS = {
    protein: { icon: '🥩', label: 'Protein' },
    sleep: { icon: '😴', label: 'Sleep', hint: '7h+' },
  };
  const DAYS_SHOWN = 21;

  let els = {};
  let sel = null;        // the date being checked in
  let entry = '';        // weight keypad buffer
  let fresh = false;     // next digit overwrites the prefilled value

  const plan = () => global.Settings.get('plan');
  const habitKeys = () => global.Settings.get('habitKeys') || ['protein', 'steps', 'sleep'];
  const day = () => global.Days.get(sel) || { date: sel };

  function setStatus(msg, cls) {
    if (!els.status) return;
    els.status.textContent = msg || '';
    els.status.className = 'log-status' + (cls ? ' ' + cls : '');
  }

  // ---- setup ----------------------------------------------------------
  function setupHtml() {
    const p = plan() || {};
    return '<div class="setup-card"><h2>Set up the cut</h2>' +
      '<p class="hint-text">A long, deliberate one: <b>−15 kg over 1–2 years</b>. The app plans in ' +
      '<b>8-week deficit blocks separated by 2-week maintenance breaks</b>, and measures the outcome ' +
      'rather than trusting the estimate. Nothing here asks you to count calories.</p>' +
      `<label class="field">Start date<input type="date" id="pStart" value="${esc(p.planStart || today())}"></label>` +
      `<label class="field">Weight now (kg)<input type="number" id="pStartKg" step="0.1" inputmode="decimal" value="${p.startKg != null ? p.startKg : ''}"></label>` +
      `<label class="field">Target (kg)<input type="number" id="pTargetKg" step="0.1" inputmode="decimal" value="${p.targetKg != null ? p.targetKg : ''}"></label>` +
      `<label class="field">Age <span class="hint-text">— sets the Zone 2 heart-rate band</span><input type="number" id="pAge" inputmode="numeric" value="${p.age != null ? p.age : ''}"></label>` +
      `<label class="field">Max HR (optional, overrides age)<input type="number" id="pHrMax" inputmode="numeric" value="${p.hrMax != null ? p.hrMax : ''}"></label>` +
      `<label class="field">Daily step aim<input type="number" id="pSteps" step="500" inputmode="numeric" value="${p.stepAim != null ? p.stepAim : 11000}"></label>` +
      `<label class="field">Zone 2 sessions per week<input type="number" id="pZ2" min="1" max="7" value="${p.z2Aim != null ? p.z2Aim : 3}"></label>` +
      `<button class="btn-primary" id="btnPlanSave">${p.planStart ? 'Save plan' : 'Start'}</button>` +
      '</div>';
  }

  function bindSetup() {
    const kg = $('pStartKg');
    if (kg) kg.addEventListener('input', () => {
      const t = $('pTargetKg');
      if (t && !t.value && kg.value) t.value = r1(Number(kg.value) - 15);
    });
    const save = $('btnPlanSave');
    if (save) save.addEventListener('click', () => {
      const numOf = id => ($(id) && $(id).value !== '' ? Number($(id).value) : null);
      const start = $('pStart').value, startKg = numOf('pStartKg'), targetKg = numOf('pTargetKg');
      if (!start || startKg == null || targetKg == null) return setStatus('Start date, weight and target are needed.', 'err');
      if (targetKg >= startKg) return setStatus('The target has to be below your current weight.', 'err');
      const prev = plan() || {};
      global.Settings.set('plan', {
        ...prev, planStart: start, startKg, targetKg,
        age: numOf('pAge'), hrMax: numOf('pHrMax'),
        stepAim: numOf('pSteps') || 11000, z2Aim: numOf('pZ2') || 3,
        deficitWeeks: prev.deficitWeeks || 8, maintWeeks: prev.maintWeeks || 2,
        fastMonths: prev.fastMonths || 12, slowMonths: prev.slowMonths || 24,
        gPerKg: prev.gPerKg || 1.6,
      });
      setStatus('Plan saved.', 'ok');
      render();
    });
  }

  // ---- daily check-in -------------------------------------------------
  function checkinHtml() {
    const p = plan(), d = day();
    const prot = B().proteinTarget(p), band = B().hrZone2(p);

    const chips = habitKeys().map(k => {
      const h = HABITS[k] || { icon: '•', label: k };
      const hint = k === 'protein' && prot ? prot.grams + ' g' : (h.hint || '');
      const on = !!(d.habits || {})[k];
      return `<button class="habit${on ? ' on' : ''}" data-habit="${esc(k)}">` +
        `<span class="hb-ic">${h.icon}</span><span class="hb-l">${esc(h.label)}</span>` +
        (hint ? `<span class="hb-t">${esc(hint)}</span>` : '') + '</button>';
    }).join('');

    const cardio = (d.cardio || []).map((c, i) => {
      const hot = band && c.avgHr != null && c.avgHr > band.hi;
      return `<div class="z2-row${hot ? ' hot' : ''}"><span>${c.min} min</span>` +
        `<span>${c.avgHr != null ? c.avgHr + ' bpm' : '—'}</span>` +
        `<span class="z2-flag">${hot ? 'above band' : ''}</span>` +
        `<button class="s-x" data-z2="${i}" aria-label="remove">✕</button></div>`;
    }).join('');

    return '<div class="log-head"><h2>Check-in</h2>' +
      `<input type="date" id="bDate" class="date-input" value="${esc(sel)}"></div>` +
      (sel !== today() ? '<p class="hint-text">Filling in an earlier day.</p>' : '') +
      '<div class="entry-grid one">' +
      '<div class="entry-field active"><div class="ef-lbl">weight (kg)</div>' +
      `<div class="ef-val" id="bWeight">${entry || (d.kg != null ? d.kg : '—')}</div></div></div>` +
      '<div id="bodyPad" class="numpad"></div>' +
      '<div class="actions">' +
      `<button class="btn-ghost" id="bClearKg"${d.kg == null ? ' disabled' : ''}>Clear</button>` +
      '<button class="btn-primary" id="bSaveKg" disabled>Save weight</button></div>' +
      `<div class="habits">${chips}` +
      `<label class="habit steps-in">👟 steps<input type="number" id="bSteps" inputmode="numeric" step="100" value="${d.steps != null ? d.steps : ''}" placeholder="${(p.stepAim || 11000).toLocaleString('en')}"></label>` +
      '</div>' +
      '<div class="mini-grid">' +
      `<label class="field">Zone 2 min<input type="number" id="z2Min" inputmode="numeric" step="5" placeholder="45"></label>` +
      `<label class="field">avg HR<input type="number" id="z2Hr" inputmode="numeric" placeholder="${band ? band.lo + '–' + band.hi : 'bpm'}"></label>` +
      '<button class="btn-ghost" id="btnZ2">+ Zone 2</button></div>' +
      (band ? `<p class="hint-text">Zone 2 target <b>${band.lo}–${band.hi} bpm</b>${band.estimated ? ' (estimated from your age)' : ''} — conversational pace. Drifting above it makes the session harder without making it better for this.</p>` : '') +
      (cardio ? `<div class="z2-list">${cardio}</div>` : '');
  }

  // ---- showing up (the loud card) -------------------------------------
  function showingUpHtml() {
    const p = plan(), days = global.Days.all();
    const z2 = B().zone2Stats(days, { plan: p });
    const w = B().weighinStats(days, { plan: p });
    const st = B().stepStats(days, { plan: p });
    const hs = B().habitStats(days, habitKeys(), {});

    const dots = z2.perWeek.slice(-8).map(x =>
      `<span class="wk-dot ${x.count >= z2.aim ? 'aim' : x.count >= z2.floor ? 'floor' : ''}"></span>`).join('');
    const status = z2.onAim ? 'on aim ✓' : z2.aboveFloor ? 'above floor — good week' : 'none logged yet this week';

    const gaugeRow = (label, pct, arrow) =>
      `<div class="gauge-row"><span>${esc(label)}</span>` +
      `<div class="gauge-track"><div class="gauge-fill ${pct != null && pct < 60 ? 'under' : ''}" style="width:${pct || 0}%"></div></div>` +
      `<span class="gauge-val">${pct == null ? '—' : pct + '%'}${arrow || ''}</span></div>`;

    const rows = habitKeys().map(k => {
      const h = hs.byKey[k], dl = h.delta;
      return gaugeRow((HABITS[k] || {}).label || k, h.last14.pct, dl ? (dl > 0 ? ' ↑' : ' ↓') : '');
    }).join('') + gaugeRow('Steps', st.last14.pct, '');

    return '<div class="tk-card tk-wide">' +
      `<div class="tk-row"><span class="tk-big">${z2.thisWeek}</span>` +
      `<span class="tk-unit">Zone 2 sessions this week · aim ${z2.aim} · ${status}</span></div>` +
      `<div class="tk-sub">${z2.minutesThisWeek} min this week · ${z2.streak} week${z2.streak === 1 ? '' : 's'} at ${z2.floor}+ · ` +
      `weighed in <b>${w.last7.hit}/${w.last7.of}</b> of the last 7 days · ` +
      `steps ${st.last7.avg != null ? '~' + st.last7.avg.toLocaleString('en') : '—'}/day vs ${st.aim.toLocaleString('en')}` +
      (z2.aboveBand28 ? ` · <span style="color:var(--gold)">${z2.aboveBand28} of ${z2.sessions28} sessions this month ran above the HR band</span>` : '') +
      '</div>' +
      `<div class="wk-dots">${dots}</div>` +
      `<div class="gauge">${rows}</div>` +
      '<div class="tk-cap">zone 2 dots · last 8 weeks · bars = last 14 days</div></div>';
  }

  // ---- the trend chart ------------------------------------------------
  // Raw weigh-ins are drawn as faint ticks and the smoothed trend as the line,
  // because the daily number is mostly water and the trend is the signal. The
  // corridor is a band, not a target line — its slow edge is a win too.
  function chart(pts, band, targetKg) {
    if (!pts.length && !band.length) return '';
    const W = 100, H = 60;
    const xsAll = pts.map(p => p.day).concat(band.map(b => b.day));
    const ysAll = pts.map(p => p.kg).concat(band.map(b => b.fast), band.map(b => b.slow));
    const x0 = Math.min(...xsAll), x1 = Math.max(...xsAll);
    const y0 = Math.min(...ysAll) - 0.6, y1 = Math.max(...ysAll) + 0.6;
    const sx = d => ((d - x0) / ((x1 - x0) || 1)) * W;
    const sy = v => H - ((v - y0) / ((y1 - y0) || 1)) * H;

    const bandPath = band.length
      ? 'M' + band.map(b => `${r1(sx(b.day))},${r1(sy(b.fast))}`).join(' L') +
        ' L' + band.slice().reverse().map(b => `${r1(sx(b.day))},${r1(sy(b.slow))}`).join(' L') + ' Z'
      : '';
    const ticks = pts.map(p =>
      `<line x1="${r1(sx(p.day))}" y1="${r1(sy(p.kg) - 1.4)}" x2="${r1(sx(p.day))}" y2="${r1(sy(p.kg) + 1.4)}"/>`).join('');
    const line = pts.length > 1
      ? `<polyline points="${pts.map(p => `${r1(sx(p.day))},${r1(sy(p.ema))}`).join(' ')}"/>` : '';
    const tgt = (targetKg != null && targetKg >= y0 && targetKg <= y1)
      ? `<line class="bc-target" x1="0" y1="${r1(sy(targetKg))}" x2="${W}" y2="${r1(sy(targetKg))}"/>` : '';

    return `<svg class="bchart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" width="100%" height="130">` +
      (bandPath ? `<path class="bc-band" d="${bandPath}"/>` : '') + tgt +
      `<g class="bc-ticks">${ticks}</g><g class="bc-line">${line}</g></svg>`;
  }

  function trendHtml() {
    const p = plan(), days = global.Days.all();
    const t = B().trend(days);
    const st = B().corridorStatus(p, days, sel);
    const rates = B().planRates(p);
    if (!t.length) {
      return '<div class="tk-card tk-wide"><div class="tk-row"><span class="tk-unit">No weigh-ins yet</span></div>' +
        '<div class="tk-sub">Weigh yourself in the morning, after the toilet, before eating — same conditions each time. ' +
        'The single number means little; forty of them mean everything.</div></div>';
    }

    const from = B().isoFromDay(Math.min(t[0].day, global.Stats.dayNum(p.planStart)));
    const band = B().corridorSeries(p, from, sel);
    const r = B().deficitRate(days, p, sel);
    const pj = B().projection(days, p, sel);

    const zoneWord = { ahead: 'ahead of the corridor', inside: 'inside the corridor', behind: 'above the corridor' };
    let rateLine;
    if (r.kgPerWeek == null) {
      rateLine = `Not enough weigh-ins inside deficit blocks yet (${r.n}).`;
    } else {
      const kcal = B().energy(r.kgPerWeek);
      rateLine = `<b>${signed(r.kgPerWeek)} kg/week</b> ± ${r.band} over the last ` +
        `${Math.round(r.deficitDaysUsed / 7)} weeks of deficit days (≈ ${signed(kcal)} kcal/day)` +
        (r.flat ? ' — <span style="color:var(--gold)">the band still includes zero, so this is not yet distinguishable from flat</span>' : '');
    }

    const proj = pj && !pj.done && pj.certain && pj.weeksLo != null
      ? `<div class="tk-sub">At this rate, target around <b>${pj.dateLo}</b> – <b>${pj.dateHi}</b>. A range, because that is genuinely all the data supports.</div>`
      : '<div class="tk-sub">No projection yet — the measured rate has to be clearly below zero first.</div>';

    const f1 = n => n.toFixed(1);
    return '<div class="tk-card tk-wide">' +
      `<div class="tk-row"><span class="tk-big">${f1(st.ema)}</span><span class="tk-unit">kg trend · ` +
      `${st.lost >= 0 ? '−' + f1(st.lost) : '+' + f1(-st.lost)} kg so far · ${f1(Math.max(0, st.toGo))} kg to go</span></div>` +
      `<div class="tk-sub">${zoneWord[st.zone]} (${f1(st.fast)}–${f1(st.slow)} kg expected today) · ${rateLine}</div>` +
      chart(t, band, p.targetKg) +
      '<div class="tk-cap">green band = the 1-year .. 2-year corridor · ticks = daily weights · line = trend</div>' +
      proj +
      `<p class="hint-text">Plan: ${rates.fast} kg/week (1 year) to ${rates.slow} kg/week (2 years) while in a deficit block ` +
      `— a deficit of roughly ${B().energy(rates.slow)}–${B().energy(rates.fast)} kcal/day. The ± above is optimistic: daily ` +
      'weights are correlated, so treat anything under 8 weeks as noise.</p>' +
      '</div>';
  }

  // ---- phase + the one nudge ------------------------------------------
  function phaseHtml() {
    const p = plan();
    const ph = B().phaseAt(p, sel);
    if (ph.kind === 'pre') return `<div class="phase-strip"><span class="ph-kind">Not started</span> plan begins ${esc(p.planStart)}</div>`;
    const next = ph.next ? `next: ${ph.next.kind} for ${ph.next.weeks} wk from ${ph.next.from}` : '';
    return `<div class="phase-strip"><span class="ph-kind ${ph.kind}">${ph.kind === 'deficit' ? 'Deficit' : 'Maintenance'}</span>` +
      `<span>week ${ph.weekOfPhase} of ${ph.weeks} · ${next}</span>` +
      (ph.kind === 'maintenance' ? '<button class="btn-ghost" id="btnExtend">+1 week</button>' : '') +
      '</div>' +
      (ph.kind === 'maintenance'
        ? '<p class="hint-text">Maintenance block: eat at maintenance, keep lifting and keep Zone 2. The scale is <b>supposed</b> to be flat here — the corridor is flat too, so this is not lost time.</p>'
        : '');
  }

  function stallHtml() {
    const p = plan();
    const sc = B().stallCheck(global.Days.all(), p, sel, { habitKeys: habitKeys() });
    if (sc.reason === 'too-soon') {
      return `<p class="hint-text">${sc.weeksOfData} of ${sc.weeksNeeded} weeks of deficit data. ` +
        'Below 8 weeks the interval on the rate is wider than the effect, so the app has nothing honest to say yet.</p>';
    }
    if (!sc.fire) return '';
    const worst = sc.habits.dropped || sc.habits.weakest;
    const h = worst ? sc.habits.byKey[worst.key] : null;
    const name = worst ? ((HABITS[worst.key] || {}).label || worst.key) : '';
    const detail = h
      ? `${esc(name)} is at <b>${h.last14.pct}%</b> over the last two weeks` +
        (h.delta != null && h.delta < 0 ? ` (down from ${h.prev14.pct}%)` : '')
      : 'no habit stands out';
    const steps = sc.steps.last28.avg != null && sc.steps.last7.avg != null && sc.steps.last7.avg < sc.steps.last28.avg - 500
      ? ` Steps are also down: ~${sc.steps.last7.avg.toLocaleString('en')}/day this week against ~${sc.steps.last28.avg.toLocaleString('en')} over the month.`
      : '';
    return '<div class="advice-note">📉 Eight weeks in and the trend is above the corridor — ' +
      `measured ${signed(sc.rate.kgPerWeek)} kg/week where the slow path wants ${signed(r1(sc.expected))}. ${detail}.${steps} ` +
      'Worth restoring before changing anything else.</div>';
  }

  // ---- the log --------------------------------------------------------
  function recentHtml() {
    const days = global.Days.all().slice().reverse().slice(0, DAYS_SHOWN);
    if (!days.length) return '';
    const rows = days.map(d => {
      const hb = habitKeys().filter(k => (d.habits || {})[k]).map(k => (HABITS[k] || {}).icon || '•').join('');
      const z2 = (d.cardio || []).reduce((a, c) => a + (c.min || 0), 0);
      return '<div class="hist-row"><span class="h-date">' + esc(d.date) + (d.pending ? ' ⧗' : '') + '</span>' +
        `<span class="h-sets">${d.kg != null ? d.kg + ' kg' : '—'}</span>` +
        `<span class="h-meta">${d.steps != null ? d.steps.toLocaleString('en') + ' steps' : 'steps —'}` +
        `${z2 ? ' · zone 2 ' + z2 + ' min' : ''}${hb ? ' · ' + hb : ''}</span>` +
        `<button class="c-x" data-del="${esc(d.date)}" aria-label="delete day">✕</button></div>`;
    }).join('');
    return `<details class="hist"><summary>Day log · last ${days.length} day(s)</summary>${rows}</details>`;
  }

  function planSettingsHtml() {
    return '<details class="guide"><summary>Plan settings</summary>' + setupHtml() + '</details>';
  }

  // ---- render + bind --------------------------------------------------
  function render() {
    const p = plan();
    if (!p || !p.planStart || p.startKg == null) {
      els.body.innerHTML = setupHtml();
      bindSetup();
      return;
    }
    entry = '';
    fresh = true;
    els.body.innerHTML = [
      checkinHtml(), phaseHtml(), stallHtml(), showingUpHtml(), trendHtml(), recentHtml(), planSettingsHtml(),
    ].join('');
    bind();
    bindSetup();
  }

  function bindPad() {
    const pad = $('bodyPad');
    if (!pad) return;
    global.Numpad.init(pad);
    global.Numpad.setHandlers({ digit: onDigit, backspace: onBackspace, enter: saveWeight });
    syncEntry();
  }

  function syncEntry() {
    const d = day();
    const val = entry !== '' ? entry : (d.kg != null ? String(d.kg) : '');
    if ($('bWeight')) $('bWeight').textContent = val || '—';
    const n = Number(entry);
    const valid = entry !== '' && Number.isFinite(n) && n >= 30 && n <= 400;
    if ($('bSaveKg')) $('bSaveKg').disabled = !valid;
    global.Numpad.setEnter('Save', valid);
    global.Numpad.setEnabled('.', entry.indexOf('.') < 0);
  }

  function onDigit(k) {
    if (fresh) { entry = ''; fresh = false; }
    if (k === '.' && entry.indexOf('.') >= 0) return;
    if (entry.length >= 5) return;
    entry += k;
    syncEntry();
  }
  function onBackspace() {
    if (fresh) { entry = ''; fresh = false; }
    entry = entry.slice(0, -1);
    syncEntry();
  }

  async function write(patch, okMsg) {
    try {
      await global.Days.put(sel, patch);
      setStatus(okMsg || 'Saved.', 'ok');
    } catch (e) {
      setStatus('Saved on this device — will sync when the backend is reachable.', 'err');
    }
    render();
  }

  function saveWeight() {
    const n = Number(entry);
    if (!Number.isFinite(n) || n < 30 || n > 400) return;
    write({ kg: r1(n) }, `${r1(n)} kg logged for ${sel}.`);
  }

  function bind() {
    bindPad();

    $('bDate').addEventListener('change', e => { sel = e.target.value || today(); render(); });
    $('bSaveKg').addEventListener('click', saveWeight);
    $('bClearKg').addEventListener('click', () => write({ kg: null }, 'Weigh-in cleared.'));

    els.body.querySelectorAll('.habit').forEach(btn => btn.addEventListener('click', () => {
      const k = btn.getAttribute('data-habit');
      write({ habits: { [k]: !(day().habits || {})[k] } }, '');
    }));

    $('bSteps').addEventListener('change', e => {
      const v = e.target.value === '' ? null : Math.round(Number(e.target.value));
      write({ steps: v != null && v >= 0 && v <= 100000 ? v : null }, 'Steps saved.');
    });

    $('btnZ2').addEventListener('click', () => {
      const min = Math.round(Number($('z2Min').value));
      const hr = $('z2Hr').value === '' ? null : Math.round(Number($('z2Hr').value));
      if (!Number.isFinite(min) || min <= 0) return setStatus('Minutes?', 'err');
      const c = { min, kind: 'zone2' };
      if (hr != null && hr >= 40 && hr <= 220) c.avgHr = hr;
      write({ cardio: (day().cardio || []).concat([c]) }, `Zone 2 ${min} min logged.`);
    });

    els.body.querySelectorAll('[data-z2]').forEach(btn => btn.addEventListener('click', () => {
      const i = Number(btn.getAttribute('data-z2'));
      write({ cardio: (day().cardio || []).filter((_, j) => j !== i) }, 'Removed.');
    }));

    const ext = $('btnExtend');
    if (ext) ext.addEventListener('click', () => {
      const p = plan();
      const cur = B().phaseAt(p, sel);
      const blocks = B().phases(p, sel).filter(b => b.index <= cur.index).map(b => ({ kind: b.kind, weeks: b.weeks }));
      blocks[blocks.length - 1].weeks += 1;
      global.Settings.set('plan', { ...p, blocks });
      setStatus('Maintenance extended by a week.', 'ok');
      render();
    });

    els.body.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async () => {
      const date = btn.getAttribute('data-del');
      if (!global.confirm(`Delete everything logged on ${date}?`)) return;
      try { await global.Days.remove(date); setStatus('Deleted.', 'ok'); }
      catch (e) { setStatus(e.message || 'Delete failed.', 'err'); }
      render();
    }));
  }

  // ---- controller -----------------------------------------------------
  function onKey(e) {
    if (!$('bodyPad')) return;
    if (e.key >= '0' && e.key <= '9') { global.Numpad.pressDigit(e.key); e.preventDefault(); }
    else if (e.key === '.' || e.key === ',') { global.Numpad.pressDigit('.'); e.preventDefault(); }
    else if (e.key === 'Backspace') { global.Numpad.pressBackspace(); e.preventDefault(); }
    else if (e.key === 'Enter') { global.Numpad.pressEnter(); e.preventDefault(); }
  }

  global.Body = {
    init() {
      els = { body: $('bodyBody'), status: $('bodyStatus') };
    },
    onActivate() {
      sel = sel || today();
      setStatus('');
      render();
    },
    onDeactivate() {},
    onKey,
  };
})(typeof window !== 'undefined' ? window : globalThis);
