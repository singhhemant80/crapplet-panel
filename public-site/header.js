/* Crapplet site header — dropdowns, search, scroll state, mobile fallback.
 * Safe to run many times: the panel (Next.js) re-renders the header markup on every client-side
 * navigation, so window.crappletHeaderInit() binds each fresh <header> once, and the document-level
 * listeners are installed only once and always act on the header that is currently on the page. */
(function () {
  'use strict';
  var live = {};

  function bind(hdr) {

    /* ── scroll: collapse top strip, add shadow ── */
    var ticking = false;
    function onScroll() {
      hdr.classList.toggle('chdr-scrolled', window.scrollY > 40);
      ticking = false;
    }
    live.onScroll = function () { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } };
    onScroll();

    /* ── mega menus: hover on desktop pointer, click/tap + keyboard everywhere ── */
    var items = hdr.querySelectorAll('.chdr-item[data-menu]');
    var closeTimer = null;
    function closeAll(except) {
      items.forEach(function (it) {
        if (it !== except) { it.classList.remove('open'); var b = it.querySelector('.chdr-link'); b && b.setAttribute('aria-expanded', 'false'); }
      });
    }
    function openItem(it) {
      clearTimeout(closeTimer); closeAll(it);
      it.classList.add('open'); it.querySelector('.chdr-link').setAttribute('aria-expanded', 'true');
    }
    var finePointer = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    items.forEach(function (it) {
      var btn = it.querySelector('.chdr-link');
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        // with a mouse the menu is already open from hovering — a click must not close it again
        if (finePointer) openItem(it);
        else it.classList.contains('open') ? closeAll() : openItem(it);
      });
      if (finePointer) {
        it.addEventListener('mouseenter', function () { openItem(it); });
        it.addEventListener('mouseleave', function () { closeTimer = setTimeout(closeAll, 180); });
        var mega = it.querySelector('.chdr-mega');
        mega && mega.addEventListener('mouseenter', function () { clearTimeout(closeTimer); });
      }
    });
    live.closeAll = closeAll;

    /* ── search ── */
    var PAGES = [
      ['Home', 'Crapplet Cloud homepage', '/index.html', 'home', 'home start main'],
      ['Shared Hosting', 'Affordable hosting for websites & blogs', '/shared-hosting.html', 'cloud', 'web website cpanel blog cheap'],
      ['Reseller Hosting', 'Start your own hosting business', '/reseller-hosting.html', 'storefront', 'resell whm business agency'],
      ['WordPress Hosting', 'Fast, secure hosting tuned for WordPress', '/wordpress-hosting.html', 'web', 'wp blog cms'],
      ['Linux VPS Hosting', 'Full root access, SSD storage, instant setup', '/linux-vps-hosting.html', 'terminal', 'vps ubuntu debian centos root server cloud special15 offer discount'],
      ['Windows VPS Hosting', 'Full RDP access with SSD storage', '/windows-vps-hosting.html', 'desktop_windows', 'vps rdp windows server cloud special15 offer discount'],
      ['Forex VPS Hosting', 'Low-latency VPS for trading platforms', '/forex-vps-hosting.html', 'candlestick_chart', 'mt4 mt5 trading forex metatrader'],
      ['n8n VPS Hosting', 'Self-host n8n with unlimited workflows', '/n8n-vps-hosting.html', 'account_tree', 'automation workflow n8n'],
      ['Minecraft VPS Hosting', 'Game servers deployed in under 60 seconds', '/minecraft-vps-hosting.html', 'sports_esports', 'game gaming minecraft paper spigot'],
      ['Gold VPS Hosting', 'Premium high-performance VPS plans', '/gold-vps-hosting.html', 'workspace_premium', 'premium gold vps'],
      ['Tally on Cloud', 'Access Tally securely from anywhere', '/tally-on-cloud.html', 'calculate', 'tally accounting erp gst'],
      ['Dedicated Servers', 'Bare-metal servers, fully yours', '/dedicated-hosting.html', 'dns', 'dedicated bare metal server'],
      ['GPU Servers', 'NVIDIA H100, A100, L40S & RTX GPUs', '/gpu-server.html', 'memory', 'gpu ai ml nvidia h100 a100 deep learning'],
      ['Colocation', 'Tier III data centre in Gwalior', '/colocation.html', 'hub', 'colo rack data centre datacenter'],
      ['DDoS Protection', 'Always-on protection for your services', '/ddos-protection.html', 'security', 'ddos attack firewall protection'],
      ['Domain Names', 'Register and transfer domains', '/domain.html', 'language', 'domain register transfer dns'],
      ['Contact & Support', 'Talk to our team, 24/7', '/contact.html', 'headset_mic', 'support help contact sales ticket'],
      ['Terms & Conditions', 'Terms of service', '/terms-and-conditions.html', 'gavel', 'terms legal tos'],
      ['Privacy Policy', 'How we handle your data', '/privacy-and-policy.html', 'policy', 'privacy legal gdpr'],
      ['Refund Policy', 'Refunds and cancellations', '/refund-policy.html', 'currency_exchange', 'refund cancel money back']
    ];
    var input = hdr.querySelector('.chdr-search input');
    var box = hdr.querySelector('.chdr-results');
    var sel = 0, current = [];
    function esc(s) { return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function closeResults() { if (box) box.classList.remove('open'); }
    live.closeResults = closeResults;
    live.input = input;
    function render(q) {
      q = q.trim().toLowerCase();
      if (!q) { closeResults(); return; }
      var words = q.split(/\s+/);
      current = PAGES.filter(function (p) {
        var hay = (p[0] + ' ' + p[1] + ' ' + p[4]).toLowerCase();
        return words.every(function (w) { return hay.indexOf(w) !== -1; });
      }).slice(0, 7);
      sel = 0;
      box.innerHTML = current.length ? current.map(function (p, i) {
        return '<a class="chdr-res' + (i === 0 ? ' active' : '') + '" href="' + p[2] + '"><span class="ms">' + p[3] + '</span><span><b>' + esc(p[0]) + '</b><small>' + esc(p[1]) + '</small></span></a>';
      }).join('') : '<div class="chdr-empty">No results for “' + esc(q) + '”</div>';
      box.classList.add('open');
    }
    if (input && box) {
      input.addEventListener('input', function () { render(input.value); });
      input.addEventListener('focus', function () { if (input.value) render(input.value); });
      input.addEventListener('keydown', function (e) {
        var links = box.querySelectorAll('.chdr-res');
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          if (!links.length) return; e.preventDefault();
          sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
          links.forEach(function (l, i) { l.classList.toggle('active', i === sel); });
        } else if (e.key === 'Enter') {
          if (current[sel]) { e.preventDefault(); location.href = current[sel][2]; }
        }
      });
      var kbd = hdr.querySelector('.chdr-kbd');
      if (kbd && /Mac|iPhone|iPad/.test(navigator.platform || '')) kbd.textContent = '⌘ K';
    }

    /* ── mobile fallback: pages without the slide-out drawer ── */
    if (!document.getElementById('mobile-drawer')) {
      var t = document.getElementById('menu-toggle');
      var panel = hdr.querySelector('.chdr-mpanel');
      if (t && panel) {
        var fresh = t.cloneNode(true);           // drop any old, broken listeners
        t.parentNode.replaceChild(fresh, t);
        fresh.addEventListener('click', function () {
          var o = panel.classList.toggle('open'); fresh.classList.toggle('open', o);
          fresh.setAttribute('aria-expanded', o ? 'true' : 'false');
        });
      }
    }

  }

  function init() {
    var hdr = document.querySelector('.chdr');
    if (!hdr || hdr.getAttribute('data-bound') === '1') return;
    hdr.setAttribute('data-bound', '1');
    bind(hdr);
  }

  if (!window.__crappletHeaderGlobal) {
    window.__crappletHeaderGlobal = true;
    window.addEventListener('scroll', function () { live.onScroll && live.onScroll(); }, { passive: true });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.chdr-item') && live.closeAll) live.closeAll();
      if (!e.target.closest('.chdr-search') && live.closeResults) live.closeResults();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { live.closeAll && live.closeAll(); live.closeResults && live.closeResults(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K') && live.input && document.contains(live.input)) { e.preventDefault(); live.input.focus(); live.input.select(); }
    });
  }
  window.crappletHeaderInit = init;
  init();
})();
