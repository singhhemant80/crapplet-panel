/* Crapplet — floating "Chat on WhatsApp" button (bottom-right on every page).
 * Opens a chat with our support number, with a short message about the page the visitor is on.
 * To change the number, edit NUMBER below (country code + number, digits only). */
(function () {
  'use strict';
  var NUMBER = '919039573607';
  if (window.__crappletWa || document.getElementById('cwa-fab')) return;
  window.__crappletWa = true;

  function pageName() {
    var t = (document.title || '').split(/[|\-–—]/)[0].trim();
    return t && !/^crapplet/i.test(t) ? t : '';
  }
  function link() {
    var p = pageName();
    var msg = 'Hi Crapplet Cloud! ' + (p ? 'I have a question about ' + p + '.' : 'I have a question.');
    return 'https://wa.me/' + NUMBER + '?text=' + encodeURIComponent(msg);
  }

  var css = '' +
    '#cwa-fab{position:fixed;right:20px;bottom:20px;z-index:45;display:flex;align-items:center;gap:10px;text-decoration:none;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-tap-highlight-color:transparent}' +
    '#cwa-fab .cwa-btn{position:relative;display:grid;place-items:center;width:58px;height:58px;border-radius:50%;background:linear-gradient(145deg,#2fe474,#1ebe5b 55%,#128c4b);box-shadow:0 10px 28px -6px rgba(18,140,75,.55),0 2px 6px rgba(0,0,0,.12),inset 0 1px 0 rgba(255,255,255,.35);transition:transform .2s cubic-bezier(.22,1,.36,1),box-shadow .2s}' +
    '#cwa-fab .cwa-btn:before{content:"";position:absolute;inset:0;border-radius:50%;background:#25d366;opacity:.45;animation:cwa-ping 2.4s cubic-bezier(0,0,.2,1) infinite;z-index:-1}' +
    '#cwa-fab svg{width:31px;height:31px;fill:#fff;filter:drop-shadow(0 1px 1px rgba(0,0,0,.15))}' +
    '#cwa-fab .cwa-label{order:-1;max-width:0;overflow:hidden;white-space:nowrap;opacity:0;padding:0;border-radius:999px;background:#fff;color:#0f172a;font-size:14px;font-weight:700;line-height:1;box-shadow:0 8px 24px -8px rgba(15,23,42,.3),0 0 0 1px rgba(15,23,42,.06);transition:max-width .35s cubic-bezier(.22,1,.36,1),opacity .25s,padding .35s}' +
    '#cwa-fab .cwa-label small{display:block;margin-top:4px;font-size:11.5px;font-weight:600;color:#16a34a}' +
    '#cwa-fab:hover .cwa-btn,#cwa-fab:focus-visible .cwa-btn{transform:translateY(-2px) scale(1.04);box-shadow:0 14px 32px -6px rgba(18,140,75,.6),0 2px 6px rgba(0,0,0,.12)}' +
    '#cwa-fab:hover .cwa-label,#cwa-fab:focus-visible .cwa-label,#cwa-fab.cwa-hello .cwa-label{max-width:220px;opacity:1;padding:11px 16px}' +
    '#cwa-fab:focus{outline:none}#cwa-fab:focus-visible .cwa-btn{outline:3px solid #a7f3d0;outline-offset:3px}' +
    '@keyframes cwa-ping{0%{transform:scale(1);opacity:.45}75%,100%{transform:scale(1.55);opacity:0}}' +
    '@media (max-width:640px){#cwa-fab{right:14px;bottom:14px}#cwa-fab .cwa-btn{width:54px;height:54px}#cwa-fab svg{width:29px;height:29px}}' +
    '@media (prefers-reduced-motion:reduce){#cwa-fab .cwa-btn:before{animation:none}#cwa-fab *{transition:none!important}}' +
    '@media print{#cwa-fab{display:none}}';

  var ICON = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16.04 3C8.86 3 3.02 8.83 3.02 16c0 2.3.6 4.53 1.74 6.5L3 29l6.68-1.74A13 13 0 0 0 16.04 29C23.2 29 29 23.17 29 16S23.2 3 16.04 3Zm0 23.8c-2 0-3.95-.54-5.65-1.55l-.4-.24-3.97 1.04 1.06-3.86-.26-.4A10.76 10.76 0 0 1 5.2 16c0-5.97 4.86-10.82 10.84-10.82 5.96 0 10.8 4.85 10.8 10.82 0 5.96-4.84 10.8-10.8 10.8Zm5.93-8.1c-.33-.16-1.93-.95-2.23-1.06-.3-.1-.52-.16-.73.17-.22.32-.84 1.05-1.03 1.27-.19.22-.38.24-.7.08-.33-.16-1.38-.5-2.62-1.6-.97-.86-1.62-1.93-1.81-2.25-.19-.33-.02-.5.14-.66.15-.15.33-.38.49-.57.16-.19.22-.33.33-.54.1-.22.05-.41-.03-.57-.08-.16-.73-1.76-1-2.41-.27-.63-.54-.55-.73-.56h-.62c-.22 0-.57.08-.87.41-.3.32-1.14 1.11-1.14 2.71s1.17 3.15 1.33 3.36c.16.22 2.3 3.5 5.56 4.91.78.34 1.39.54 1.86.69.78.25 1.5.21 2.06.13.63-.1 1.93-.79 2.2-1.55.27-.76.27-1.41.19-1.55-.08-.13-.3-.21-.62-.37Z"/></svg>';

  function mount() {
    if (document.getElementById('cwa-fab')) return;
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
    var a = document.createElement('a');
    a.id = 'cwa-fab';
    a.href = link();
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.setAttribute('aria-label', 'Chat with Crapplet Cloud on WhatsApp');
    a.innerHTML = '<span class="cwa-label">Chat with us<small>Usually replies in minutes</small></span><span class="cwa-btn">' + ICON + '</span>';
    a.addEventListener('mouseenter', function () { a.href = link(); });
    a.addEventListener('focus', function () { a.href = link(); });
    document.body.appendChild(a);
    // say hello once per visit on wide screens, then tuck the label away
    try {
      if (window.matchMedia('(min-width: 900px)').matches && !sessionStorage.getItem('cwa-hello')) {
        sessionStorage.setItem('cwa-hello', '1');
        setTimeout(function () { a.classList.add('cwa-hello'); setTimeout(function () { a.classList.remove('cwa-hello'); }, 4500); }, 2500);
      }
    } catch (e) { /* storage blocked — skip the hello */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
