// Public student booking page + student self-service (?p=token). Uses lib.js helpers.
// Talks to Supabase only through the public SECURITY DEFINER RPCs.
const root = $('#app'), Q = new URLSearchParams(location.search), slug = Q.get('s');
const S = { sch: null, item: null, day: null, staff: '', slot: null, stu: null, name: '', phone: '', pickup: '', hp: '', move: null };
const tokKey = 'tok_' + slug;
const store = {
  get: () => { try { return localStorage.getItem(tokKey); } catch { return null; } },
  set: v => { try { v ? localStorage.setItem(tokKey, v) : localStorage.removeItem(tokKey); } catch { /* private mode */ } }
};
let token = Q.get('p') || store.get();

// ───────── small view helpers ─────────
const STEPS = ['Lesson', 'Time', 'Details', 'Confirm'];
const steps = n => h('div', { class: 'steps', 'aria-label': `Step ${n + 1} of 4` },
  STEPS.map((t, i) => h('div', { class: i < n ? 'done' : i === n ? 'on' : '' }, t)));
const back = fn => h('button', { class: 'back', onclick: fn }, icon('left'), 'Back');
const cta = (sum, btn) => {
  const old = $('#cta');
  if (old) old.remove();
  if (btn) document.body.append(h('div', { class: 'cta', id: 'cta' }, h('div', { class: 'in' }, sum && h('div', { class: 'sum' }, sum), btn)));
};
const view = (...kids) => { cta(); show(root, ...kids); scrollTo(0, 0); };
const fatal = msg => view(h('div', { class: 'panel' }, empty('alert', 'Oops', msg)));
const instructorName = id => (S.sch.instructors.find(i => i.id === id) || {}).name || '';
const lessonItem = l => ({ kind: 'lt', id: l.id, name: l.name, minutes: l.minutes, price: l.price_cents });
const defaultLesson = () => {
  const ls = S.sch.lesson_types;
  return ls.find(x => x.minutes === S.sch.lesson_minutes) || ls[0];
};
const whenText = d => `${dayLabel(d)} · ${hm(d)}`;

// ───────── start ─────────
(async () => {
  if (!slug) return fatal('This booking link is missing the school name.');
  show(root, skeleton(3));
  const { data: sch, error } = await sb.rpc('get_school_public', { p_slug: slug });
  if (error) return fatal('Could not load the booking page. Check your connection and try again.');
  if (!sch) return fatal('School not found. Please check the link.');
  S.sch = sch;
  setBrand(sch.brand_color);
  $('#title').textContent = sch.name;
  document.title = 'Book a lesson · ' + sch.name;
  if (sch.logo_url) { const l = $('#logo'); l.src = sch.logo_url; l.hidden = false; }
  if (token) await loadStudent();
  S.stu ? home() : choose();
})().catch(e => fatal(e.message || String(e)));

async function loadStudent() {
  const { data } = await sb.rpc('get_student_summary', { p_token: token });
  if (!data) { token = null; store.set(null); S.stu = null; return; }
  S.stu = data;
  store.set(token);
  S.name = S.name || data.name;
  S.phone = S.phone || localPhone(data.phone);
  S.pickup = S.pickup || data.pickup_address || '';
}

// ───────── student self-service home ─────────
function home() {
  const u = S.stu, l = defaultLesson();
  const pkg = u.packages[0];
  const testIn = u.test_date ? daysUntil(u.test_date) : null;
  const bookNext = () => { S.move = null; S.from = 'home'; S.item = lessonItem(l); pickTime(); };
  view(
    h('div', { class: 'panel' },
      h('h2', { style: 'margin-top:0' }, `Hi ${first(u.name)} 👋`),
      h('div', { class: 'stats' },
        h('div', { class: 'stat hero' }, h('div', { class: 'v' }, u.credits), h('div', { class: 'l' }, u.credits === 1 ? 'lesson left' : 'lessons left')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, u.upcoming.length), h('div', { class: 'l' }, 'booked')),
        pkg && h('div', { class: 'stat' }, h('div', { class: 'v', style: 'font-size:1.05rem' }, fmt(pkg.expires_at, { day: 'numeric', month: 'short', year: 'numeric' })), h('div', { class: 'l' }, 'package expires')),
        testIn != null && testIn >= 0 && h('div', { class: 'stat' }, h('div', { class: 'v' }, testIn === 0 ? 'Today!' : testIn), h('div', { class: 'l' }, testIn === 0 ? 'K53 test' : `days to K53 test${u.test_venue ? ' · ' + u.test_venue : ''}`))),
      l && B('Book next lesson', bookNext, 'pri big', 'calendar')),
    h('h2', null, 'Upcoming lessons'),
    u.upcoming.length ? u.upcoming.map(b => h('div', { class: 'card accent' },
      h('div', { class: 'row' }, h('div', null, h('b', null, whenText(b.start_at)), h('div', { class: 'muted' }, `${b.lesson || 'Lesson'} · ${b.instructor}`))),
      b.can_change
        ? h('div', { class: 'actions' }, B('Reschedule', () => startMove(b), 'soft sm', 'clock'), B('Cancel', () => cancelOwn(b), 'danger sm', 'x'))
        : h('div', null, h('p', { class: 'tiny' }, `Less than ${u.cancel_cutoff_hours} hours to go. To change it, message the school.`),
          S.sch.whatsapp && A('WhatsApp the school', wa(S.sch.whatsapp, `Hi, it's ${u.name}. About my lesson ${whenText(b.start_at)}: `), 'sm', 'chat'))))
      : h('div', { class: 'panel' }, empty('calendar', 'No lessons booked', 'Tap "Book next lesson" to pick a time.')),
    B('Buy a package or choose another lesson', () => { S.move = null; choose(); }, 'ghost big'));
  if (l) cta(null, B('Book next lesson', bookNext, 'pri', 'calendar'));
}

async function cancelOwn(b) {
  if (!await confirmSheet('Cancel this lesson?', `${whenText(b.start_at)} with ${b.instructor}`, 'Yes, cancel it', 'danger solid')) return;
  const { error } = await sb.rpc('student_cancel', { p_token: token, p_booking: b.id });
  if (error) return toast(error.message, 'bad');
  toast('Lesson cancelled', 'ok');
  await loadStudent();
  home();
}
function startMove(b) {
  S.move = b;
  S.from = 'home';
  S.item = { kind: 'move', name: b.lesson || 'Lesson', minutes: Math.round((new Date(b.end_at) - new Date(b.start_at)) / 6e4), price: null };
  S.staff = b.staff_id;
  S.day = ymd(b.start_at);
  pickTime();
}

// ───────── step 1: lesson or package ─────────
function choose() {
  const { lesson_types: ls, packages: ps } = S.sch;
  const single = defaultLesson();
  const pick = it => { S.item = it; S.from = 'choose'; pickTime(); };
  view(
    h('div', { class: 'panel' }, steps(0),
      S.stu && back(home),
      ls.length ? h('h2', { style: 'margin-top:0' }, 'Choose a lesson') : empty('calendar', 'Not open for online booking yet', 'Please WhatsApp the school.'),
      ls.map(l => h('button', { class: 'opt', onclick: () => pick(lessonItem(l)) },
        icon('clock', 'lg'), h('div', { class: 'grow' }, h('b', null, l.name), h('small', { class: 'muted' }, `${l.minutes} minutes`)),
        h('div', { class: 'price' }, money(l.price_cents)))),
      ps.length ? [h('h2', null, 'Save with a package'), ps.map(p => {
        const save = single ? single.price_cents * p.lessons - p.price_cents : 0;
        return h('button', { class: 'opt', onclick: () => pick({ kind: 'pkg', id: p.id, name: p.name, minutes: S.sch.lesson_minutes, price: p.price_cents }) },
          icon('box', 'lg'), h('div', { class: 'grow' }, h('b', null, p.name),
            h('small', { class: 'muted' }, `${plural(p.lessons, 'lesson')} · valid ${p.valid_days} days · book your first now`),
            save > 0 && h('small', { class: 'save' }, `Save ${money(save)} vs single lessons`)),
          h('div', { class: 'price' }, money(p.price_cents)));
      })] : null));
}

// ───────── step 2: date strip + slots ─────────
function pickTime() {
  const today = ymd(new Date());
  if (!S.day || S.day < today) S.day = today;
  S.slot = null;
  const box = h('div', null, skeleton(2));
  const ins = S.sch.instructors;
  view(
    h('div', { class: 'panel' }, S.move ? null : steps(1),
      back(S.stu && S.from === 'home' ? home : choose),
      h('h2', { style: 'margin-top:8px' }, S.move ? 'Pick a new time' : 'Pick a time'),
      h('p', { class: 'muted' }, S.item.name, S.item.price != null ? ' · ' + money(S.item.price) : '', ` · ${S.item.minutes} min`),
      ins.length > 1 ? h('label', null, 'Instructor', h('select', { value: S.staff, onchange: e => { S.staff = e.target.value; pickTime(); } },
        h('option', { value: '' }, 'Any instructor'), ins.map(i => h('option', { value: i.id }, i.name)))) : null,
      h('div', { class: 'strip', style: 'margin-top:16px' }, Array.from({ length: 14 }, (_, i) => {
        const d = addDays(today, i);
        return h('button', { class: 'day' + (d === S.day ? ' on' : ''), 'aria-pressed': d === S.day ? 'true' : 'false', onclick: () => { S.day = d; pickTime(); } },
          i === 0 ? 'Today' : fmt(dayStart(d), { weekday: 'short' }), h('b', null, +d.slice(8)), fmt(dayStart(d), { month: 'short' }));
      })),
      box));
  const on = root.querySelector('.day.on');
  if (on) on.scrollIntoView({ inline: 'center', block: 'nearest' });
  sb.rpc('get_free_slots', { p_slug: slug, p_date: S.day, p_staff: S.staff || null, p_minutes: S.item.minutes }).then(({ data, error }) => {
    if (error) return show(box, h('p', { class: 'err' }, 'Could not load times. Please try again.'));
    const seen = new Set();
    const list = data.filter(x => !seen.has(x.slot_start) && seen.add(x.slot_start)); // "any instructor": one button per time
    if (!list.length) return show(box, empty('calendar', 'No free times this day', 'Try another day.'));
    const groups = {};
    list.forEach(x => (groups[partOfDay(x.slot_start)] = groups[partOfDay(x.slot_start)] || []).push(x));
    show(box, ['Morning', 'Afternoon', 'Evening'].filter(g => groups[g]).map(g => [
      h('h3', null, g),
      h('div', { class: 'slots' }, groups[g].map(x => h('button', {
        class: 'slot', onclick: e => {
          box.querySelectorAll('.slot.on').forEach(b => b.classList.remove('on'));
          e.currentTarget.classList.add('on');
          S.slot = { start: x.slot_start, staff: x.staff_id, staffName: x.staff_name };
          cta(h('span', null, h('b', null, whenText(x.slot_start)), x.staff_name),
            S.move ? B('Move lesson', doMove, 'pri', 'check') : B('Continue', details, 'pri', 'right'));
        }
      }, hm(x.slot_start))))]));
  });
}

async function doMove() {
  const b = S.move;
  if (!await confirmSheet('Move your lesson?', `From ${whenText(b.start_at)} to ${whenText(S.slot.start)} with ${S.slot.staffName}.`, 'Yes, move it')) return;
  const { error } = await sb.rpc('student_reschedule', { p_token: token, p_booking: b.id, p_start: S.slot.start, p_staff: S.slot.staff });
  if (error) { toast(error.message, 'bad'); return pickTime(); }
  toast('Lesson moved', 'ok');
  S.move = null;
  await loadStudent();
  home();
}

// ───────── step 3: details ─────────
function details() {
  const name = h('input', { required: true, autocomplete: 'name', placeholder: 'Full name', value: S.name, minlength: 2 });
  const phone = h('input', { required: true, type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '082 123 4567', value: S.phone });
  const pick = h('input', { required: true, autocomplete: 'street-address', placeholder: 'Street, suburb', value: S.pickup });
  const hp = h('input', { name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
  const err = h('p', { class: 'err' });
  const gps = B('Use my location', () => {
    if (!navigator.geolocation) return (err.textContent = 'Location is not available. Please type your address.');
    gps.disabled = true;
    navigator.geolocation.getCurrentPosition(p => {
      pick.value = p.coords.latitude.toFixed(5) + ',' + p.coords.longitude.toFixed(5);
      gps.disabled = false;
      toast('Location added', 'ok');
    }, () => { err.textContent = 'Could not get your location. Please type your address.'; gps.disabled = false; },
    { enableHighAccuracy: true, timeout: 15000 });
  }, 'soft full', 'pin');
  const form = h('form', { onsubmit: e => { e.preventDefault(); next(); } },
    h('label', null, 'Your name', name),
    h('label', null, 'WhatsApp number', phone),
    h('label', null, 'Pickup address', pick),
    h('div', { style: 'margin-top:8px' }, gps),
    h('div', { class: 'hp' }, h('label', null, 'Website', hp)),
    err);
  const next = () => {
    err.textContent = '';
    if (!form.reportValidity()) return;
    if (!normPhone(phone.value)) return (err.textContent = 'Please enter a valid South African cellphone number.');
    Object.assign(S, { name: name.value.trim(), phone: phone.value.trim(), pickup: pick.value.trim(), hp: hp.value });
    review();
  };
  view(h('div', { class: 'panel' }, steps(2), back(pickTime), h('h2', { style: 'margin-top:8px' }, 'Your details'),
    h('p', { class: 'muted' }, 'We use WhatsApp to confirm and remind you.'), form));
  cta(h('span', null, h('b', null, whenText(S.slot.start)), S.item.name), B('Review', next, 'pri', 'right'));
}

// ───────── step 4: confirm ─────────
function review() {
  const rows = [['Lesson', S.item.name], ['When', whenText(S.slot.start)], ['Instructor', S.slot.staffName || instructorName(S.slot.staff)],
    ['Pickup', S.pickup], ['Name', S.name], ['WhatsApp', S.phone], ['Price', money(S.item.price)]];
  const go = B(`Confirm booking`, submit, 'pri', 'check');
  view(h('div', { class: 'panel' }, steps(3), back(details), h('h2', { style: 'margin-top:8px' }, 'Check and confirm'),
    h('div', { class: 'summary' }, rows.map(([k, v]) => h('div', { class: 'row' }, h('span', null, k), h('span', null, v)))),
    h('p', { class: 'tiny' }, 'Pay cash on the day, by EFT or by card. Options show after you confirm.')));
  cta(h('span', null, h('b', null, money(S.item.price)), 'total'), go);
  async function submit() {
    go.disabled = true;
    const { data, error } = await sb.rpc('create_booking', {
      p_slug: slug, p_name: S.name, p_phone: S.phone, p_pickup: S.pickup, p_start: S.slot.start, p_staff: S.slot.staff,
      p_lesson_type: S.item.kind === 'lt' ? S.item.id : null, p_package: S.item.kind === 'pkg' ? S.item.id : null,
      p_token: token || null, p_hp: S.hp || null
    });
    if (error) {
      go.disabled = false;
      toast(error.message, 'bad');
      if (/taken/i.test(error.message)) pickTime();
      return;
    }
    success(data);
  }
}

// ───────── success ─────────
const utc = d => new Date(d).toISOString().replace(/[-:]|\.\d{3}/g, '');
function success(r) {
  if (r.token) { token = r.token; store.set(r.token); }
  const title = `Driving lesson · ${r.school}`, info = `${r.lesson} with ${r.instructor}`;
  const gcal = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${enc(title)}&dates=${utc(r.start_at)}/${utc(r.end_at)}` +
    `&location=${enc(S.pickup)}&details=${enc(info)}`;
  const ics = () => {
    const esc = s => String(s || '').replace(/[\\;,]/g, '\\$&').replace(/\n/g, '\\n');
    const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DrivingSchoolBooking//EN', 'BEGIN:VEVENT', `UID:${r.booking_id}@booking`,
      `DTSTAMP:${utc(new Date())}`, `DTSTART:${utc(r.start_at)}`, `DTEND:${utc(r.end_at)}`, `SUMMARY:${esc(title)}`,
      `DESCRIPTION:${esc(info)}`, `LOCATION:${esc(S.pickup)}`, 'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', `DESCRIPTION:${esc(title)}`, 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/calendar' })), download: 'driving-lesson.ics' });
    document.body.append(a); a.click(); a.remove();
  };
  const ref = r.student_name;
  view(
    h('div', { class: 'panel center' }, h('div', { class: 'tick' }, icon('check')),
      h('h2', { style: 'margin:0' }, `You're booked, ${first(r.student_name)}!`),
      h('p', { class: 'muted' }, 'We will remind you on WhatsApp.')),
    h('div', { class: 'card summary' },
      [['When', whenText(r.start_at)], ['Lesson', r.lesson], ['Instructor', r.instructor], ['Pickup', S.pickup]]
        .map(([k, v]) => h('div', { class: 'row' }, h('span', null, k), h('span', null, v)))),
    h('div', { class: 'actions' }, A('Google Calendar', gcal, '', 'calendar'), B('Download .ics', ics, '', 'download')),
    r.due_cents > 0 ? [
      h('h2', null, `How to pay ${money(r.due_cents)}`),
      h('div', { class: 'card' }, h('div', { class: 'row' }, icon('cash', 'lg'), h('div', { class: 'grow' }, h('b', null, 'Cash on the day'), h('div', { class: 'muted' }, 'Pay your instructor at the lesson.')))),
      r.eft_details && h('div', { class: 'card' }, h('div', { class: 'row' }, icon('bank', 'lg'), h('div', { class: 'grow' }, h('b', null, 'EFT'), h('div', { class: 'tiny' }, `Reference: ${ref}`))),
        h('pre', { class: 'mono' }, r.eft_details),
        B('Copy bank details', () => copyText(`${r.eft_details}\nReference: ${ref}`, 'Bank details copied'), 'soft full', 'copy')),
      r.card_link && h('div', { class: 'card' }, h('div', { class: 'row' }, icon('card', 'lg'), h('div', { class: 'grow' }, h('b', null, 'Pay by card'), h('div', { class: 'muted' }, 'Secure payment link'))),
        A('Pay now', r.card_link, 'pri full', 'card'))
    ] : h('div', { class: 'card' }, h('b', null, 'Covered by your package'), h('div', { class: 'muted' }, 'Nothing to pay for this lesson.')),
    r.whatsapp && A('WhatsApp the school', wa(r.whatsapp, `Hi ${r.school}, I just booked ${whenText(r.start_at)} (${r.student_name}).`), 'big', 'chat'),
    token && B('See my bookings', async () => { await loadStudent(); S.stu ? home() : choose(); }, 'ghost big'));
}
