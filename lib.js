// Shared helpers for index.html (app.js) and book.html (book.js). Needs config.js + supabase-js loaded first.
const TZ = 'Africa/Johannesburg';
const OFF = '+02:00'; // South Africa has no daylight saving, so a fixed offset is exact
const sb = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const $ = s => document.querySelector(s);

// The one render helper: h(tag, attrs, ...children). Strings become text nodes (never HTML), so user data is safe.
// attrs: on* = event listener, class, value (set as property), anything else = attribute. null/false are skipped.
const h = (tag, a, ...kids) => {
  const e = document.createElement(tag);
  for (const k in a || {}) {
    const v = a[k];
    if (v == null || v === false) continue;
    if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k !== 'value') e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...nodes(kids));
  if (a && a.value != null) e.value = a.value; // after children, so <select> options exist
  return e;
};
const nodes = kids => kids.flat(9).filter(x => x != null && x !== false).map(x => (x.nodeType ? x : document.createTextNode(String(x))));
const show = (root, ...kids) => root.replaceChildren(...nodes(kids));

const A = (txt, href, cls = '') => h('a', { class: 'btn ' + cls, href, target: '_blank', rel: 'noopener' }, txt);
const B = (txt, fn, cls = '') => h('button', { type: 'button', class: 'btn ' + cls, onclick: fn }, txt);
const toast = msg => {
  const t = h('div', { id: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
};

// Money: cents -> "R 350" / "R 350.50"
const money = c => 'R ' + (c / 100).toLocaleString('en-ZA', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });

// Dates/times, always in Africa/Johannesburg
const fmt = (d, o) => new Intl.DateTimeFormat('en-ZA', { timeZone: TZ, ...o }).format(new Date(d));
const hm = d => fmt(d, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayLabel = d => fmt(d, { weekday: 'short', day: 'numeric', month: 'short' });
const ymd = d => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(d)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayStart = s => new Date(s + 'T00:00:00' + OFF);

// Phones: anything South African -> 27XXXXXXXXX, or null
const normPhone = s => {
  let d = String(s || '').replace(/\D/g, '').replace(/^00/, '');
  if (/^270\d{9}$/.test(d)) d = '27' + d.slice(3);
  else if (/^0\d{9}$/.test(d)) d = '27' + d.slice(1);
  else if (/^\d{9}$/.test(d)) d = '27' + d;
  return /^27[1-9]\d{8}$/.test(d) ? d : null;
};
const wa = (phone, text) => `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
const enc = s => encodeURIComponent(s).replace(/%20/g, '+');
const siteUrl = () => (CONFIG.SITE_URL || location.origin).replace(/\/$/, '');
const bookUrl = (slug, token) => `${siteUrl()}/book.html?s=${slug}` + (token ? `&p=${token}` : '');
const first = n => String(n || '').trim().split(/\s+/)[0];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
