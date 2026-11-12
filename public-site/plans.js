/*!
 * Crapplet — live plans on product pages
 *
 * HOW IT WORKS
 *  - Put data-plans="SHARED" (a plan type, or several: "SHARED,WORDPRESS") on the element that holds a
 *    page's plan cards. Whatever is inside stays as the fallback (no JavaScript, API down, or no plans of
 *    that type created in the panel yet).
 *  - When the panel has plans of that type, the cards are drawn from the panel: new plans appear, hidden or
 *    disabled plans disappear, and plans marked "Out of stock" show an Out of stock button. Prices,
 *    features and the "Most popular" badge (Featured) all come from the plan in the admin panel.
 *  - Optional: data-plans-layout="rows" (horizontal rows), data-plans-theme="dark" (dark sections),
 *    data-plans-hide="#some-id" (elements to hide once live plans are shown, e.g. an hourly toggle).
 */
(function () {
  'use strict';
  var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-plans]'));
  if (!nodes.length || !window.fetch) return;

  var types = [];
  nodes.forEach(function (n) {
    n.getAttribute('data-plans').split(',').forEach(function (t) {
      t = t.trim().toUpperCase();
      if (t && types.indexOf(t) < 0) types.push(t);
    });
  });

  var css = '' +
    '.cp-card{transition:transform .25s ease,box-shadow .25s ease}' +
    '.cp-card:hover{transform:translateY(-4px);box-shadow:0 18px 40px -16px rgba(124,58,237,.28)}' +
    '.cp-oos{filter:grayscale(.35)}.cp-oos:hover{transform:none}' +
    '.cp-btn{display:flex;align-items:center;justify-content:center;gap:6px;height:48px;border-radius:12px;font-weight:800;transition:all .2s}' +
    '.cp-fade{animation:cpFade .45s ease both}@keyframes cpFade{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}';
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function inr(n) {
    var r = Math.round(n * 100) / 100;
    return r % 1 === 0 ? r.toLocaleString('en-IN') : r.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function usd(n) {
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function gb(mb) {
    return mb >= 1024 ? (mb / 1024 % 1 === 0 ? mb / 1024 : (mb / 1024).toFixed(1)) + ' GB' : mb + ' MB';
  }
  var CYCLE_NOTE = { QUARTERLY: 'billed quarterly', SEMIANNUAL: 'billed every 6 months', ANNUAL: 'billed yearly', BIENNIAL: 'billed every 2 years', TRIENNIAL: 'billed every 3 years' };

  function features(p) {
    if (p.features && p.features.length) return p.features;
    var s = p.specs || {}, out = [];
    if (s.cpuCores) out.push(s.cpuCores + ' vCPU Core' + (s.cpuCores > 1 ? 's' : ''));
    if (s.ramMb) out.push(gb(s.ramMb) + ' RAM');
    if (s.diskGb) out.push(s.diskGb + ' GB NVMe SSD');
    if (s.bandwidthGb === 0) out.push('Unmetered Bandwidth');
    else if (s.bandwidthGb) out.push((s.bandwidthGb >= 1000 ? s.bandwidthGb / 1000 + ' TB' : s.bandwidthGb + ' GB') + ' Bandwidth');
    if (s.ipv4Count) out.push(s.ipv4Count + ' Dedicated IPv4');
    return out;
  }

  function price(p, dark) {
    var i = p.price && p.price.INR, u = p.price && p.price.USD;
    if (!i) return '<div class="text-sm font-semibold ' + (dark ? 'text-white/60' : 'text-slate-500') + '">Contact us for pricing</div>';
    var per = i.per === 'one-time' ? 'one-time' : '/mo';
    return '<div class="flex items-baseline gap-1">' +
      '<span class="' + (dark ? 'text-white' : 'text-slate-900') + ' text-4xl font-black"><span class="price-amount" data-inr="' + inr(i.amount) + '"' + (u ? ' data-usd="' + usd(u.amount) + '"' : '') + '>₹' + inr(i.amount) + '</span></span>' +
      '<span class="' + (dark ? 'text-white/50' : 'text-slate-500') + ' text-sm font-medium">' + per + '</span></div>' +
      (CYCLE_NOTE[i.cycle] ? '<div class="text-[11px] font-semibold ' + (dark ? 'text-white/45' : 'text-slate-400') + '">' + CYCLE_NOTE[i.cycle] + '</div>' : '');
  }

  function button(p, dark, rows) {
    if (p.outOfStock) {
      return '<div class="' + (rows ? 'min-w-[170px] ' : '') + 'flex flex-col gap-1.5">' +
        '<span class="cp-btn cursor-not-allowed ' + (dark ? 'bg-white/10 text-white/60' : 'bg-slate-100 text-slate-500') + ' px-6" aria-disabled="true"><span class="material-symbols-outlined text-[19px]">inventory_2</span>Out of Stock</span>' +
        '<a href="/contact.html" class="text-center text-xs font-bold ' + (dark ? 'text-violet-300' : 'text-primary') + ' hover:underline">Notify me when available</a></div>';
    }
    var primary = p.featured;
    return '<a href="' + esc(p.orderUrl) + '" class="cp-btn ' + (rows ? 'min-w-[170px] px-8 ' : 'w-full ') +
      (primary ? 'bg-primary text-white shadow-lg shadow-primary/30 hover:brightness-110' : dark ? 'bg-white/10 text-white border border-white/15 hover:bg-white/20' : 'bg-slate-50 text-slate-900 border border-slate-200 hover:border-primary hover:text-primary') +
      '">Order Now<span class="material-symbols-outlined text-[18px]">arrow_forward</span></a>';
  }

  function badges(p, dark, rows) {
    var b = '';
    if (p.outOfStock) b += '<div class="absolute -top-3 ' + (rows ? 'right-8' : 'right-6') + ' rounded-full bg-amber-500 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-white shadow">Out of stock</div>';
    else if (p.featured) b += '<div class="absolute -top-3 ' + (rows ? 'left-8' : 'left-1/2 -translate-x-1/2') + ' whitespace-nowrap rounded-full bg-primary px-4 py-1 text-[10px] font-bold uppercase tracking-widest text-white">Most Popular</div>';
    return b;
  }

  function freeDomain(p, dark) {
    if (!p.freeDomain) return '';
    var t = p.freeDomain.tlds && p.freeDomain.tlds.length ? p.freeDomain.tlds.slice(0, 3).join(' / ') : 'domain';
    var yearly = p.freeDomain.cycles && p.freeDomain.cycles.length && p.freeDomain.cycles.indexOf('MONTHLY') < 0 ? ' with yearly billing' : '';
    return '<div class="flex items-center gap-1.5 rounded-lg ' + (dark ? 'bg-emerald-400/10 text-emerald-300' : 'bg-emerald-50 text-emerald-700') + ' px-3 py-1.5 text-xs font-bold"><span class="material-symbols-outlined text-[16px]">redeem</span>Free ' + esc(t) + esc(yearly) + '</div>';
  }

  function card(p, dark, idx) {
    var feat = features(p);
    var border = p.featured && !p.outOfStock ? 'border-2 border-primary shadow-xl' : dark ? 'border border-white/10' : 'border border-slate-200 shadow-sm';
    return '<div class="cp-card cp-fade relative flex flex-col gap-6 rounded-2xl ' + border + ' ' + (dark ? 'bg-white/[.04] text-white' : 'bg-white') + ' p-8' + (p.outOfStock ? ' cp-oos' : '') + '" style="animation-delay:' + idx * 70 + 'ms">' +
      badges(p, dark) +
      '<div class="flex flex-col gap-2">' +
        '<h3 class="' + (dark ? 'text-white' : 'text-slate-900') + ' text-xl font-bold">' + esc(p.name) + '</h3>' +
        (p.tagline ? '<p class="text-sm ' + (dark ? 'text-white/60' : 'text-slate-500') + ' leading-snug">' + esc(p.tagline) + '</p>' : '') +
        '<div class="mt-3">' + price(p, dark) + '</div>' +
      '</div>' +
      button(p, dark) +
      freeDomain(p, dark) +
      (feat.length ? '<ul class="space-y-3.5 pt-4 border-t ' + (dark ? 'border-white/10' : 'border-slate-100') + '">' + feat.map(function (f) {
        return '<li class="flex items-start gap-3 text-sm ' + (dark ? 'text-white/80' : 'text-slate-700') + '"><span class="material-symbols-outlined text-primary text-lg leading-5">check_circle</span><span>' + esc(f) + '</span></li>';
      }).join('') + '</ul>' : '') +
    '</div>';
  }

  function row(p, dark, idx) {
    var feat = features(p).slice(0, 8);
    var border = p.featured && !p.outOfStock ? 'border-2 border-primary shadow-xl shadow-primary/5' : dark ? 'border border-white/10' : 'border border-slate-200';
    return '<div class="cp-card cp-fade relative flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-6 lg:gap-8 p-6 lg:p-8 rounded-2xl ' + border + ' ' + (dark ? 'bg-white/[.04] text-white' : 'bg-white') + (p.outOfStock ? ' cp-oos' : '') + '" style="animation-delay:' + idx * 60 + 'ms">' +
      badges(p, dark, true) +
      '<div class="flex flex-col gap-1 lg:min-w-[200px]">' +
        '<h3 class="' + (p.featured ? 'text-primary' : dark ? 'text-white/70' : 'text-slate-500') + ' text-xs font-bold uppercase tracking-wider">' + esc(p.name) + '</h3>' +
        price(p, dark) +
        (p.tagline ? '<p class="text-xs ' + (dark ? 'text-white/50' : 'text-slate-500') + '">' + esc(p.tagline) + '</p>' : '') +
      '</div>' +
      '<div class="flex-1 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-x-4 gap-y-2.5">' + feat.map(function (f) {
        return '<div class="flex items-center gap-2 text-sm ' + (dark ? 'text-white/80' : 'text-slate-700') + '"><span class="material-symbols-outlined text-primary text-base">check_circle</span>' + esc(f) + '</div>';
      }).join('') + (p.freeDomain ? '<div class="sm:col-span-2 xl:col-span-4">' + freeDomain(p, dark) + '</div>' : '') + '</div>' +
      button(p, dark, true) +
    '</div>';
  }

  function gridClass(n) {
    if (n <= 1) return 'grid grid-cols-1 gap-8 max-w-md mx-auto';
    if (n === 2) return 'grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto';
    if (n === 3 || n === 6 || n === 9) return 'grid grid-cols-1 md:grid-cols-3 gap-8';
    return 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6';
  }

  function render(node, data) {
    var want = node.getAttribute('data-plans').split(',').map(function (t) { return t.trim().toUpperCase(); });
    // only take over when the panel has plans of this type — otherwise keep the page's own section
    var managed = want.some(function (t) { return (data.managedTypes || []).indexOf(t) >= 0; });
    if (!managed) return;
    var list = data.plans.filter(function (p) { return want.indexOf(p.type) >= 0; });
    var dark = node.getAttribute('data-plans-theme') === 'dark';
    var rows = node.getAttribute('data-plans-layout') === 'rows';
    if (!list.length) {
      node.className = 'max-w-xl mx-auto';
      node.innerHTML = '<div class="rounded-2xl ' + (dark ? 'bg-white/5 text-white border border-white/10' : 'bg-white border border-slate-200') + ' p-10 text-center">' +
        '<span class="material-symbols-outlined text-4xl text-primary">inventory_2</span>' +
        '<h3 class="mt-2 text-lg font-bold">No plans available right now</h3>' +
        '<p class="mt-1 text-sm ' + (dark ? 'text-white/60' : 'text-slate-500') + '">New capacity is on the way. Talk to us and we\'ll set one up for you.</p>' +
        '<a href="/contact.html" class="mt-5 inline-flex h-11 items-center gap-2 rounded-xl bg-primary px-6 font-bold text-white">Contact sales</a></div>';
    } else {
      node.className = rows ? 'flex flex-col gap-6 max-w-6xl mx-auto' : gridClass(list.length);
      node.innerHTML = list.map(function (p, i) { return rows ? row(p, dark, i) : card(p, dark, i); }).join('');
    }
    node.setAttribute('data-plans-live', '');
    var hide = node.getAttribute('data-plans-hide');
    if (hide) Array.prototype.forEach.call(document.querySelectorAll(hide), function (el) { el.style.display = 'none'; });
  }

  fetch('/api/catalog/plans?types=' + encodeURIComponent(types.join(',')), { headers: { accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !data.plans) return; // keep the page's own plans
      nodes.forEach(function (n) { render(n, data); });
      if (window.CrappletCurrency) window.CrappletCurrency.refresh();
    })
    .catch(function () { /* offline / API down — the static plans stay */ });
})();
