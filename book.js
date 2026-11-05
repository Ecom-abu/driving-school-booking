// Public student booking page. Uses lib.js helpers. Talks to Supabase only through the public RPCs in schema.sql.
const root = $('#app'), slug = new URLSearchParams(location.search).get('s');
const S = { sch: null, item: null, day: null, staff: '', slot: null, stu: null, pickup: '' };
const tokKey = 'tok_' + slug;
const store = {
  get: () => { try { return localStorage.getItem(tokKey); } catch { return null; } },
  set: v => { try { localStorage.setItem(tokKey, v); } catch { /* private mode */ } }
};
let token = new URLSearchParams(location.search).get('p') || store.get();

const lessonItem = l => ({ kind: 'lt', id: l.id, name: l.name, minutes: l.minutes, price: l.price_cents });
const pkgItem = p => ({ kind: 'pkg', id: p.id, name: p.name, minutes: null, price: p.price_cents });
const defaultItem = () => {
  const ls = S.sch.lesson_types;
  const l = ls.find(x => x.minutes === S.sch.lesson_minutes) || ls[0];
  return l && lessonItem(l);
};
const label = (t, el) => h('label', null, t, el);
const tileBtn = (it, sub) => h('button', { class: 'tile', onclick: () => { S.item = it; pickDate(); } },
  h('div', null, h('b', null, it.name), h('span', null, sub)), h('div', { class: 'price' }, money(it.price)));

(async () => {
  if (!slug) return show(root, h('p', { class: 'err' }, 'This booking link is missing the school name.'));
  const { data: sch } = await sb.rpc('get_school_public', { p_slug: slug });
  if (!sch) return show(root, h('p', { class: 'err' }, 'School not found. Please check the link.'));
  S.sch = sch;
  $('#title').textContent = sch.name;
  document.title = 'Book a lesson · ' + sch.name;
  if (token) {
    const { data } = await sb.rpc('get_student_summary', { p_token: token });
    if (data) { S.stu = data; S.pickup = data.pickup_address || ''; store.set(token); } else token = null;
  }
  S.stu ? welcome() : choose();
})().catch(e => show(root, h('p', { class: 'err' }, e.message || String(e))));

function welcome() {
  const u = S.stu, n = u.credits;
  const item = defaultItem();
  show(root,
    h('h2', null, n > 0 ? `Hi ${first(u.name)}, you have ${plural(n, 'lesson')} left` : `Hi ${first(u.name)}, welcome back`),
    u.upcoming.length ? [h('h3', null, 'Your next lessons'), u.upcoming.map(b => h('div', { class: 'card' }, `${dayLabel(b.start_at)} at ${hm(b.start_at)}`, h('small', null, ` · ${b.lesson || 'Lesson'} with ${b.instructor}`)))] : null,
    item ? B('Book next lesson', () => { S.item = item; pickDate(); }, 'pri big') : null,
    B('Choose a different lesson or package', choose, 'ghost'));
}

function choose() {
  const { lesson_types: ls, packages: ps } = S.sch;
  show(root,
    ls.length ? h('h2', null, 'Choose a lesson') : h('p', { class: 'muted' }, 'No lessons are open for booking yet. Please WhatsApp the school.'),
    ls.map(l => tileBtn(lessonItem(l), `${l.minutes} minutes`)),
    ps.length ? [h('h2', null, 'Or save with a package'), ps.map(p => tileBtn(pkgItem(p), `${plural(p.lessons, 'lesson')} · first lesson booked now`))] : null,
    S.stu ? B('← Back', welcome, 'ghost') : null);
}

function pickDate() {
  const today = ymd(new Date());
  if (!S.day) S.day = today;
  const box = h('div', { class: 'slots' }, h('p', { class: 'muted' }, 'Loading times…'));
  const ins = S.sch.instructors;
  show(root,
    B('← Back', S.stu ? welcome : choose, 'ghost'),
    h('h2', null, S.item.name, ' · ', money(S.item.price)),
    ins.length > 1 ? label('Instructor', h('select', { value: S.staff, onchange: e => { S.staff = e.target.value; pickDate(); } },
      h('option', { value: '' }, 'Any instructor'), ins.map(i => h('option', { value: i.id }, i.name)))) : null,
    h('div', { class: 'strip' }, Array.from({ length: 14 }, (_, i) => {
      const d = addDays(today, i);
      return h('button', { class: 'day' + (d === S.day ? ' on' : ''), onclick: () => { S.day = d; pickDate(); } },
        fmt(dayStart(d), { weekday: 'short' }), h('b', null, +d.slice(8)), h('small', null, fmt(dayStart(d), { month: 'short' })));
    })),
    box);
  sb.rpc('get_free_slots', { p_slug: slug, p_date: S.day, p_staff: S.staff || null, p_minutes: S.item.minutes }).then(({ data, error }) => {
    if (error) return show(box, h('p', { class: 'err' }, error.message));
    const seen = new Set();
    const list = data.filter(x => !seen.has(x.slot_start) && seen.add(x.slot_start)); // "any instructor": one button per time
    show(box, list.length
      ? list.map(x => h('button', { class: 'slot', onclick: () => { S.slot = { start: x.slot_start, staff: x.staff_id }; details(); } }, hm(x.slot_start)))
      : h('p', { class: 'muted' }, 'No free times this day. Try another day.'));
  });
  const on = root.querySelector('.day.on');
  on && on.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function details() {
  const u = S.stu || {};
  const name = h('input', { required: true, autocomplete: 'name', placeholder: 'Your name', value: u.name });
  const phone = h('input', { required: true, type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '082 123 4567', value: u.phone ? '0' + u.phone.slice(2) : '' });
  const pick = h('input', { required: true, autocomplete: 'street-address', placeholder: 'Street, suburb', value: S.pickup });
  const err = h('p', { class: 'err' });
  const gps = B('📍 Use my location', () => {
    if (!navigator.geolocation) return (err.textContent = 'Location is not available. Please type your address.');
    gps.disabled = true;
    navigator.geolocation.getCurrentPosition(p => {
      pick.value = p.coords.latitude.toFixed(5) + ',' + p.coords.longitude.toFixed(5);
      gps.disabled = false;
    }, () => { err.textContent = 'Could not get your location. Please type your address.'; gps.disabled = false; },
    { enableHighAccuracy: true, timeout: 15000 });
  });
  const go = h('button', { class: 'btn pri big' }, 'Confirm booking');
  show(root,
    B('← Back', pickDate, 'ghost'),
    h('h2', null, `${dayLabel(S.slot.start)} at ${hm(S.slot.start)}`),
    h('p', { class: 'muted' }, `${S.item.name} · ${money(S.item.price)}`),
    h('form', {
      onsubmit: async e => {
        e.preventDefault();
        err.textContent = '';
        if (!normPhone(phone.value)) return (err.textContent = 'Please enter a valid South African number.');
        go.disabled = true;
        S.pickup = pick.value;
        const { data, error } = await sb.rpc('create_booking', {
          p_slug: slug, p_name: name.value, p_phone: phone.value, p_pickup: pick.value,
          p_start: S.slot.start, p_staff: S.slot.staff,
          p_lesson_type: S.item.kind === 'lt' ? S.item.id : null,
          p_package: S.item.kind === 'pkg' ? S.item.id : null, p_token: token || null
        });
        if (error) { err.textContent = error.message; go.disabled = false; return; }
        success(data);
      }
    }, label('Name', name), label('WhatsApp number', phone), label('Pickup address', [pick, gps]), err, go));
}

const utc = d => new Date(d).toISOString().replace(/[-:]|\.\d{3}/g, '');
function success(r) {
  if (r.token) { token = r.token; store.set(r.token); }
  const title = `Driving lesson · ${r.school}`, details = `${r.lesson} with ${r.instructor}`;
  const gcal = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${enc(title)}&dates=${utc(r.start_at)}/${utc(r.end_at)}` +
    `&location=${enc(S.pickup)}&details=${enc(details)}`;
  const ics = () => {
    const esc = s => String(s || '').replace(/[\\;,]/g, '\\$&').replace(/\n/g, '\\n');
    const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DrivingSchoolBooking//EN', 'BEGIN:VEVENT', `UID:${r.booking_id}@booking`,
      `DTSTAMP:${utc(new Date())}`, `DTSTART:${utc(r.start_at)}`, `DTEND:${utc(r.end_at)}`, `SUMMARY:${esc(title)}`,
      `DESCRIPTION:${esc(details)}`, `LOCATION:${esc(S.pickup)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/calendar' })), download: 'driving-lesson.ics' });
    document.body.append(a); a.click(); a.remove();
  };
  show(root,
    h('div', { class: 'tick' }, '✓'),
    h('h2', null, `You're booked, ${first(r.student_name)}!`),
    h('p', null, h('b', null, `${dayLabel(r.start_at)} at ${hm(r.start_at)}`), h('br'), `${r.lesson} · ${r.instructor}`, h('br'), `Pickup: ${S.pickup}`),
    A('Add to Google Calendar', gcal, 'big'), B('Download .ics', ics, 'big'),
    r.due_cents > 0 ? [
      h('h3', null, `To pay: ${money(r.due_cents)}`),
      r.card_link ? A('Pay now', r.card_link, 'pri big') : null,
      r.eft_details ? h('div', { class: 'card' }, h('b', null, 'EFT details'), h('pre', null, r.eft_details), h('small', null, `Use your name as reference: ${r.student_name}`)) : null,
      h('div', { class: 'card' }, h('b', null, 'Pay cash to instructor'), h('div', { class: 'muted' }, 'Hand it over at your lesson.'))
    ] : h('p', { class: 'muted' }, 'Covered by your package. Nothing to pay.'),
    r.whatsapp ? A('WhatsApp the school', `https://wa.me/${r.whatsapp}`, 'big') : null);
}
