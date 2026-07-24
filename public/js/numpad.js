/* ============================================================
 * numpad.js — shared on-screen numeric keypad
 * Primary input on every device; the hardware keyboard mirrors it
 * (app.js routes key events through the same press* functions).
 * Exposes window.Numpad.
 * ============================================================ */
(function (global) {
  'use strict';

  let container = null;
  let enterBtn = null;
  const handlers = { digit: null, backspace: null, enter: null };

  const LAYOUT = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['back', '0', 'enter'],
  ];

  function haptic() {
    if (global.navigator && typeof global.navigator.vibrate === 'function') {
      try { global.navigator.vibrate(8); } catch (e) { /* ignore */ }
    }
  }

  function makeKey(key) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'np-key';
    if (key === 'back') {
      btn.classList.add('np-back');
      btn.dataset.key = 'back';
      btn.innerHTML = '&#9003;'; // ⌫
      btn.setAttribute('aria-label', 'Backspace');
    } else if (key === 'enter') {
      btn.classList.add('np-enter');
      btn.dataset.key = 'enter';
      btn.textContent = 'OK';
      enterBtn = btn;
    } else {
      btn.classList.add('np-digit');
      btn.dataset.key = key;
      btn.textContent = key;
    }
    // pointerdown for snappy, no-300ms response; prevent default to avoid
    // synthetic click / focus churn / text selection.
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      press(key);
    });
    return btn;
  }

  function press(key) {
    haptic();
    if (key === 'back') { if (handlers.backspace) handlers.backspace(); }
    else if (key === 'enter') { if (!enterBtn.disabled && handlers.enter) handlers.enter(); }
    else { if (handlers.digit) handlers.digit(key); }
  }

  function init(el) {
    container = el;
    container.innerHTML = '';
    container.classList.add('numpad');
    LAYOUT.forEach(row => {
      const rowEl = document.createElement('div');
      rowEl.className = 'np-row';
      row.forEach(key => rowEl.appendChild(makeKey(key)));
      container.appendChild(rowEl);
    });
  }

  function setHandlers(h) {
    handlers.digit = h.digit || null;
    handlers.backspace = h.backspace || null;
    handlers.enter = h.enter || null;
  }

  function setEnter(label, enabled) {
    if (!enterBtn) return;
    if (typeof label === 'string') enterBtn.textContent = label;
    enterBtn.disabled = enabled === false;
  }

  // Programmatic presses so the hardware keyboard can drive the same path.
  function pressDigit(d) { if (handlers.digit) { haptic(); handlers.digit(d); } }
  function pressBackspace() { if (handlers.backspace) { haptic(); handlers.backspace(); } }
  function pressEnter() { if (enterBtn && !enterBtn.disabled && handlers.enter) { haptic(); handlers.enter(); } }

  global.Numpad = { init, setHandlers, setEnter, pressDigit, pressBackspace, pressEnter };
})(typeof window !== 'undefined' ? window : globalThis);
