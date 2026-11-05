// Staff app (owner + instructors). Uses lib.js helpers (sb, h, show, icon, sheet, toast, money, wa, ...).
let me, school, staffList = [], lessonTypes = [];
const app = $('#app'), tabs = $('#tabs'), fab = $('#fab');
const isOwner = () => me && me.role === 'owner';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const METHODS = [['cash', 'Cash'], ['eft', 'EFT'], ['card_link', 'Card link'], ['other', 'Other']];
const PALETTE = ['#2e90fa', '#7a5af8', '#ee46bc', '#f79009', '#12b76a', '#06aed4', '#f04438', '#667085'];
const staffColor = id => PALETTE[Math.max(0, staffList.findIndex(s => s.id === id)) % PALETTE.length];
const staffName = id => (staffList.find(s => s.id === id) || {}).name || '';
const addrOf = b => b.pickup_address || (b.students && b.students.pickup_address) || '';
const mondayOf = s => addDays(s, -((new Date(s + 'T12:00:00Z').getUTCDay() + 6) % 7));
const initials = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const stat = (v, l, cls = '') => h('div', { class: 'stat ' + cls }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));
const sum = a => a.reduce((x, y) => x + (y || 0), 0);

const ok = ({ data, error }) => {
  if (error) {
    if (error.code === '23505') error.message = 'That already exists (the link name or phone number is taken).';
    if (error.code === '42501') error.message = 'Only the owner can change this.';
    throw error;
  }
  return data;
};
const fail = e => toast(e.message || String(e), 'bad');
const upd = async (table, id, v) => ok(await sb.from(table).update(v).eq('id', id));

// ───────── forms: built from a field list ─────────
// field: {n:name, l:label, t:type|'select'|'textarea', o:[[value,label]], req, cents (Rand<->cents), bool, p:placeholder, v:default}
function formEl(fields, init, save, o = {}) {
  const f = h('form', { class: 'form' },
    fields.map(x => {
      let v = init[x.n] ?? x.v;
      if (x.cents && v != null) v /= 100;
      const el = x.t === 'select'
        ? h('select', { name: x.n, value: String(v ?? '') }, x.o.map(([val, txt]) => h('option', { value: val }, txt)))
        : h(x.t === 'textarea' ? 'textarea' : 'input', {
          name: x.n, rows: 3, type: x.t === 'textarea' ? null : x.t || 'text', value: v, required: x.req, placeholder: x.p,
          step: x.t === 'number' ? 'any' : null, inputmode: x.t === 'number' ? 'decimal' : null
        });
      return h('label', null, x.l, el, x.hint && h('div', { class: 'tiny' }, x.hint));
    }),
    h('p', { class: 'err' }),
    h('button', { class: 'btn pri' }, o.btn || 'Save'));
  if (o.change) f.addEventListener('change', e => o.change(e, f));
  f.onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(f), v = {};
    for (const x of fields) {
      let r = fd.get(x.n);
      r = typeof r === 'string' ? r.trim() : r;
      if (r === '') r = null;
      if (r != null) r = x.cents ? Math.round(r * 100) : x.t === 'number' ? +r : x.bool ? r === 'true' : r;
      v[x.n] = r;
    }
    const btn = f.querySelector('button.pri');
    btn.disabled = true;
    try { await save(v); if (o.done) o.done(); } catch (er) { f.querySelector('.err').textContent = er.message || er; btn.disabled = false; }
  };
  return f;
}
const editor = (title, fields, init, save, change) => {
  const s = sheet(title, formEl(fields, init || {}, save, { change, done: () => { s.close(); toast('Saved', 'ok'); route(); } }));
};
function openWA(url) {
  if (window.open(url, '_blank')) return;
  const s = sheet('Send WhatsApp', h('p', { class: 'muted' }, 'Tap to open WhatsApp with the message ready.'),
    h('a', { class: 'btn pri big', href: url, target: '_blank', rel: 'noopener', onclick: () => s.close() }, icon('chat'), 'Open WhatsApp'));
}

// ───────── auth + boot ─────────
async function refs() {
  [staffList, lessonTypes] = (await Promise.all([
    sb.from('staff').select('*').order('name'),
    sb.from('lesson_types').select('*').eq('active', true).order('minutes')])).map(ok);
}
async function start() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return loginView();
  await sb.rpc('claim_staff');
  const { data, error } = await sb.from('staff').select('*, schools(*)')
    .eq('auth_user_id', session.user.id).eq('active', true).limit(1).maybeSingle();
  if (error) return show(app, empty('alert', 'Could not load', error.message));
  if (!data) return onboarding();
  me = data; school = data.schools;
  setBrand(school.brand_color);
  await refs();
  const T = [['today', 'Today', 'sun'], ['week', 'Week', 'calendar'], ['students', 'Students', 'users'],
    isOwner() && ['money', 'Money', 'wallet'], ['settings', isOwner() ? 'Settings' : 'Me', 'sliders']].filter(Boolean);
  show(tabs, T.map(([k, l, i]) => h('a', { href: '#' + k, 'data-k': k }, icon(i), l)));
  tabs.hidden = false;
  fab.onclick = () => bookFlow();
  if (location.hash.includes('access_token')) location.hash = '#today';
  route();
}

function loginView() {
  tabs.hidden = true;
  const msg = h('p', { class: 'muted' }, 'We email you a sign-in link. No password needed.');
  show(app, h('div', { class: 'card', style: 'margin-top:12vh' },
    h('div', { class: 'avatar' }, icon('calendar')), h('h1', { style: 'margin-top:12px' }, 'Driving school'),
    formEl([{ n: 'email', l: 'Your email', t: 'email', req: 1, p: 'you@example.co.za' }], {},
      async v => ok(await sb.auth.signInWithOtp({ email: v.email, options: { emailRedirectTo: location.origin + location.pathname } })),
      { btn: 'Email me a sign-in link', done: () => { msg.textContent = 'Check your email and tap the link ✉️'; toast('Link sent', 'ok'); } }),
    msg));
}

function onboarding() {
  tabs.hidden = true;
  const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  show(app, h('h1', null, 'Set up your driving school'), h('div', { class: 'card' },
    formEl([
      { n: 'name', l: 'School name', req: 1 },
      { n: 'slug', l: 'Booking link name', req: 1, p: 'my-driving-school', hint: 'Letters, numbers and dashes. Your link: …/book.html?s=this-name' },
      { n: 'staff', l: 'Your name', req: 1 },
      { n: 'whatsapp', l: 'School WhatsApp number', t: 'tel', req: 1 }], {},
    async v => {
      const wa27 = normPhone(v.whatsapp);
      if (!wa27) throw new Error('Enter a valid SA number');
      if (!/^[a-z0-9-]{3,40}$/.test(v.slug)) throw new Error('Link name: 3-40 letters, numbers or dashes');
      ok(await sb.rpc('create_school', { p_name: v.name, p_slug: v.slug, p_staff_name: v.staff, p_whatsapp: wa27 }));
    },
    {
      btn: 'Create school', done: start,
      change: (e, f) => { if (e.target.name === 'name' && !f.slug.value) f.slug.value = slugify(e.target.value); }
    })));
}

// ───────── router ─────────
const views = { today: () => day(0), tomorrow: () => day(1), week, students, student, money: moneyView, settings };
function route() {
  if (!me) return;
  let [name, arg] = (location.hash.slice(1) || 'today').split('/');
  if (!views[name] || (name === 'money' && !isOwner())) name = 'today';
  const tab = { tomorrow: 'today', student: 'students' }[name] || name;
  tabs.querySelectorAll('a').forEach(a => a.classList.toggle('on', a.dataset.k === tab));
  fab.hidden = !['today', 'tomorrow', 'week', 'students', 'student'].includes(name);
  show(app, skeleton(3));
  views[name](arg).catch(e => show(app, empty('alert', 'Something went wrong', e.message || String(e))));
}
window.addEventListener('hashchange', route);

// ───────── Today / Tomorrow ─────────
async function dayBookings(from, to, staff) {
  let q = sb.from('bookings').select('*, students(name,phone,token,pickup_address), lesson_types(name,price_cents)')
    .gte('start_at', dayStart(from).toISOString()).lt('start_at', dayStart(to).toISOString())
    .neq('status', 'cancelled').order('start_at');
  if (staff) q = q.eq('staff_id', staff);
  return ok(await q);
}
async function balances(bs) {
  const ids = [...new Set(bs.map(b => b.student_id))];
  const rows = ids.length ? ok(await sb.from('student_balance').select('*').in('student_id', ids)) : [];
  return Object.fromEntries(rows.map(s => [s.student_id, s]));
}
// cash to collect per booking: lesson price unless package credits cover it, plus any older debt (once per student)
function collectMap(bs, bm) {
  const out = {}, used = {}, debt = {};
  for (const b of bs) {
    const s = bm[b.student_id] || { credits: 0, owing_cents: 0 };
    let c = 0;
    if (b.status === 'booked') {
      used[b.student_id] = (used[b.student_id] || 0) + 1;
      if (used[b.student_id] > s.credits) c += (b.lesson_types && b.lesson_types.price_cents) || 0;
    }
    if (!debt[b.student_id] && s.owing_cents > 0) { c += s.owing_cents; debt[b.student_id] = 1; }
    out[b.id] = c;
  }
  return out;
}

async function day(offset) {
  const d = addDays(ymd(new Date()), offset);
  const bs = await dayBookings(d, addDays(d, 1));
  const bm = await balances(bs), due = collectMap(bs, bm);
  const live = bs.filter(b => b.status === 'booked');
  const stops = live.map(addrOf).filter(Boolean);
  const byStaff = {};
  live.forEach(b => (byStaff[b.staff_id] = byStaff[b.staff_id] || []).push(b));
  show(app,
    h('div', { class: 'seg' }, ['Today', 'Tomorrow'].map((t, i) =>
      h('button', { class: i === offset ? 'on' : '', onclick: () => { location.hash = i ? '#tomorrow' : '#today'; } }, t))),
    h('h1', null, offset ? `Tomorrow: ${plural(bs.length, 'lesson')}` : `Today: ${plural(bs.length, 'lesson')}`),
    h('div', { class: 'stats' },
      stat(bs.length, offset ? dayLabel(dayStart(d)) : 'lessons', 'hero'),
      stat(money(sum(bs.map(b => due[b.id]))), 'cash to collect'),
      !offset && stat(live.length, 'still to do')),
    !offset && stops.length ? B('Route all pickups', () => routeAll(stops), 'soft big', 'route') : null,
    offset && isOwner() && Object.keys(byStaff).length ? [h('h2', null, 'Send schedules'),
      Object.entries(byStaff).map(([sid, list]) => B(`Send schedule to ${staffName(sid)} (${list.length})`,
        () => sendSchedule(sid, list, d, due), 'full', 'send'))] : null,
    bs.length ? [offset && h('h2', null, 'Reminders'), bs.map(b => lessonCard(b, bm[b.student_id], due[b.id], offset))]
      : empty('sun', 'No lessons booked', offset ? 'Nothing for tomorrow yet.' : 'Enjoy the quiet day, or tap + to book someone.'));
}

function lessonCard(b, bal, due, offset) {
  const s = b.students, a = addrOf(b), live = b.status === 'booked';
  const msg = `Hi ${first(s.name)}, reminder: driving lesson ${offset ? 'tomorrow' : 'today'} at ${hm(b.start_at)}. ` +
    `Pickup: ${a || 'to be confirmed'}. Reply if you need to change. ${bookUrl(school.slug, s.token)}`;
  return h('article', { class: 'card lesson' + (live ? '' : ' dim'), style: staffList.length > 1 ? `border-left:4px solid ${staffColor(b.staff_id)}` : null },
    h('div', { class: 'row' },
      h('div', { class: 'time' }, hm(b.start_at), h('span', { class: 'tiny' }, ` – ${hm(b.end_at)}`)),
      live ? h('button', { class: 'btn ghost sm', 'aria-label': 'More', onclick: () => bookingSheet(b) }, icon('more'))
        : h('span', { class: 'b ' + (b.status === 'done' ? 'ok' : 'bad') }, b.status === 'done' ? 'Done' : 'No-show')),
    h('a', { class: 'who', href: '#student/' + b.student_id }, s.name),
    h('div', { class: 'tiny' }, (b.lesson_types && b.lesson_types.name) || 'Lesson', staffList.length > 1 ? ` · ${staffName(b.staff_id)}` : ''),
    a && h('div', { class: 'addr' }, icon('pin'), a),
    h('div', { class: 'badges' },
      due > 0 ? h('span', { class: 'b warn' }, icon('cash'), 'Collect ' + money(due)) : h('span', { class: 'b ok' }, 'Paid'),
      bal && bal.credits > 0 ? h('span', { class: 'b info' }, `Package ${bal.credits} left`) : null),
    live && (offset
      ? h('div', { class: 'actions' }, A('Send reminder', wa(s.phone, msg), 'pri', 'chat'))
      : h('div', { class: 'actions' },
        a && A('Navigate', mapsTo(a), '', 'nav'),
        A('Remind', wa(s.phone, msg), '', 'chat'),
        B('Done', () => finish(b, 'done'), 'ok', 'check'),
        B('No-show', () => finish(b, 'no_show'), 'danger', 'x'))));
}

function bookingSheet(b) {
  const s = sheet(`${b.students.name}`,
    h('p', { class: 'muted' }, `${dayLabel(b.start_at)} · ${hm(b.start_at)}–${hm(b.end_at)} · ${staffName(b.staff_id)}`),
    addrOf(b) && h('p', null, addrOf(b)),
    b.status === 'booked' && [
      B('Reschedule', () => { s.close(); rescheduleFlow(b); }, 'soft', 'clock'),
      B('Mark done', () => { s.close(); finish(b, 'done'); }, '', 'check'),
      B('Mark no-show', () => { s.close(); finish(b, 'no_show'); }, '', 'x')],
    addrOf(b) && A('Navigate', mapsTo(addrOf(b)), '', 'nav'),
    A('WhatsApp student', wa(b.students.phone, `Hi ${first(b.students.name)}, `), '', 'chat'),
    h('a', { class: 'btn', href: '#student/' + b.student_id, onclick: () => s.close() }, icon('user'), 'Student profile'),
    b.status === 'booked' && B('Cancel lesson', () => { s.close(); cancelBooking(b); }, 'danger', 'x'));
}

// Done: complete_booking charges the oldest package with credits; then WhatsApp the rebooking link.
async function finish(b, status) {
  if (status === 'no_show') {
    const price = money((b.lesson_types && b.lesson_types.price_cents) || 0);
    const rule = { credit: `Uses a package lesson if they have one, otherwise they owe ${price}.`, owe: `They will owe ${price}.`, free: 'No charge (school rule).' }[school.no_show_rule || 'credit'];
    if (!await confirmSheet(`${b.students.name} didn't show?`, rule, 'Mark no-show', 'danger solid')) return;
  }
  const { data, error } = await sb.rpc('complete_booking', { p_id: b.id, p_status: status });
  if (error) return fail(error);
  if (status === 'done') {
    const n = data.credits;
    openWA(wa(data.phone, `Thanks ${first(data.name)}! Great lesson today. ` +
      (n > 0 ? `You have ${plural(n, 'lesson')} left. ` : '') + `Book your next one here: ${bookUrl(data.slug, data.token)}`));
  } else toast('Marked as no-show');
  route();
}
async function cancelBooking(b) {
  if (!await confirmSheet('Cancel this lesson?', `${b.students.name} · ${dayLabel(b.start_at)} ${hm(b.start_at)}`, 'Cancel lesson', 'danger solid')) return;
  try {
    await upd('bookings', b.id, { status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: 'staff' });
    toast('Lesson cancelled', 'ok');
    openWA(wa(b.students.phone, `Hi ${first(b.students.name)}, your driving lesson on ${dayLabel(b.start_at)} at ${hm(b.start_at)} is cancelled. Book a new time here: ${bookUrl(school.slug, b.students.token)}`));
    route();
  } catch (e) { fail(e); }
}

function sendSchedule(sid, list, d, due) {
  const st = staffList.find(s => s.id === sid) || {};
  const phone = normPhone(st.phone);
  if (!phone) return toast(`Add a phone number for ${st.name} in Settings first`, 'bad');
  const lines = list.map(b => `${hm(b.start_at)}–${hm(b.end_at)} ${b.students.name} (${localPhone(b.students.phone)})\n📍 ${addrOf(b) || 'no address'}` +
    (due[b.id] > 0 ? `\n💵 Collect ${money(due[b.id])}` : ''));
  const total = sum(list.map(b => due[b.id]));
  openWA(wa(phone, `Hi ${first(st.name)}, your lessons for ${dayLabel(dayStart(d))}:\n\n${lines.join('\n\n')}` +
    (total > 0 ? `\n\nTotal cash to collect: ${money(total)}` : '')));
}

// Google Maps on mobile accepts only a few waypoints: up to 4 stops per link (3 waypoints + destination)
const routeUrl = (origin, stops) => {
  const w = stops.slice(0, -1);
  return `https://www.google.com/maps/dir/?api=1&origin=${enc(origin)}&destination=${enc(stops[stops.length - 1])}` +
    (w.length ? `&waypoints=${enc(w.join('|'))}` : '') + '&travelmode=driving';
};
function routeAll(stops) {
  if (stops.length <= 4) return window.open(routeUrl('My Location', stops), '_blank');
  const legs = [];
  let origin = 'My Location';
  for (let i = 0; i < stops.length; i += 4) {
    const c = stops.slice(i, i + 4);
    legs.push(A(`Leg ${legs.length + 1}: stops ${i + 1}–${i + c.length}`, routeUrl(origin, c), 'pri', 'route'));
    origin = c[c.length - 1];
  }
  sheet('Route all pickups',
    h('p', { class: 'muted' }, `${stops.length} stops. Google Maps on mobile may only accept 3 waypoints, so the full route can get cut off. Open the legs one after the other.`),
    legs, A('Try the full route anyway', routeUrl('My Location', stops), 'ghost'));
}

// ───────── Week calendar ─────────
let weekStart = null, weekStaff = '';
async function week() {
  const today = ymd(new Date());
  if (!weekStart) weekStart = mondayOf(today);
  const bs = await dayBookings(weekStart, addDays(weekStart, 7), weekStaff || null);
  const H0 = Math.min(6, ...bs.map(b => Math.floor(localHour(b.start_at)))), H1 = Math.max(20, ...bs.map(b => Math.ceil(localHour(b.end_at))));
  const PX = 40, days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const go = n => { weekStart = n == null ? mondayOf(today) : addDays(weekStart, 7 * n); route(); };
  const cal = h('div', { class: 'cal' },
    h('div', { class: 'dh' }),
    days.map(d => h('div', { class: 'dh' + (d === today ? ' today' : '') }, fmt(dayStart(d), { weekday: 'short' }), h('b', null, +d.slice(8)))),
    h('div', { class: 'gut', style: `height:${(H1 - H0) * PX}px` },
      Array.from({ length: H1 - H0 }, (_, i) => i && h('span', { style: `top:${i * PX}px` }, String(H0 + i).padStart(2, '0')))),
    days.map(d => h('div', { class: 'col', style: `height:${(H1 - H0) * PX}px` },
      bs.filter(b => ymd(b.start_at) === d).map(b => h('button', {
        class: 'ev ' + b.status,
        style: `top:${(localHour(b.start_at) - H0) * PX}px;height:${Math.max(18, (localHour(b.end_at) - localHour(b.start_at)) * PX - 2)}px;background-color:${staffColor(b.staff_id)}`,
        title: `${hm(b.start_at)} ${b.students.name}`, onclick: () => bookingSheet(b)
      }, hm(b.start_at), h('br'), first(b.students.name))))));
  show(app,
    h('h1', null, 'Week'),
    h('div', { class: 'weekbar' },
      h('button', { class: 'btn sm', 'aria-label': 'Previous week', onclick: () => go(-1) }, icon('left')),
      h('b', null, `${fmt(dayStart(days[0]), { day: 'numeric', month: 'short' })} – ${fmt(dayStart(days[6]), { day: 'numeric', month: 'short' })}`),
      h('button', { class: 'btn sm', 'aria-label': 'Next week', onclick: () => go(1) }, icon('right'))),
    h('div', { class: 'chips', style: 'margin-bottom:12px' },
      weekStart !== mondayOf(today) && h('button', { class: 'chip', onclick: () => go(null) }, 'This week'),
      isOwner() && staffList.length > 1 && [
        h('button', { class: 'chip' + (weekStaff ? '' : ' on'), onclick: () => { weekStaff = ''; route(); } }, 'All'),
        staffList.filter(s => s.active).map(s => h('button', { class: 'chip' + (weekStaff === s.id ? ' on' : ''), onclick: () => { weekStaff = s.id; route(); } },
          h('i', { style: `display:inline-block;width:10px;height:10px;border-radius:3px;background:${staffColor(s.id)}` }), s.name))]),
    h('p', { class: 'muted' }, `${plural(bs.length, 'lesson')} · ${bs.filter(b => b.status === 'booked').length} still booked`),
    cal,
    h('div', { class: 'legend' }, h('span', null, 'Faded = done'), h('span', null, 'Striped = no-show'), h('span', null, 'Tap a lesson for options')));
}

// ───────── staff booking + rescheduling ─────────
function slotPicker(o) {
  const box = h('div', { class: 'slots' });
  const date = h('input', { type: 'date', value: o.date || ymd(new Date()), min: ymd(new Date()) });
  const load = async () => {
    show(box, h('p', { class: 'muted' }, 'Loading times…'));
    const { data, error } = await sb.rpc('staff_free_slots', { p_date: date.value, p_staff: o.staff() || null, p_minutes: o.minutes(), p_exclude: o.exclude || null });
    if (error) return show(box, h('p', { class: 'err' }, error.message));
    if (!data.length) return show(box, h('p', { class: 'muted', style: 'grid-column:1/-1' }, 'No free times. Try another date, or check hours in Settings.'));
    show(box, data.map(x => h('button', {
      type: 'button', class: 'slot', onclick: e => {
        box.querySelectorAll('.slot.on').forEach(b => b.classList.remove('on'));
        e.currentTarget.classList.add('on');
        o.onPick(x);
      }
    }, hm(x.slot_start), !o.staff() && staffList.length > 1 && h('div', { class: 'tiny' }, first(x.staff_name)))));
  };
  date.onchange = load;
  return { el: [h('label', null, 'Date', date), h('label', null, 'Free times'), box], load };
}

function bookFlow(pre) {
  if (pre) return bookFor(pre);
  const list = h('div', { class: 'list' });
  const search = async q => {
    let r = sb.from('student_balance').select('*').order('name').limit(8);
    q = (q || '').replace(/[,()%*]/g, ' ').trim();
    if (/^[\d\s+]+$/.test(q)) q = q.replace(/\D/g, '').replace(/^0/, '27');
    if (q) r = r.or(`name.ilike.%${q}%,phone.ilike.%${q}%`);
    const rows = ok(await r);
    show(list, rows.length ? rows.map(st => h('button', { class: 'item', onclick: () => { s.close(); bookFor(st); } },
      h('div', { class: 'avatar' }, initials(st.name)), h('div', { class: 'grow' }, h('b', null, st.name), h('div', { class: 'tiny' }, localPhone(st.phone)))))
      : h('p', { class: 'muted', style: 'padding:12px 16px' }, 'No match. Add them as a new student.'));
  };
  let t;
  const s = sheet('Book a lesson',
    h('div', { class: 'search' }, icon('search'), h('input', { type: 'search', placeholder: 'Find student by name or phone', oninput: e => { clearTimeout(t); t = setTimeout(() => search(e.target.value).catch(fail), 250); } })),
    list,
    B('New student', () => { s.close(); editStudent({}, st => bookFor(st)); }, 'soft', 'plus'));
  search().catch(fail);
}

function bookFor(st) {
  if (!lessonTypes.length) return toast('Add a lesson type in Settings first', 'bad');
  let pick = null;
  const lt = h('select', null, lessonTypes.map(l => h('option', { value: l.id }, `${l.name} · ${l.minutes} min · ${money(l.price_cents)}`)));
  const active = staffList.filter(x => x.active);
  const staffSel = isOwner()
    ? h('select', null, active.length > 1 && h('option', { value: '' }, 'Any instructor'), active.map(x => h('option', { value: x.id }, x.name)))
    : null;
  const weeks = h('select', null, [1, 2, 3, 4, 6, 8, 10, 12].map(n => h('option', { value: n }, n === 1 ? 'Just once' : `Weekly for ${n} weeks`)));
  const pickup = h('input', { value: st.pickup_address || '', placeholder: 'Pickup address' });
  const go = B('Book lesson', async () => {
    if (!pick) return toast('Pick a time first', 'bad');
    go.disabled = true;
    const { data, error } = await sb.rpc('staff_book', {
      p_student: st.student_id || st.id, p_staff: pick.staff_id, p_lesson_type: lt.value, p_start: pick.slot_start,
      p_weeks: +weeks.value, p_pickup: pickup.value
    });
    go.disabled = false;
    if (error) return fail(error);
    s.close();
    const made = data.created.length, skip = data.skipped;
    toast(`Booked ${plural(made, 'lesson')}` + (skip.length ? ` · ${skip.length} week(s) not free` : ''), made ? 'ok' : 'bad');
    if (skip.length) sheet('Some weeks were not free', h('p', { class: 'muted' }, 'These were skipped:'),
      skip.map(x => h('div', { class: 'card' }, `${dayLabel(x)} · ${hm(x)}`)));
    route();
  }, 'pri big', 'check');
  const sp = slotPicker({
    staff: () => (staffSel ? staffSel.value : me.id),
    minutes: () => (lessonTypes.find(l => l.id === lt.value) || {}).minutes,
    onPick: x => { pick = x; go.textContent = `Book ${dayLabel(x.slot_start)} ${hm(x.slot_start)}`; }
  });
  lt.onchange = sp.load;
  if (staffSel) staffSel.onchange = sp.load;
  const s = sheet(`Book ${st.name}`,
    h('label', null, 'Lesson', lt), staffSel && h('label', null, 'Instructor', staffSel),
    sp.el, h('label', null, 'Repeat', weeks), h('label', null, 'Pickup address', pickup), go);
  sp.load();
}

function rescheduleFlow(b) {
  let pick = null;
  const minutes = Math.round((new Date(b.end_at) - new Date(b.start_at)) / 6e4);
  const staffSel = isOwner() && staffList.filter(x => x.active).length > 1
    ? h('select', { value: b.staff_id }, staffList.filter(x => x.active).map(x => h('option', { value: x.id }, x.name))) : null;
  const go = B('Move lesson', async () => {
    if (!pick) return toast('Pick a new time', 'bad');
    const { error } = await sb.rpc('staff_reschedule', { p_booking: b.id, p_start: pick.slot_start, p_staff: pick.staff_id });
    if (error) return fail(error);
    s.close();
    toast('Lesson moved', 'ok');
    openWA(wa(b.students.phone, `Hi ${first(b.students.name)}, your driving lesson has moved to ${dayLabel(pick.slot_start)} at ${hm(pick.slot_start)}. Reply if that doesn't suit you.`));
    route();
  }, 'pri big', 'check');
  const sp = slotPicker({
    date: ymd(b.start_at) < ymd(new Date()) ? null : ymd(b.start_at), exclude: b.id, minutes: () => minutes,
    staff: () => (staffSel ? staffSel.value : b.staff_id),
    onPick: x => { pick = x; go.textContent = `Move to ${dayLabel(x.slot_start)} ${hm(x.slot_start)}`; }
  });
  if (staffSel) staffSel.onchange = sp.load;
  const s = sheet(`Move ${b.students.name}'s lesson`, h('p', { class: 'muted' }, `Now: ${dayLabel(b.start_at)} · ${hm(b.start_at)}`),
    staffSel && h('label', null, 'Instructor', staffSel), sp.el, go);
  sp.load();
}

// ───────── Students ─────────
const balanceBadges = s => h('div', { class: 'badges' },
  s.owing_cents > 0 ? h('span', { class: 'b warn' }, 'Owes ' + money(s.owing_cents)) : h('span', { class: 'b ok' }, 'Paid up'),
  s.credits > 0 ? h('span', { class: 'b info' }, `${s.credits} left`) : null);

async function students() {
  const list = h('div', { class: 'list' });
  const load = async q => {
    q = (q || '').replace(/[,()%*]/g, ' ').trim();
    if (/^[\d\s+]+$/.test(q)) q = q.replace(/\D/g, '').replace(/^0/, '27');
    let r = sb.from('student_balance').select('*').order('name').limit(60);
    if (q) r = r.or(`name.ilike.%${q}%,phone.ilike.%${q}%`);
    const rows = ok(await r);
    show(list, rows.length ? rows.map(s => h('a', { class: 'item', href: '#student/' + s.student_id },
      h('div', { class: 'avatar' }, initials(s.name)),
      h('div', { class: 'grow' }, h('b', null, s.name), h('div', { class: 'tiny' }, localPhone(s.phone))),
      balanceBadges(s))) : empty('users', q ? 'No students found' : 'No students yet', q ? 'Try another name or number.' : 'They appear here when they book, or add one.'));
  };
  let t;
  show(app, h('div', { class: 'row' }, h('h1', null, 'Students'), B('Add', () => editStudent(), 'soft sm', 'plus')),
    h('div', { class: 'search' }, icon('search'), h('input', { type: 'search', placeholder: 'Search name or phone', oninput: e => { clearTimeout(t); t = setTimeout(() => load(e.target.value).catch(fail), 250); } })),
    list);
  await load();
}

const editStudent = (s = {}, after) => {
  const fields = [
    { n: 'name', l: 'Name', req: 1 },
    { n: 'phone', l: 'WhatsApp number', t: 'tel', req: 1 },
    { n: 'pickup_address', l: 'Pickup address' },
    { n: 'test_date', l: 'K53 test date', t: 'date' },
    { n: 'test_venue', l: 'Test venue (DLTC)' },
    { n: 'notes', l: 'Notes', t: 'textarea' }];
  const sh = sheet(s.student_id ? 'Edit student' : 'New student', formEl(fields, { ...s, phone: localPhone(s.phone) }, async v => {
    v.phone = normPhone(v.phone);
    if (!v.phone) throw new Error('Enter a valid SA number');
    const row = ok(s.student_id
      ? await sb.from('students').update(v).eq('id', s.student_id).select().single()
      : await sb.from('students').insert({ ...v, school_id: school.id }).select().single());
    sh.close();
    toast('Saved', 'ok');
    if (after) after({ ...row, student_id: row.id }); else route();
  }));
};

async function student(id) {
  const [s, bs, pays, sps, pks] = (await Promise.all([
    sb.from('student_balance').select('*').eq('student_id', id).maybeSingle(),
    sb.from('bookings').select('*, lesson_types(name,price_cents), students(name,phone,token,pickup_address)').eq('student_id', id).order('start_at', { ascending: false }).limit(30),
    sb.from('payments').select('*').eq('student_id', id).order('created_at', { ascending: false }).limit(10),
    sb.from('package_status').select('*').eq('student_id', id).order('bought_at', { ascending: false }),
    sb.from('packages').select('*').order('price_cents')])).map(ok);
  if (!s) throw new Error('Student not found');
  const now = Date.now();
  const upcoming = bs.filter(b => b.status === 'booked' && new Date(b.start_at) > now).reverse();
  const past = bs.filter(b => !upcoming.includes(b));
  const testIn = s.test_date ? daysUntil(s.test_date) : null;
  show(app,
    h('a', { class: 'back', href: '#students' }, icon('left'), 'Students'),
    h('div', { class: 'row', style: 'margin-top:8px' }, h('div', { class: 'avatar', style: 'width:56px;height:56px;font-size:1.2rem' }, initials(s.name)),
      h('div', { class: 'grow' }, h('h1', { style: 'margin:0' }, s.name), h('div', { class: 'muted' }, localPhone(s.phone)))),
    s.pickup_address && h('div', { class: 'addr muted', style: 'display:flex;gap:6px;margin-top:8px' }, icon('pin'), s.pickup_address),
    h('div', { class: 'stats' },
      stat(s.credits, 'lessons left', 'hero'),
      stat(money(Math.max(0, s.owing_cents)), s.owing_cents < 0 ? `in credit ${money(-s.owing_cents)}` : 'owing'),
      stat(upcoming.length, 'booked'),
      stat(testIn == null ? '—' : testIn < 0 ? 'Done' : testIn, testIn == null ? 'no test date' : `days to K53${s.test_venue ? ' · ' + s.test_venue : ''}`)),
    h('div', { class: 'actions' },
      B('Book lesson', () => bookFlow(s), 'pri', 'calendar'),
      B('Sell package', () => sell(s, pks.filter(p => p.active)), 'soft', 'box'),
      B('Record payment', () => pay(s, sps.filter(p => p.paid_status !== 'paid')), '', 'cash'),
      A('Send booking link', wa(s.phone, `Hi ${first(s.name)}, see your lessons and book here: ${bookUrl(school.slug, s.token)}`), '', 'send'),
      B('Edit', () => editStudent(s), 'ghost', 'edit')),
    s.notes && h('div', { class: 'card' }, h('b', null, 'Notes'), h('pre', null, s.notes)),
    h('h2', null, 'Upcoming'),
    upcoming.length ? h('div', { class: 'list' }, upcoming.map(b => h('button', { class: 'item', onclick: () => bookingSheet(b) },
      icon('calendar'), h('div', { class: 'grow' }, h('b', null, `${dayLabel(b.start_at)} · ${hm(b.start_at)}`),
        h('div', { class: 'tiny' }, `${(b.lesson_types && b.lesson_types.name) || 'Lesson'} · ${staffName(b.staff_id)}`)), icon('more'))))
      : h('p', { class: 'muted' }, 'Nothing booked.'),
    h('h2', null, 'Packages'),
    sps.length ? h('div', { class: 'list' }, sps.map(p => h('div', { class: 'item' }, icon('box'),
      h('div', { class: 'grow' }, h('b', null, p.package_name), h('div', { class: 'tiny' },
        `${p.remaining}/${p.lessons_total} left · ${p.expired ? 'expired' : 'expires ' + fmt(p.expires_at, { day: 'numeric', month: 'short', year: 'numeric' })}`)),
      h('span', { class: 'b ' + (p.paid_status === 'paid' ? 'ok' : 'warn') }, p.paid_status)))) : h('p', { class: 'muted' }, 'No packages.'),
    h('h2', null, 'History'),
    past.length ? h('div', { class: 'list' }, past.map(b => h('div', { class: 'item' },
      h('div', { class: 'grow' }, h('b', null, `${dayLabel(b.start_at)} · ${hm(b.start_at)}`), h('div', { class: 'tiny' }, `${(b.lesson_types && b.lesson_types.name) || 'Lesson'} · ${staffName(b.staff_id)}`)),
      h('span', { class: 'b ' + ({ done: 'ok', no_show: 'bad', cancelled: '' }[b.status] || 'info') }, b.status.replace('_', '-'))))) : h('p', { class: 'muted' }, 'No lessons yet.'),
    h('h2', null, 'Payments'),
    pays.length ? h('div', { class: 'list' }, pays.map(p => h('div', { class: 'item' }, icon(p.method === 'cash' ? 'cash' : p.method === 'eft' ? 'bank' : 'card'),
      h('div', { class: 'grow' }, h('b', null, money(p.amount_cents)), h('div', { class: 'tiny' }, `${dayLabel(p.created_at)} · ${p.method.replace('_', ' ')}${p.note ? ' · ' + p.note : ''}`)))))
      : h('p', { class: 'muted' }, 'No payments recorded.'));
}

function sell(s, pks) {
  if (!pks.length) return toast(isOwner() ? 'Add a package in Settings first' : 'The owner has not set up packages yet', 'bad');
  editor('Sell package', [
    { n: 'package_id', l: 'Package', t: 'select', o: pks.map(p => [p.id, `${p.name} · ${plural(p.lessons, 'lesson')} · ${money(p.price_cents)}`]) },
    { n: 'amount_cents', l: 'Amount received now (R)', t: 'number', cents: 1, hint: 'Leave 0 if they will pay later.' },
    { n: 'method', l: 'Paid by', t: 'select', o: METHODS },
    { n: 'note', l: 'Note' }],
  { amount_cents: pks[0].price_cents },
  async v => {
    const pk = pks.find(p => p.id === v.package_id);
    const sp = ok(await sb.from('student_packages').insert({ student_id: s.student_id, package_id: pk.id, lessons_total: pk.lessons }).select('id').single());
    if (v.amount_cents > 0) {
      ok(await sb.from('payments').insert({ school_id: school.id, student_id: s.student_id, student_package_id: sp.id, amount_cents: v.amount_cents, method: v.method, received_by: me.id, note: v.note }));
    }
  },
  (e, f) => { if (e.target.name === 'package_id') f.amount_cents.value = pks.find(p => p.id === e.target.value).price_cents / 100; });
}

function pay(s, open) {
  editor('Record payment', [
    { n: 'amount_cents', l: 'Amount (R)', t: 'number', cents: 1, req: 1 },
    { n: 'method', l: 'Paid by', t: 'select', o: METHODS },
    { n: 'student_package_id', l: 'For', t: 'select', o: [['', 'Lessons / general'], ...open.map(p => [p.id, `${p.package_name} (${p.paid_status})`])] },
    { n: 'note', l: 'Note' }],
  { amount_cents: s.owing_cents > 0 ? s.owing_cents : null },
  async v => {
    if (!(v.amount_cents > 0)) throw new Error('Enter an amount');
    ok(await sb.from('payments').insert({ ...v, school_id: school.id, student_id: s.student_id, received_by: me.id }));
  });
}

// ───────── Money (owner) ─────────
let moneyRange = 'week';
async function moneyView() {
  const today = ymd(new Date());
  const from = { today, week: mondayOf(today), month: today.slice(0, 8) + '01' }[moneyRange];
  const iso = dayStart(from).toISOString(), todayIso = dayStart(today).toISOString();
  const [pays, cashToday, sold, owing, singles] = (await Promise.all([
    sb.from('payments').select('*, students(name)').gte('created_at', iso).order('created_at', { ascending: false }),
    sb.from('payments').select('amount_cents, received_by').eq('method', 'cash').gte('created_at', todayIso),
    sb.from('student_packages').select('*, packages(name,price_cents), students(name)').gte('bought_at', iso),
    sb.from('student_balance').select('*').gt('owing_cents', 0).order('owing_cents', { ascending: false }).limit(100),
    sb.from('bookings').select('*, lesson_types(name,price_cents), students(name)').in('status', ['done', 'no_show'])
      .is('student_package_id', null).eq('no_charge', false).gte('start_at', iso).order('start_at', { ascending: false })])).map(ok);
  const owingIds = new Set(owing.map(s => s.student_id));
  const unpaid = singles.filter(b => owingIds.has(b.student_id));
  const perStaff = {};
  cashToday.forEach(p => (perStaff[p.received_by] = (perStaff[p.received_by] || 0) + p.amount_cents));
  show(app,
    h('h1', null, 'Money'),
    h('div', { class: 'seg' }, [['today', 'Today'], ['week', 'This week'], ['month', 'This month']].map(([k, t]) =>
      h('button', { class: moneyRange === k ? 'on' : '', onclick: () => { moneyRange = k; route(); } }, t))),
    h('div', { class: 'stats' },
      stat(money(sum(pays.map(p => p.amount_cents))), 'received', 'hero'),
      stat(money(sum(sold.map(p => p.packages && p.packages.price_cents))), `${plural(sold.length, 'package')} sold`),
      stat(money(sum(owing.map(s => s.owing_cents))), 'outstanding'),
      stat(singles.length, 'single lessons')),
    h('h2', null, 'Cash collected today'),
    Object.keys(perStaff).length ? h('div', { class: 'list' }, Object.entries(perStaff).map(([sid, c]) => h('div', { class: 'item' },
      h('div', { class: 'avatar', style: `background:${staffColor(sid)};color:#fff` }, initials(staffName(sid))), h('b', { class: 'grow' }, staffName(sid) || 'Unknown'), h('b', null, money(c)))))
      : h('p', { class: 'muted' }, 'No cash recorded today.'),
    h('h2', null, 'Outstanding balances'),
    owing.length ? h('div', { class: 'list' }, owing.map(s => h('div', { class: 'item' },
      h('a', { class: 'grow', href: '#student/' + s.student_id, style: 'color:inherit;text-decoration:none' }, h('b', null, s.name), h('div', { class: 'tiny' }, localPhone(s.phone))),
      h('b', null, money(s.owing_cents)),
      h('a', { class: 'btn sm ghost', href: wa(s.phone, `Hi ${first(s.name)}, a friendly reminder that ${money(s.owing_cents)} is outstanding for your driving lessons. Thank you!`), target: '_blank', rel: 'noopener', 'aria-label': 'Send payment reminder' }, icon('chat')))))
      : empty('check', 'Nobody owes you', 'All balances are paid up.'),
    h('h2', null, 'Unpaid lessons'),
    unpaid.length ? h('div', { class: 'list' }, unpaid.slice(0, 30).map(b => h('a', { class: 'item', href: '#student/' + b.student_id },
      h('div', { class: 'grow' }, h('b', null, b.students.name), h('div', { class: 'tiny' }, `${dayLabel(b.start_at)} · ${(b.lesson_types && b.lesson_types.name) || 'Lesson'}${b.status === 'no_show' ? ' · no-show' : ''}`)),
      h('b', null, money(b.lesson_types && b.lesson_types.price_cents)))))
      : h('p', { class: 'muted' }, 'None in this period.'),
    h('h2', null, 'Packages sold'),
    sold.length ? h('div', { class: 'list' }, sold.map(p => h('div', { class: 'item' }, icon('box'),
      h('div', { class: 'grow' }, h('b', null, p.students.name), h('div', { class: 'tiny' }, `${p.packages.name} · ${dayLabel(p.bought_at)}`)),
      h('span', { class: 'b ' + (p.paid_status === 'paid' ? 'ok' : 'warn') }, p.paid_status))))
      : h('p', { class: 'muted' }, 'None in this period.'),
    h('h2', null, 'Payments'),
    pays.length ? h('div', { class: 'list' }, pays.slice(0, 50).map(p => h('div', { class: 'item' }, icon(p.method === 'cash' ? 'cash' : p.method === 'eft' ? 'bank' : 'card'),
      h('div', { class: 'grow' }, h('b', null, p.students ? p.students.name : ''), h('div', { class: 'tiny' }, `${dayLabel(p.created_at)} · ${p.method.replace('_', ' ')} · ${staffName(p.received_by)}`)),
      h('b', null, money(p.amount_cents))))) : h('p', { class: 'muted' }, 'None in this period.'));
}

// ───────── Settings (owner) / Me (instructor) ─────────
const ACTIVE = { n: 'active', l: 'Status', t: 'select', bool: 1, o: [['true', 'Active'], ['false', 'Hidden / removed']] };
const crud = (title, table, rows, fields, label, defaults) => h('section', null,
  h('div', { class: 'row' }, h('h2', null, title), B('Add', () => editor('Add', fields, { active: true, ...defaults }, async v => ok(await sb.from(table).insert({ ...v, school_id: school.id }))), 'soft sm', 'plus')),
  rows.length ? h('div', { class: 'list' }, rows.map(r => h('button', { class: 'item', onclick: () => editor('Edit', fields, r, v => upd(table, r.id, v)) }, label(r), icon('right'))))
    : h('p', { class: 'muted' }, 'None yet.'));
const hoursChips = (av, st, editable) => h('div', { class: 'chips' },
  av.filter(a => a.staff_id === st.id).sort((a, b) => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7) || a.start_time.localeCompare(b.start_time)).map(a =>
    h('span', { class: 'chip' }, `${DAYS[a.weekday]} ${a.start_time.slice(0, 5)}–${a.end_time.slice(0, 5)}`,
      editable && h('button', { class: 'x', 'aria-label': 'Remove', onclick: async () => { const { error } = await sb.from('availability').delete().eq('id', a.id); error ? fail(error) : route(); } }, '×'))),
  editable && h('button', { class: 'chip on', onclick: () => addHours(st) }, '+ Hours'));
const linkCard = link => h('div', { class: 'card accent' }, h('b', null, 'Public booking link'),
  h('div', { class: 'mono', style: 'margin-top:8px' }, link),
  h('p', { class: 'tiny' }, 'Share on WhatsApp, Facebook and your Google Business Profile (Edit profile → Bookings).'),
  h('div', { class: 'actions' }, B('Copy link', () => copyText(link, 'Link copied'), 'pri', 'copy'), A('Open', link, '', 'right')));

async function settings() {
  await refs();
  const av = ok(await sb.from('availability').select('*'));
  const link = bookUrl(school.slug);
  const signOut = B('Sign out', () => sb.auth.signOut().then(() => location.reload()), 'ghost big');
  if (!isOwner()) {
    return show(app, h('h1', null, me.name), linkCard(link),
      h('h2', null, 'Your hours'), hoursChips(av, me, false),
      h('p', { class: 'muted' }, 'Ask the owner to change hours, prices or packages.'), signOut);
  }
  const [blocked, pks, allLts] = (await Promise.all([
    sb.from('blocked_times').select('*').gte('end_at', new Date().toISOString()).order('start_at'),
    sb.from('packages').select('*').eq('active', true).order('price_cents'),
    sb.from('lesson_types').select('*').eq('active', true).order('minutes')])).map(ok);
  const schoolEdit = (title, fields) => editor(title, fields, { ...school, whatsapp: localPhone(school.whatsapp) }, async v => {
    if ('whatsapp' in v && v.whatsapp && !(v.whatsapp = normPhone(v.whatsapp))) throw new Error('Enter a valid SA WhatsApp number');
    if ('brand_color' in v && !/^#[0-9a-f]{6}$/i.test(v.brand_color || '')) throw new Error('Pick a colour');
    await upd('schools', school.id, v);
    Object.assign(school, v);
    setBrand(school.brand_color);
  });
  const STAFF = [{ n: 'name', l: 'Name', req: 1 }, { n: 'phone', l: 'WhatsApp number (for daily schedule)', t: 'tel' },
    { n: 'email', l: 'Login email', t: 'email', hint: 'They sign in with this email to see their own lessons.' },
    { n: 'role', l: 'Role', t: 'select', o: [['instructor', 'Instructor (own lessons only)'], ['owner', 'Owner (everything)']] }, ACTIVE];
  const LT = [{ n: 'name', l: 'Name', req: 1, p: '60 min lesson' }, { n: 'minutes', l: 'Length (minutes)', t: 'select', o: [['60', '60 min'], ['90', '90 min'], ['120', '120 min'], ['45', '45 min'], ['30', '30 min']] },
    { n: 'price_cents', l: 'Price (R)', t: 'number', cents: 1, req: 1 }, ACTIVE];
  const PK = [{ n: 'name', l: 'Name', req: 1, p: '10 lesson package' }, { n: 'lessons', l: 'Number of lessons', t: 'number', req: 1 },
    { n: 'price_cents', l: 'Price (R)', t: 'number', cents: 1, req: 1 }, { n: 'valid_days', l: 'Valid for (days)', t: 'number', req: 1 }, ACTIVE];
  const rowInfo = (main, sub) => h('div', { class: 'grow' }, h('b', null, main), h('div', { class: 'tiny' }, sub));

  show(app, h('h1', null, 'Settings'),
    linkCard(link),

    h('h2', null, 'School'),
    h('div', { class: 'list' },
      h('button', { class: 'item', onclick: () => schoolEdit('School & branding', [
        { n: 'name', l: 'School name', req: 1 }, { n: 'whatsapp', l: 'WhatsApp number', t: 'tel' },
        { n: 'brand_color', l: 'Brand colour', t: 'color' }, { n: 'logo_url', l: 'Logo image URL (square, https://…)', t: 'url' }]) },
      h('div', { class: 'avatar', style: `background:${school.brand_color};color:#fff` }, initials(school.name)),
      rowInfo(school.name, `WhatsApp ${school.whatsapp ? localPhone(school.whatsapp) : 'not set'} · logo ${school.logo_url ? 'set' : 'not set'}`), icon('right')),
      h('button', { class: 'item', onclick: () => schoolEdit('Booking rules', [
        { n: 'slot_interval_minutes', l: 'Start times every', t: 'select', o: [['30', '30 minutes'], ['15', '15 minutes'], ['20', '20 minutes'], ['60', '60 minutes']] },
        { n: 'lesson_minutes', l: 'Package lesson length (minutes)', t: 'number', req: 1 },
        { n: 'buffer_minutes', l: 'Travel buffer between lessons (minutes)', t: 'number', req: 1 },
        { n: 'min_notice_hours', l: 'Minimum notice for online booking (hours)', t: 'number', req: 1 },
        { n: 'cancel_cutoff_hours', l: 'Students can cancel/move up to (hours before)', t: 'number', req: 1 },
        { n: 'no_show_rule', l: 'No-show rule', t: 'select', o: [['credit', 'Use a package lesson (or owe the price)'], ['owe', 'Always owe the lesson price'], ['free', 'No charge']] }]) },
      icon('clock'), rowInfo('Booking rules', `Every ${school.slot_interval_minutes} min · ${school.buffer_minutes} min buffer · ${school.min_notice_hours}h notice · cancel ${school.cancel_cutoff_hours}h before`), icon('right')),
      h('button', { class: 'item', onclick: () => schoolEdit('Payment details', [
        { n: 'eft_details', l: 'EFT details (shown after booking)', t: 'textarea', p: 'Bank, account holder, account no., branch code' },
        { n: 'card_link', l: 'Card payment link', t: 'url', p: 'https://pay.yoco.com/… or similar' }]) },
      icon('bank'), rowInfo('Payment details', `EFT ${school.eft_details ? 'set' : 'not set'} · card link ${school.card_link ? 'set' : 'not set'}`), icon('right'))),

    h('div', { class: 'row' }, h('h2', null, 'Instructors & hours'), B('Add', () => editor('Add instructor', STAFF, { role: 'instructor', active: true },
      async v => ok(await sb.from('staff').insert({ ...v, school_id: school.id }))), 'soft sm', 'plus')),
    staffList.map(st => h('div', { class: 'card' + (st.active ? '' : ' dim'), style: `border-left:4px solid ${staffColor(st.id)}` },
      h('div', { class: 'row' }, rowInfo(st.name, `${st.role}${st.auth_user_id ? '' : ' · not signed in yet'}${st.phone ? ' · ' + st.phone : ''}`),
        B('', () => editor('Edit instructor', STAFF, st, v => upd('staff', st.id, v)), 'ghost sm', 'edit')),
      hoursChips(av, st, true))),

    h('div', { class: 'row' }, h('h2', null, 'Time off & holidays'), B('Add', addBlock, 'soft sm', 'plus')),
    blocked.length ? h('div', { class: 'list' }, blocked.map(x => h('div', { class: 'item' }, icon('x'),
      rowInfo(x.reason || 'Blocked', `${x.staff_id ? staffName(x.staff_id) : 'Whole school'} · ${dayLabel(x.start_at)} ${hm(x.start_at)} → ${dayLabel(x.end_at)} ${hm(x.end_at)}`),
      h('button', { class: 'btn ghost sm', 'aria-label': 'Remove', onclick: async () => { const { error } = await sb.from('blocked_times').delete().eq('id', x.id); error ? fail(error) : route(); } }, icon('x')))))
      : h('p', { class: 'muted' }, 'No upcoming leave or holidays.'),

    crud('Lesson types', 'lesson_types', allLts, LT, r => rowInfo(r.name, `${r.minutes} min · ${money(r.price_cents)}`), { minutes: 60 }),
    crud('Packages', 'packages', pks, PK, r => rowInfo(r.name, `${plural(r.lessons, 'lesson')} · ${money(r.price_cents)} · valid ${r.valid_days} days`), { valid_days: 180 }),

    h('h2', null, 'Account'), h('p', { class: 'muted' }, `Signed in as ${me.name} (owner)`), signOut);
}

const addHours = st => editor('Add hours: ' + st.name, [
  { n: 'days', l: 'Days', t: 'select', o: [['1,2,3,4,5', 'Mon–Fri'], ['1,2,3,4,5,6', 'Mon–Sat'], ['6', 'Saturday'], ['0', 'Sunday'], ['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday']] },
  { n: 'start_time', l: 'From', t: 'time', req: 1 }, { n: 'end_time', l: 'To', t: 'time', req: 1 }],
{ start_time: '08:00', end_time: '17:00' },
async v => {
  if (v.end_time <= v.start_time) throw new Error('"To" must be after "From"');
  ok(await sb.from('availability').insert(v.days.split(',').map(d => ({ staff_id: st.id, weekday: +d, start_time: v.start_time, end_time: v.end_time }))));
});

function addBlock() {
  const t = ymd(new Date());
  editor('Add time off', [
    { n: 'staff_id', l: 'Who', t: 'select', o: [['', 'Whole school (holiday)'], ...staffList.filter(s => s.active).map(s => [s.id, s.name])] },
    { n: 'from', l: 'From', t: 'datetime-local', req: 1 }, { n: 'to', l: 'To', t: 'datetime-local', req: 1 },
    { n: 'reason', l: 'Reason', p: 'Leave, public holiday, car service…' }],
  { from: t + 'T00:00', to: t + 'T23:59' },
  async v => {
    const start = new Date(v.from + ':00' + OFF), end = new Date(v.to + ':00' + OFF);
    if (!(end > start)) throw new Error('"To" must be after "From"');
    ok(await sb.from('blocked_times').insert({ school_id: school.id, staff_id: v.staff_id, start_at: start.toISOString(), end_at: end.toISOString(), reason: v.reason }));
  });
}

sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT' && me) location.reload(); });
start().catch(e => show(app, empty('alert', 'Could not start', e.message || String(e))));
