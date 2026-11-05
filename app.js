// Admin / instructor app. Uses lib.js helpers (sb, h, show, A, B, money, wa, ...).
let me, school;
const app = $('#app'), nav = $('nav');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const METHODS = [['cash', 'Cash'], ['eft', 'EFT'], ['card_link', 'Card'], ['other', 'Other']];
const addr = b => b.pickup_address || b.students.pickup_address || '';

const ok = ({ data, error }) => {
  if (error) {
    if (error.code === '23505') error.message = 'That already exists (the link name or phone number is taken).';
    throw error;
  }
  return data;
};
const fail = e => toast(e.message || String(e));
const upd = async (table, id, v) => ok(await sb.from(table).update(v).eq('id', id));

// ───────── generic UI: modal + form built from a field list ─────────
function modal(title, ...kids) {
  const m = h('div', { class: 'modal', onclick: e => e.target === m && m.remove() },
    h('div', { class: 'sheet' }, h('header', null, h('h2', null, title), B('✕', () => m.remove(), 'ghost')), kids));
  document.body.append(m);
  return m;
}
// field: {n:name, l:label, t:type|'select'|'textarea', o:[[value,label]], req, cents (Rand<->cents), bool, v:default}
function formEl(fields, init, save, o = {}) {
  const f = h('form', { class: 'form' },
    fields.map(x => {
      let v = init[x.n] ?? x.v;
      if (x.cents && v != null) v /= 100;
      const el = x.t === 'select'
        ? h('select', { name: x.n, value: String(v ?? '') }, x.o.map(([val, txt]) => h('option', { value: val }, txt)))
        : h(x.t === 'textarea' ? 'textarea' : 'input', { name: x.n, rows: 3, type: x.t === 'textarea' ? null : x.t || 'text', value: v, required: x.req, placeholder: x.p, step: x.t === 'number' ? 'any' : null });
      return h('label', null, x.l, el);
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
    const btn = f.querySelector('button');
    btn.disabled = true;
    try { await save(v); o.done && o.done(); } catch (er) { f.querySelector('.err').textContent = er.message || er; btn.disabled = false; }
  };
  return f;
}
const editor = (title, fields, init, save, change) => {
  const m = modal(title, formEl(fields, init || {}, save, { change, done: () => { m.remove(); route(); } }));
};

// ───────── auth + boot ─────────
async function start() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return loginView();
  await sb.rpc('claim_staff');
  const { data, error } = await sb.from('staff').select('*, schools(*)')
    .eq('auth_user_id', session.user.id).eq('active', true).limit(1).maybeSingle();
  if (error) return show(app, h('p', { class: 'err' }, error.message));
  if (!data) return onboarding();
  me = data; school = data.schools;
  nav.hidden = false;
  if (location.hash.includes('access_token')) location.hash = '#today';
  route();
}

function loginView() {
  nav.hidden = true;
  const msg = h('p', { class: 'muted' }, 'We email you a sign-in link. No password needed.');
  show(app, h('h1', null, 'Driving school'),
    formEl([{ n: 'email', l: 'Your email', t: 'email', req: 1 }], {},
      async v => ok(await sb.auth.signInWithOtp({ email: v.email, options: { emailRedirectTo: location.origin + location.pathname } })),
      { btn: 'Email me a sign-in link', done: () => { msg.textContent = 'Check your email and tap the link ✉️'; } }),
    msg);
}

function onboarding() {
  nav.hidden = true;
  const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  show(app, h('h1', null, 'Set up your driving school'),
    formEl([
      { n: 'name', l: 'School name', req: 1 },
      { n: 'slug', l: 'Booking link name (letters, numbers, dashes)', req: 1, p: 'my-driving-school' },
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
    }));
}

// ───────── router ─────────
const views = { today: () => day(0), tomorrow: () => day(1), students, student, settings };
function route() {
  if (!me) return;
  const [name, arg] = (location.hash.slice(1) || 'today').split('/');
  const v = views[name] || views.today;
  nav.querySelectorAll('a').forEach(a => a.classList.toggle('on', a.hash === '#' + (name === 'student' ? 'students' : name)));
  v(arg).catch(e => show(app, h('p', { class: 'err' }, e.message || String(e))));
}
window.addEventListener('hashchange', route);

// ───────── Today / Tomorrow ─────────
const badges = s => h('div', { class: 'badges' },
  s && s.owing_cents > 0 ? h('span', { class: 'b warn' }, 'Owes ' + money(s.owing_cents)) : h('span', { class: 'b ok' }, 'Paid'),
  s && s.credits > 0 ? h('span', { class: 'b info' }, `Package ${s.credits} left`) : null);

async function day(offset) {
  const d = addDays(ymd(new Date()), offset);
  let q = sb.from('bookings').select('*, students(name,phone,token,pickup_address), lesson_types(name)')
    .gte('start_at', dayStart(d).toISOString()).lt('start_at', dayStart(addDays(d, 1)).toISOString())
    .neq('status', 'cancelled').order('start_at');
  if (me.role === 'instructor') q = q.eq('staff_id', me.id);
  const bs = ok(await q);
  const ids = [...new Set(bs.map(b => b.student_id))];
  const bal = ids.length ? ok(await sb.from('student_balance').select('*').in('student_id', ids)) : [];
  const bm = Object.fromEntries(bal.map(s => [s.student_id, s]));
  const stops = bs.filter(b => b.status === 'booked' && addr(b)).map(addr);
  show(app,
    h('h1', null, `${offset ? 'Tomorrow' : 'Today'}: ${plural(bs.length, 'lesson')}`),
    !offset && stops.length ? B('Route all pickups', () => routeAll(stops), 'pri') : null,
    bs.length ? bs.map(b => card(b, bm[b.student_id], offset)) : h('p', { class: 'muted' }, 'Nothing booked.'));
}

function card(b, bal, offset) {
  const s = b.students, a = addr(b), live = b.status === 'booked';
  const msg = `Hi ${first(s.name)}, reminder: driving lesson ${offset ? 'tomorrow' : 'today'} at ${hm(b.start_at)}. ` +
    `Pickup: ${a || 'to be confirmed'}. Reply if you need to change. ${bookUrl(school.slug, s.token)}`;
  return h('article', { class: 'card' + (live ? '' : ' dim') },
    h('div', { class: 'time' }, hm(b.start_at), ' ', h('small', null, b.lesson_types?.name || '')),
    h('a', { class: 'name', href: '#student/' + b.student_id }, s.name),
    a ? h('div', { class: 'addr' }, a) : null,
    badges(bal),
    live ? null : h('div', { class: 'b' }, b.status === 'done' ? '✓ Done' : '✗ No-show'),
    live ? h('div', { class: 'actions' },
      !offset && a ? A('Navigate', `https://www.google.com/maps/dir/?api=1&destination=${enc(a)}&travelmode=driving`) : null,
      A(offset ? 'Send reminder' : 'Remind', wa(s.phone, msg)),
      offset ? null : [B('Done', () => finish(b, 'done'), 'pri'), B('No-show', () => finish(b, 'no_show'))],
      B('Cancel', () => cancel(b), 'ghost')) : null);
}

// Done: set status, charge a package if the student has credits (all inside complete_booking), then WhatsApp.
async function finish(b, status) {
  if (status === 'no_show' && !confirm('Mark as no-show? A package lesson will be used.')) return;
  const { data, error } = await sb.rpc('complete_booking', { p_id: b.id, p_status: status });
  if (error) return fail(error);
  if (status === 'done') {
    const n = data.credits;
    openWA(wa(data.phone, `Thanks ${first(data.name)}! Great lesson today. ` +
      (n > 0 ? `You have ${plural(n, 'lesson')} left. ` : '') +
      `Book your next one here: ${bookUrl(data.slug, data.token)}`));
  }
  route();
}
async function cancel(b) {
  if (!confirm(`Cancel ${b.students.name} at ${hm(b.start_at)}?`)) return;
  await upd('bookings', b.id, { status: 'cancelled' }).then(route, fail);
}
// window.open can be blocked after an async call; fall back to a real link the user taps
function openWA(url) {
  if (window.open(url, '_blank')) return;
  modal('Send WhatsApp', A('Open WhatsApp', url, 'pri'));
}

// Google Maps accepts few waypoints on mobile: up to 4 stops per link (3 waypoints + destination)
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
    legs.push(A(`Leg ${legs.length + 1}: stops ${i + 1}–${i + c.length}`, routeUrl(origin, c), 'pri'));
    origin = c[c.length - 1];
  }
  modal('Route all pickups',
    h('p', null, `${stops.length} stops. Google Maps on mobile may only accept 3 waypoints, so the full route can get cut off. Use the legs below, one after the other.`),
    legs, A('Try the full route anyway', routeUrl('My Location', stops)));
}

// ───────── Students ─────────
async function students() {
  const list = h('div');
  const load = async q => {
    q = (q || '').replace(/[,()%*]/g, ' ').trim();
    if (/^[\d\s+]+$/.test(q)) q = q.replace(/\D/g, '').replace(/^0/, '27');
    let r = sb.from('student_balance').select('*').order('name').limit(50);
    if (q) r = r.or(`name.ilike.%${q}%,phone.ilike.%${q}%`);
    const rows = ok(await r);
    show(list, rows.length ? rows.map(s => h('a', { class: 'card row', href: '#student/' + s.student_id },
      h('div', null, h('b', null, s.name), h('div', { class: 'muted' }, '+' + s.phone)), badges(s))) : h('p', { class: 'muted' }, 'No students found.'));
  };
  let t;
  show(app, h('h1', null, 'Students'),
    h('input', { type: 'search', placeholder: 'Search name or phone', oninput: e => { clearTimeout(t); t = setTimeout(() => load(e.target.value).catch(fail), 250); } }),
    B('+ Add student', () => editStudent()), list);
  await load();
}

const editStudent = (s = {}) => editor(s.student_id ? 'Edit student' : 'Add student', [
  { n: 'name', l: 'Name', req: 1 },
  { n: 'phone', l: 'WhatsApp number', t: 'tel', req: 1 },
  { n: 'pickup_address', l: 'Pickup address' },
  { n: 'notes', l: 'Notes', t: 'textarea' }],
{ ...s, phone: s.phone ? '0' + s.phone.slice(2) : '' },
async v => {
  v.phone = normPhone(v.phone);
  if (!v.phone) throw new Error('Enter a valid SA number');
  ok(s.student_id ? await sb.from('students').update(v).eq('id', s.student_id) : await sb.from('students').insert({ ...v, school_id: school.id }));
});

async function student(id) {
  const [s, bs, pays, sps, pks] = (await Promise.all([
    sb.from('student_balance').select('*').eq('student_id', id).maybeSingle(),
    sb.from('bookings').select('start_at,status,lesson_types(name)').eq('student_id', id).order('start_at', { ascending: false }).limit(15),
    sb.from('payments').select('*').eq('student_id', id).order('created_at', { ascending: false }).limit(10),
    sb.from('package_left').select('*').eq('student_id', id).order('bought_at', { ascending: false }),
    sb.from('packages').select('*').order('price_cents')])).map(ok);
  if (!s) throw new Error('Student not found');
  const pname = Object.fromEntries(pks.map(p => [p.id, p.name]));
  show(app,
    h('a', { href: '#students' }, '← Students'),
    h('h1', null, s.name),
    h('p', null, h('a', { href: wa(s.phone, `Hi ${first(s.name)}, `), target: '_blank', rel: 'noopener' }, '+' + s.phone), s.pickup_address ? ' · ' + s.pickup_address : ''),
    s.notes ? h('p', { class: 'muted' }, s.notes) : null,
    badges(s),
    h('div', { class: 'actions' },
      B('Sell package', () => sell(s, pks.filter(p => p.active)), 'pri'),
      B('Record payment', () => pay(s, sps.filter(p => p.paid_status !== 'paid'), pname)),
      A('Send booking link', wa(s.phone, `Hi ${first(s.name)}, book your next lesson here: ${bookUrl(school.slug, s.token)}`)),
      B('Edit', () => editStudent(s), 'ghost')),
    h('h2', null, 'Packages'),
    sps.length ? sps.map(p => h('div', { class: 'card row' }, pname[p.package_id] || 'Package',
      h('span', { class: 'muted' }, `${p.remaining}/${p.lessons_total} left · ${p.paid_status}`))) : h('p', { class: 'muted' }, 'None'),
    h('h2', null, 'Lessons'),
    bs.length ? bs.map(b => h('div', { class: 'card row' }, `${dayLabel(b.start_at)} ${hm(b.start_at)} · ${b.lesson_types?.name || ''}`, h('span', { class: 'muted' }, b.status))) : h('p', { class: 'muted' }, 'None'),
    h('h2', null, 'Payments'),
    pays.length ? pays.map(p => h('div', { class: 'card row' }, `${dayLabel(p.created_at)} · ${p.method}${p.note ? ' · ' + p.note : ''}`, h('b', null, money(p.amount_cents)))) : h('p', { class: 'muted' }, 'None'));
}

function sell(s, pks) {
  if (!pks.length) return toast('Add a package in Settings first');
  editor('Sell package', [
    { n: 'package_id', l: 'Package', t: 'select', o: pks.map(p => [p.id, `${p.name} · ${plural(p.lessons, 'lesson')} · ${money(p.price_cents)}`]) },
    { n: 'amount_cents', l: 'Amount received now (R)', t: 'number', cents: 1 },
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

function pay(s, open, pname) {
  editor('Record payment', [
    { n: 'amount_cents', l: 'Amount (R)', t: 'number', cents: 1, req: 1 },
    { n: 'method', l: 'Paid by', t: 'select', o: METHODS },
    { n: 'student_package_id', l: 'For', t: 'select', o: [['', 'Lessons / general'], ...open.map(p => [p.id, `${pname[p.package_id] || 'Package'} (${p.paid_status})`])] },
    { n: 'note', l: 'Note' }],
  { amount_cents: s.owing_cents > 0 ? s.owing_cents : null },
  async v => {
    if (!(v.amount_cents > 0)) throw new Error('Enter an amount');
    ok(await sb.from('payments').insert({ ...v, school_id: school.id, student_id: s.student_id, received_by: me.id }));
  });
}

// ───────── Settings ─────────
const ACTIVE = { n: 'active', l: 'Status', t: 'select', bool: 1, o: [['true', 'Active'], ['false', 'Hidden / removed']] };
const copy = async t => { try { await navigator.clipboard.writeText(t); toast('Link copied'); } catch { prompt('Copy this link', t); } };

// one list+editor block for lesson types and packages
const crud = (title, table, rows, fields, label, defaults) => h('section', null, h('h2', null, title),
  rows.map(r => h('button', { class: 'card row', onclick: () => editor('Edit', fields, r, v => upd(table, r.id, v)) }, label(r))),
  B('+ Add', () => editor('Add', fields, { active: true, ...defaults }, async v => ok(await sb.from(table).insert({ ...v, school_id: school.id })))));

async function settings() {
  const [staff, av, lts, pks] = (await Promise.all([
    sb.from('staff').select('*').order('name'),
    sb.from('availability').select('*').order('start_time'),
    sb.from('lesson_types').select('*').eq('active', true).order('price_cents'),
    sb.from('packages').select('*').eq('active', true).order('price_cents')])).map(ok);
  const link = bookUrl(school.slug);
  const STAFF = [
    { n: 'name', l: 'Name', req: 1 }, { n: 'phone', l: 'Phone', t: 'tel' },
    { n: 'email', l: 'Login email (so they can sign in)', t: 'email' },
    { n: 'role', l: 'Role', t: 'select', o: [['instructor', 'Instructor'], ['owner', 'Owner']] }, ACTIVE];
  const SCHOOL = [
    { n: 'name', l: 'School name', req: 1 }, { n: 'whatsapp', l: 'WhatsApp number', t: 'tel' },
    { n: 'lesson_minutes', l: 'Default lesson length for packages (minutes)', t: 'number', req: 1 },
    { n: 'slot_interval_minutes', l: 'Start times every (minutes)', t: 'select', o: [['30', '30 min'], ['15', '15 min'], ['60', '60 min']] },
    { n: 'buffer_minutes', l: 'Travel buffer between lessons (minutes)', t: 'number' },
    { n: 'min_notice_hours', l: 'Minimum notice for online booking (hours)', t: 'number' },
    { n: 'eft_details', l: 'EFT details (shown after booking)', t: 'textarea', p: 'Bank, account no., branch code' },
    { n: 'card_link', l: 'Card payment link (https://…)', t: 'url' }];
  const LT = [{ n: 'name', l: 'Name', req: 1 }, { n: 'minutes', l: 'Minutes', t: 'number', req: 1 },
    { n: 'price_cents', l: 'Price (R)', t: 'number', cents: 1, req: 1 }, ACTIVE];
  const PK = [{ n: 'name', l: 'Name', req: 1 }, { n: 'lessons', l: 'Number of lessons', t: 'number', req: 1 },
    { n: 'price_cents', l: 'Price (R)', t: 'number', cents: 1, req: 1 }, ACTIVE];

  show(app, h('h1', null, 'Settings'),
    h('div', { class: 'card' }, h('b', null, 'Your booking link'),
      h('div', { class: 'mono' }, link),
      h('small', null, 'Share it on WhatsApp and add it to your Google Business Profile (Edit profile → Bookings).'),
      h('div', { class: 'actions' }, B('Copy link', () => copy(link), 'pri'), A('Open', link))),

    h('h2', null, 'School'),
    h('div', { class: 'card' }, h('b', null, school.name), h('div', { class: 'muted' },
      `WhatsApp: ${school.whatsapp ? '+' + school.whatsapp : '—'} · ${school.lesson_minutes} min slots`),
    h('pre', null, school.eft_details || 'No EFT details yet'),
    h('div', null, school.card_link ? 'Card link set ✓' : 'No card link yet'),
    B('Edit school', () => editor('School details', SCHOOL, { ...school, whatsapp: school.whatsapp ? '0' + school.whatsapp.slice(2) : '' },
      async v => {
        if (v.whatsapp && !(v.whatsapp = normPhone(v.whatsapp))) throw new Error('Enter a valid SA WhatsApp number');
        await upd('schools', school.id, v);
        Object.assign(school, v);
      }))),

    h('h2', null, 'Instructors & hours'),
    staff.map(st => h('div', { class: 'card' + (st.active ? '' : ' dim') },
      h('button', { class: 'link', onclick: () => editor('Edit staff', STAFF, st, v => upd('staff', st.id, v)) },
        h('b', null, st.name), h('span', { class: 'muted' }, st.role + (st.auth_user_id ? '' : ' · not signed in'))),
      h('div', { class: 'chips' },
        av.filter(a => a.staff_id === st.id).sort((a, b) => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7)).map(a =>
          h('span', { class: 'chip' }, `${DAYS[a.weekday]} ${a.start_time.slice(0, 5)}–${a.end_time.slice(0, 5)}`,
            h('button', { 'aria-label': 'Remove', onclick: async () => { await sb.from('availability').delete().eq('id', a.id).then(route); } }, '×'))),
        h('button', { class: 'chip add', onclick: () => addHours(st) }, '+ Hours')))),
    B('+ Add instructor', () => editor('Add staff', STAFF, { role: 'instructor', active: true },
      async v => ok(await sb.from('staff').insert({ ...v, school_id: school.id })))),

    crud('Lesson types', 'lesson_types', lts, LT, r => [h('b', null, r.name), h('span', { class: 'muted' }, `${r.minutes} min · ${money(r.price_cents)}`)], { minutes: 60 }),
    crud('Packages', 'packages', pks, PK, r => [h('b', null, r.name), h('span', { class: 'muted' }, `${plural(r.lessons, 'lesson')} · ${money(r.price_cents)}`)], {}),

    h('h2', null, 'Account'),
    B('Sign out', () => sb.auth.signOut().then(() => location.reload()), 'ghost'));
}

const addHours = st => editor('Add hours: ' + st.name, [
  { n: 'days', l: 'Days', t: 'select', o: [['1,2,3,4,5', 'Mon–Fri'], ['1,2,3,4,5,6', 'Mon–Sat'], ['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday'], ['0', 'Sunday']] },
  { n: 'start_time', l: 'From', t: 'time', req: 1 }, { n: 'end_time', l: 'To', t: 'time', req: 1 }],
{ start_time: '08:00', end_time: '16:00' },
async v => {
  if (v.end_time <= v.start_time) throw new Error('"To" must be after "From"');
  ok(await sb.from('availability').insert(v.days.split(',').map(d => ({ staff_id: st.id, weekday: +d, start_time: v.start_time, end_time: v.end_time }))));
});

sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT' && me) location.reload(); });
start().catch(e => show(app, h('p', { class: 'err' }, e.message || String(e))));
