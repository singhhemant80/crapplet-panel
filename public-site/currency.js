/*!
 * Crapplet — INR / USD currency toggle (shared by every page)
 *
 * HOW IT WORKS
 *  - Any element with class "price-amount" is a price.
 *      data-inr="1299"  → price is set in rupees; USD is calculated.
 *      data-usd="12.99" → price is set in dollars; INR is calculated.
 *    (If both are present, both are used as-is.)
 *  - Any button with data-currency="INR" or data-currency="USD" switches currency.
 *  - The visitor's choice is remembered across pages.
 *
 * To change the exchange rate, edit USD_TO_INR below. Nothing else needs to change.
 */
(function () {
  'use strict';

  var USD_TO_INR = 95;          // 1 US Dollar = ₹95  (update when the rate moves)
  var STORAGE_KEY = 'crapplet_currency';
  var DEFAULT_CURRENCY = 'INR';

  /* ---------- styles for the toggle (works on every page) ---------- */
  var css = '' +
    '.cur-toggle{display:inline-flex;align-items:center;height:36px;padding:4px;border-radius:9999px;background:#f1f5f9;font-size:11px;font-weight:800;line-height:1;letter-spacing:.02em;flex-shrink:0}' +
    '.cur-toggle .cur-btn{display:inline-flex;align-items:center;justify-content:center;gap:3px;height:100%;padding:0 12px;border:0;border-radius:9999px;background:transparent;color:#475569;cursor:pointer;font:inherit;transition:background .2s,color .2s}' +
    '.cur-toggle .cur-btn:hover{color:#a365fe}' +
    '.cur-toggle .cur-btn.is-active{background:#a365fe;color:#fff;box-shadow:0 2px 8px rgba(163,101,254,.35)}' +
    '.cur-toggle--dark{background:rgba(0,0,0,.25)}' +
    '.cur-toggle--dark .cur-btn{color:rgba(255,255,255,.6)}' +
    '.cur-toggle--dark .cur-btn:hover{color:#fff}' +
    '.cur-row{margin:16px 24px;display:flex;align-items:center;justify-content:space-between;border-radius:16px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);padding:6px}' +
    '.cur-row-label{padding-left:12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:rgba(255,255,255,.4)}' +
    '@media (max-width:767px){.cur-toggle--desktop{display:none!important}}';
  var style = document.createElement('style');
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  /* ---------- helpers ---------- */
  function num(v) {
    if (v == null || v === '') return null;
    var n = parseFloat(String(v).replace(/,/g, ''));
    return isNaN(n) ? null : n;
  }
  function fmtINR(n) {
    // Indian digit grouping: 1,42,848
    var whole = Math.round(n);
    return whole.toLocaleString('en-IN');
  }
  function fmtUSD(n) {
    var opts = n >= 100 && Math.round(n) === n
      ? { maximumFractionDigits: 0 }
      : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
    return n.toLocaleString('en-US', opts);
  }

  function getCurrency() {
    try { return localStorage.getItem(STORAGE_KEY) || DEFAULT_CURRENCY; }
    catch (e) { return DEFAULT_CURRENCY; }
  }

  function priceText(el, cur) {
    var inr = el.getAttribute('data-inr');
    var usd = el.getAttribute('data-usd');
    if (cur === 'USD') {
      if (usd) return '$' + usd;                       // set by hand → show exactly
      var i = num(inr); if (i == null) return null;
      return '$' + fmtUSD(i / USD_TO_INR);
    }
    if (inr) return '₹' + inr;                     // set by hand → show exactly
    var u = num(usd); if (u == null) return null;
    return '₹' + fmtINR(u * USD_TO_INR);
  }

  function apply(cur) {
    cur = cur === 'USD' ? 'USD' : 'INR';
    var els = document.querySelectorAll('.price-amount');
    for (var i = 0; i < els.length; i++) {
      var t = priceText(els[i], cur);
      if (t != null) els[i].textContent = t;
    }
    var btns = document.querySelectorAll('button[data-currency]');
    for (var j = 0; j < btns.length; j++) {
      var on = btns[j].getAttribute('data-currency') === cur;
      btns[j].classList.toggle('is-active', on);
      btns[j].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    document.documentElement.setAttribute('data-active-currency', cur);
  }

  function setCurrency(cur) {
    try { localStorage.setItem(STORAGE_KEY, cur); } catch (e) {}
    apply(cur);
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button[data-currency]');
    if (!b) return;
    e.preventDefault();
    setCurrency(b.getAttribute('data-currency'));
  });

  // Public API (used by pages that change prices dynamically, e.g. GPU hourly/monthly)
  window.CrappletCurrency = {
    rate: USD_TO_INR,
    get: getCurrency,
    set: setCurrency,
    refresh: function () { apply(getCurrency()); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { apply(getCurrency()); });
  } else {
    apply(getCurrency());
  }
})();
