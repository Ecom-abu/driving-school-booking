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

// Inline SVG icons (static strings we own, never user data)
const ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4-6.3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  wallet: '<rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20M16 15h2"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  nav: '<path d="M3 11l19-9-9 19-2-8-8-2z"/>',
  chat: '<path d="M21 12a8.5 8.5 0 0 1-12.6 7.4L3 21l1.6-5.2A8.5 8.5 0 1 1 21 12z"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  bank: '<path d="M3 10l9-6 9 6M5 10v8M19 10v8M9 10v8M15 10v8M3 21h18"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  left: '<path d="M15 18l-6-6 6-6"/>',
  right: '<path d="M9 18l6-6-6-6"/>',
  route: '<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h8.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H16"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  flag: '<path d="M4 22V4M4 4h13l-2 4 2 4H4"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
  box: '<path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8"/>',
  send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  repeat: '<path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>'
};
const icon = (n, cls = '') => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'ic ' + cls);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[n] || '';
  return s;
};

// Buttons / links: A(text, href, cls, iconName), B(text, onclick, cls, iconName)
const A = (txt, href, cls = '', ic) => h('a', { class: 'btn ' + cls, href, target: '_blank', rel: 'noopener' }, ic && icon(ic), txt);
const B = (txt, fn, cls = '', ic) => h('button', { type: 'button', class: 'btn ' + cls, onclick: fn }, ic && icon(ic), txt);

// Toasts, bottom sheets, confirm sheets, skeletons, empty states
const toast = (msg, kind = '') => {
  let box = $('#toasts');
  if (!box) document.body.append(box = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const t = h('div', { class: 'toast ' + kind }, kind === 'ok' && icon('check'), kind === 'bad' && icon('alert'), msg);
  box.append(t);
  setTimeout(() => t.remove(), 3800);
};
const sheet = (title, ...kids) => {
  const close = () => s.remove();
  const s = h('div', { class: 'scrim', onclick: e => e.target === s && close() },
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'head' }, h('h2', null, title), h('button', { class: 'btn ghost sm', 'aria-label': 'Close', onclick: close }, icon('x'))),
      kids));
  document.body.append(s);
  s.close = close;
  return s;
};
const confirmSheet = (title, text, okLabel = 'Yes', cls = 'pri') => new Promise(res => {
  const s = sheet(title, h('p', { class: 'muted' }, text),
    B(okLabel, () => { s.close(); res(true); }, cls + ' big'),
    B('Never mind', () => { s.close(); res(false); }, 'ghost big'));
});
const skeleton = (n = 3) => Array.from({ length: n }, () => h('div', { class: 'skel' }));
const empty = (ic, title, text) => h('div', { class: 'empty' }, icon(ic), h('b', null, title), text && h('p', null, text));

// Money: cents -> "R 350" / "R 350.50"
const money = c => 'R ' + ((c || 0) / 100).toLocaleString('en-ZA', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });

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
const localHour = d => +fmt(d, { hour: '2-digit', hourCycle: 'h23' }) + (+fmt(d, { minute: '2-digit' })) / 60;
const daysUntil = s => Math.round((dayStart(s) - dayStart(ymd(new Date()))) / 864e5);

// Phones: anything South African -> 27XXXXXXXXX, or null
const normPhone = s => {
  let d = String(s || '').replace(/\D/g, '').replace(/^00/, '');
  if (/^270\d{9}$/.test(d)) d = '27' + d.slice(3);
  else if (/^0\d{9}$/.test(d)) d = '27' + d.slice(1);
  else if (/^\d{9}$/.test(d)) d = '27' + d;
  return /^27[1-9]\d{8}$/.test(d) ? d : null;
};
const localPhone = p => (p ? '0' + String(p).slice(2) : '');
const wa = (phone, text) => `https://wa.me/${phone}` + (text ? `?text=${encodeURIComponent(text)}` : '');
const enc = s => encodeURIComponent(s).replace(/%20/g, '+');
const mapsTo = a => `https://www.google.com/maps/dir/?api=1&destination=${enc(a)}&travelmode=driving`;
const siteUrl = () => (CONFIG.SITE_URL || location.origin).replace(/\/$/, '');
const bookUrl = (slug, token) => `${siteUrl()}/book.html?s=${slug}` + (token ? `&p=${token}` : '');
const first = n => String(n || '').trim().split(/\s+/)[0];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const copyText = async (t, label = 'Copied') => {
  try { await navigator.clipboard.writeText(t); toast(label, 'ok'); } catch { prompt('Copy this', t); }
};
const setBrand = color => {
  if (!/^#[0-9a-f]{6}$/i.test(color || '')) return;
  document.documentElement.style.setProperty('--pri', color);
  const m = $('meta[name=theme-color]');
  if (m) m.content = color;
};
// "Morning" / "Afternoon" / "Evening" for slot grouping
const partOfDay = d => { const x = localHour(d); return x < 12 ? 'Morning' : x < 17 ? 'Afternoon' : 'Evening'; };

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
