-- 002_upgrade.sql: upgrade a database that already has the original schema.sql.
-- Safe to re-run: IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS everywhere.
-- Supabase: SQL Editor -> New query -> paste this whole file -> Run.

-- ═══════════════ Part 1: 30-minute slots, travel buffer, blocked times, minimum notice ═══════════════
alter table schools add column if not exists slot_interval_minutes int not null default 30
  check (slot_interval_minutes in (15, 20, 30, 60));
alter table schools add column if not exists buffer_minutes int not null default 0
  check (buffer_minutes between 0 and 120);
alter table schools add column if not exists min_notice_hours int not null default 2
  check (min_notice_hours between 0 and 168);

-- leave, holidays, car services. staff_id null = the whole school is closed.
create table if not exists blocked_times (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(id) on delete cascade,
  staff_id uuid references staff(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  reason text,
  check (end_at > start_at)
);
create index if not exists blocked_times_school_start on blocked_times (school_id, start_at);
alter table blocked_times enable row level security;

-- Internal slot engine (not callable by clients). Slots start every slot_interval_minutes inside
-- availability; a slot is free if [start, start+lesson) plus the travel buffer on both sides
-- touches no booking, and doesn't touch a blocked time.
create or replace function free_slots(p_school uuid, p_date date, p_staff uuid, p_minutes int,
                                      p_exclude uuid, p_notice interval)
returns table (staff_id uuid, staff_name text, slot_start timestamptz)
language sql stable security definer set search_path = public as $$
  select distinct st.id, st.name, g.s
  from schools sc
  join staff st on st.school_id = sc.id and st.active and (p_staff is null or st.id = p_staff)
  join availability a on a.staff_id = st.id and a.weekday = extract(dow from p_date)::int
  cross join lateral (select make_interval(mins => coalesce(p_minutes, sc.lesson_minutes)) as dur,
                             make_interval(mins => sc.buffer_minutes) as buf) d
  cross join lateral generate_series(p_date + a.start_time, p_date + a.end_time - d.dur,
                                     make_interval(mins => sc.slot_interval_minutes)) gs(ts)
  cross join lateral (select gs.ts at time zone 'Africa/Johannesburg' as s) g
  where sc.id = p_school
    and g.s > now() + p_notice
    and not exists (select 1 from bookings b
                    where b.staff_id = st.id and b.status <> 'cancelled' and b.id is distinct from p_exclude
                      and b.start_at < g.s + d.dur + d.buf and b.end_at + d.buf > g.s)
    and not exists (select 1 from blocked_times x
                    where x.school_id = sc.id and (x.staff_id is null or x.staff_id = st.id)
                      and x.start_at < g.s + d.dur and x.end_at > g.s)
  order by g.s, st.name
$$;

-- Public wrapper: same signature as before, now honours min notice and a 60-day horizon.
create or replace function get_free_slots(p_slug text, p_date date, p_staff uuid default null, p_minutes int default null)
returns table (staff_id uuid, staff_name text, slot_start timestamptz)
language sql stable security definer set search_path = public as $$
  select f.* from schools sc,
    free_slots(sc.id, p_date, p_staff, p_minutes, null, make_interval(hours => sc.min_notice_hours)) f
  where sc.slug = p_slug and p_date <= (now() at time zone 'Africa/Johannesburg')::date + 60
$$;

revoke execute on function free_slots(uuid, date, uuid, int, uuid, interval) from public, anon, authenticated;

-- (replaced by the role-aware policies in Part 4)
drop policy if exists blocked_times_rw on blocked_times;
create policy blocked_times_rw on blocked_times for all to authenticated
  using (school_id = my_school()) with check (school_id = my_school());
grant select, insert, update, delete on blocked_times to authenticated;
revoke all on blocked_times from anon;

-- ═══════════════ Part 2: per-school branding ═══════════════
alter table schools add column if not exists brand_color text not null default '#0a6cff'
  check (brand_color ~ '^#[0-9a-fA-F]{6}$');
alter table schools add column if not exists logo_url text;

-- ═══════════════ Parts 3, 5, 6, 7: new columns ═══════════════
alter table schools add column if not exists cancel_cutoff_hours int not null default 24
  check (cancel_cutoff_hours between 0 and 168);
-- no-show rule: 'credit' = use a package lesson (or owe the lesson price if no credits),
-- 'owe' = always owe the lesson price, 'free' = no charge
alter table schools add column if not exists no_show_rule text not null default 'credit'
  check (no_show_rule in ('credit', 'owe', 'free'));
alter table packages add column if not exists valid_days int not null default 180 check (valid_days > 0);
alter table student_packages add column if not exists expires_at timestamptz;
alter table students add column if not exists test_date date;        -- K53 test
alter table students add column if not exists test_venue text;
alter table bookings add column if not exists no_charge boolean not null default false;
alter table bookings add column if not exists cancelled_at timestamptz;
alter table bookings add column if not exists cancelled_by text;      -- 'student' | 'staff'

update student_packages sp set expires_at = sp.bought_at + make_interval(days => p.valid_days)
  from packages p where p.id = sp.package_id and sp.expires_at is null;

create or replace function set_package_expiry() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.expires_at is null then
    select new.bought_at + make_interval(days => valid_days) into new.expires_at from packages where id = new.package_id;
  end if;
  return new;
end $$;
drop trigger if exists student_packages_expiry on student_packages;
create trigger student_packages_expiry before insert on student_packages
  for each row execute function set_package_expiry();

-- ═══════════════ Part 4: roles ═══════════════
create or replace function my_staff_id() returns uuid language sql stable security definer set search_path = public as $$
  select id from staff where auth_user_id = auth.uid() and active limit 1
$$;
create or replace function is_owner() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'owner' from staff where auth_user_id = auth.uid() and active limit 1), false)
$$;

-- ═══════════════ Views ═══════════════
-- package_left: internal (runs with owner rights, no client access). Expired packages give no credits.
create or replace view package_left as
select sp.id, sp.student_id, sp.package_id, sp.lessons_total, sp.paid_status, sp.bought_at,
  sp.lessons_total - (select count(*) from bookings b
     where b.student_package_id = sp.id and b.status in ('done','no_show'))::int as remaining,
  sp.expires_at,
  coalesce(sp.expires_at < now(), false) as expired
from student_packages sp;
alter view package_left set (security_invoker = false);

-- package_status: what staff apps read (own school only)
create or replace view package_status as
select pl.*, p.name as package_name, p.price_cents, s.school_id
from package_left pl join packages p on p.id = pl.package_id join students s on s.id = pl.student_id
where s.school_id = my_school();

-- student_balance: owner rights + explicit school filter, so instructors (who only see their own
-- bookings/payments through RLS) still get correct balances for the students they teach.
create or replace view student_balance as
select s.id as student_id, s.school_id, s.name, s.phone, s.pickup_address, s.notes, s.token,
  coalesce((select sum(remaining) from package_left pl where pl.student_id = s.id and not pl.expired and pl.remaining > 0), 0)::int as credits,
  (coalesce((select sum(p.price_cents) from student_packages sp join packages p on p.id = sp.package_id
              where sp.student_id = s.id), 0)
   + coalesce((select sum(lt.price_cents) from bookings b join lesson_types lt on lt.id = b.lesson_type_id
              where b.student_id = s.id and b.status in ('done','no_show') and b.student_package_id is null and not b.no_charge), 0)
   - coalesce((select sum(amount_cents) from payments pay where pay.student_id = s.id), 0))::int as owing_cents,
  s.test_date, s.test_venue, s.created_at
from students s
where s.school_id = my_school();
alter view student_balance set (security_invoker = false);

-- ═══════════════ Part 4: role-aware RLS (owner: everything; instructor: own bookings, no settings) ═══════════════
drop policy if exists schools_upd on schools;
create policy schools_upd on schools for update to authenticated
  using (id = my_school() and is_owner()) with check (id = my_school() and is_owner());

do $$ declare t text; begin
  foreach t in array array['staff','lesson_types','packages','blocked_times'] loop
    execute format('drop policy if exists %I on %I', t || '_rw', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('drop policy if exists %I on %I', t || '_owner', t);
    execute format('create policy %I on %I for select to authenticated using (school_id = my_school())', t || '_read', t);
    execute format('create policy %I on %I for all to authenticated using (school_id = my_school() and is_owner()) with check (school_id = my_school() and is_owner())', t || '_owner', t);
  end loop;
end $$;

drop policy if exists availability_rw on availability;
drop policy if exists availability_read on availability;
drop policy if exists availability_owner on availability;
create policy availability_read on availability for select to authenticated
  using (staff_id in (select id from staff where school_id = my_school()));
create policy availability_owner on availability for all to authenticated
  using (is_owner() and staff_id in (select id from staff where school_id = my_school()))
  with check (is_owner() and staff_id in (select id from staff where school_id = my_school()));

-- students: every staff member can find, add and edit students; only owners delete
drop policy if exists students_rw on students;
drop policy if exists students_read on students;
drop policy if exists students_add on students;
drop policy if exists students_edit on students;
drop policy if exists students_del on students;
create policy students_read on students for select to authenticated using (school_id = my_school());
create policy students_add on students for insert to authenticated with check (school_id = my_school());
create policy students_edit on students for update to authenticated using (school_id = my_school()) with check (school_id = my_school());
create policy students_del on students for delete to authenticated using (school_id = my_school() and is_owner());

drop policy if exists student_packages_rw on student_packages;
drop policy if exists student_packages_read on student_packages;
drop policy if exists student_packages_add on student_packages;
drop policy if exists student_packages_owner on student_packages;
create policy student_packages_read on student_packages for select to authenticated
  using (student_id in (select id from students where school_id = my_school()));
create policy student_packages_add on student_packages for insert to authenticated
  with check (student_id in (select id from students where school_id = my_school()));
create policy student_packages_owner on student_packages for all to authenticated
  using (is_owner() and student_id in (select id from students where school_id = my_school()))
  with check (is_owner() and student_id in (select id from students where school_id = my_school()));

drop policy if exists bookings_rw on bookings;
drop policy if exists bookings_owner on bookings;
drop policy if exists bookings_mine on bookings;
create policy bookings_owner on bookings for all to authenticated
  using (school_id = my_school() and is_owner()) with check (school_id = my_school() and is_owner());
create policy bookings_mine on bookings for all to authenticated
  using (school_id = my_school() and staff_id = my_staff_id())
  with check (school_id = my_school() and staff_id = my_staff_id());

drop policy if exists payments_rw on payments;
drop policy if exists payments_owner on payments;
drop policy if exists payments_mine on payments;
drop policy if exists payments_add on payments;
create policy payments_owner on payments for all to authenticated
  using (school_id = my_school() and is_owner()) with check (school_id = my_school() and is_owner());
create policy payments_mine on payments for select to authenticated
  using (school_id = my_school() and received_by = my_staff_id());
create policy payments_add on payments for insert to authenticated
  with check (school_id = my_school() and received_by = my_staff_id());

-- ═══════════════ Part 5: Done / No-show (definer, checks role itself) ═══════════════
create or replace function complete_booking(p_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b bookings; sp uuid; rule text; r jsonb;
begin
  if p_status not in ('done','no_show') then raise exception 'Bad status'; end if;
  select * into b from bookings where id = p_id and school_id = my_school() and status <> 'cancelled';
  if not found then raise exception 'Booking not found'; end if;
  if not is_owner() and b.staff_id is distinct from my_staff_id() then raise exception 'This is not your lesson'; end if;
  select no_show_rule into rule from schools where id = b.school_id;
  update bookings set status = p_status, no_charge = (p_status = 'no_show' and rule = 'free') where id = p_id;
  if b.student_package_id is null and (p_status = 'done' or rule = 'credit') then
    select id into sp from package_left where student_id = b.student_id and remaining > 0 and not expired
      order by expires_at nulls last, bought_at limit 1;
    if sp is not null then update bookings set student_package_id = sp where id = p_id; end if;
  elsif b.student_package_id is not null and p_status = 'no_show' and rule <> 'credit' then
    update bookings set student_package_id = null where id = p_id;   -- give the credit back
  end if;
  select jsonb_build_object('name', s.name, 'phone', s.phone, 'token', s.token, 'slug', sc.slug,
           'credits', (select coalesce(sum(remaining), 0) from package_left
                        where student_id = s.id and not expired and remaining > 0))
    into r from students s join schools sc on sc.id = s.school_id where s.id = b.student_id;
  return r;
end $$;

-- ═══════════════ Part 4: staff booking / rescheduling ═══════════════
create or replace function staff_free_slots(p_date date, p_staff uuid default null, p_minutes int default null, p_exclude uuid default null)
returns table (staff_id uuid, staff_name text, slot_start timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if my_school() is null then raise exception 'Not signed in'; end if;
  if not is_owner() then p_staff := my_staff_id(); end if;
  return query select f.staff_id, f.staff_name, f.slot_start
    from free_slots(my_school(), p_date, p_staff, p_minutes, p_exclude, interval '0') f;
end $$;

-- book a student, optionally repeating weekly. Weeks that aren't free are skipped and reported.
create or replace function staff_book(p_student uuid, p_staff uuid, p_lesson_type uuid, p_start timestamptz,
                                      p_weeks int default 1, p_pickup text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare sch uuid := my_school(); lt lesson_types; s timestamptz; addr text; i int;
        made jsonb := '[]'; skipped jsonb := '[]';
begin
  if sch is null then raise exception 'Not signed in'; end if;
  if not is_owner() and p_staff is distinct from my_staff_id() then raise exception 'Instructors can only book their own lessons'; end if;
  perform 1 from staff where id = p_staff and school_id = sch and active;
  if not found then raise exception 'Instructor not found'; end if;
  select * into lt from lesson_types where id = p_lesson_type and school_id = sch;
  if not found then raise exception 'Choose a lesson type'; end if;
  select coalesce(nullif(btrim(p_pickup), ''), pickup_address) into addr from students where id = p_student and school_id = sch;
  if not found then raise exception 'Student not found'; end if;
  for i in 0 .. least(greatest(coalesce(p_weeks, 1), 1), 26) - 1 loop
    s := p_start + make_interval(days => 7 * i);       -- SA has no DST, so +7 days keeps the clock time
    if exists (select 1 from free_slots(sch, (s at time zone 'Africa/Johannesburg')::date, p_staff, lt.minutes, null, interval '0') f
                where f.slot_start = s) then
      begin
        insert into bookings (school_id, staff_id, student_id, lesson_type_id, start_at, end_at, pickup_address)
          values (sch, p_staff, p_student, lt.id, s, s + make_interval(mins => lt.minutes), addr);
        made := made || to_jsonb(s);
      exception when exclusion_violation then skipped := skipped || to_jsonb(s);
      end;
    else
      skipped := skipped || to_jsonb(s);
    end if;
  end loop;
  return jsonb_build_object('created', made, 'skipped', skipped);
end $$;

create or replace function staff_reschedule(p_booking uuid, p_start timestamptz, p_staff uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare b bookings; ns uuid; dur interval;
begin
  select * into b from bookings where id = p_booking and school_id = my_school() and status = 'booked';
  if not found then raise exception 'Booking not found'; end if;
  ns := coalesce(p_staff, b.staff_id);
  if not is_owner() and (b.staff_id <> my_staff_id() or ns <> my_staff_id()) then raise exception 'This is not your lesson'; end if;
  dur := b.end_at - b.start_at;
  if not exists (select 1 from free_slots(b.school_id, (p_start at time zone 'Africa/Johannesburg')::date, ns,
                   (extract(epoch from dur) / 60)::int, b.id, interval '0') f where f.slot_start = p_start) then
    raise exception 'That time is not free';
  end if;
  update bookings set start_at = p_start, end_at = p_start + dur, staff_id = ns where id = b.id;
exception when exclusion_violation then raise exception 'That time is not free';
end $$;

-- ═══════════════ Part 3: student self-service (personal link token) ═══════════════
create or replace function student_cancel(p_token text, p_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
declare st students; b bookings; cut int;
begin
  select * into st from students where token = p_token;
  if not found then raise exception 'This link is not valid any more'; end if;
  select * into b from bookings where id = p_booking and student_id = st.id and status = 'booked';
  if not found then raise exception 'Booking not found'; end if;
  select cancel_cutoff_hours into cut from schools where id = st.school_id;
  if b.start_at < now() + make_interval(hours => cut) then
    raise exception 'Less than % hours to go, so please WhatsApp the school to cancel.', cut;
  end if;
  update bookings set status = 'cancelled', cancelled_at = now(), cancelled_by = 'student' where id = b.id;
end $$;

create or replace function student_reschedule(p_token text, p_booking uuid, p_start timestamptz, p_staff uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare st students; b bookings; sc schools; ns uuid; dur interval;
begin
  select * into st from students where token = p_token;
  if not found then raise exception 'This link is not valid any more'; end if;
  select * into b from bookings where id = p_booking and student_id = st.id and status = 'booked';
  if not found then raise exception 'Booking not found'; end if;
  select * into sc from schools where id = st.school_id;
  if b.start_at < now() + make_interval(hours => sc.cancel_cutoff_hours) then
    raise exception 'Less than % hours to go, so please WhatsApp the school to move it.', sc.cancel_cutoff_hours;
  end if;
  ns := coalesce(p_staff, b.staff_id);
  dur := b.end_at - b.start_at;
  if p_start > now() + interval '60 days' or not exists (
       select 1 from free_slots(sc.id, (p_start at time zone 'Africa/Johannesburg')::date, ns,
                                (extract(epoch from dur) / 60)::int, b.id, make_interval(hours => sc.min_notice_hours)) f
        where f.slot_start = p_start) then
    raise exception 'That time was just taken, please pick another';
  end if;
  update bookings set start_at = p_start, end_at = p_start + dur, staff_id = ns where id = b.id;
  return jsonb_build_object('start_at', p_start, 'end_at', p_start + dur);
exception when exclusion_violation then raise exception 'That time was just taken, please pick another';
end $$;

create or replace function get_student_summary(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'name', s.name, 'phone', s.phone, 'pickup_address', s.pickup_address,
    'test_date', s.test_date, 'test_venue', s.test_venue,
    'school', sc.name, 'cancel_cutoff_hours', sc.cancel_cutoff_hours,
    'credits', (select coalesce(sum(remaining), 0) from package_left
                 where student_id = s.id and not expired and remaining > 0),
    'packages', (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'remaining', pl.remaining,
                   'lessons_total', pl.lessons_total, 'expires_at', pl.expires_at) order by pl.expires_at), '[]')
                 from package_left pl join packages p on p.id = pl.package_id
                 where pl.student_id = s.id and not pl.expired and pl.remaining > 0),
    'upcoming', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'start_at', b.start_at, 'end_at', b.end_at,
                   'lesson', lt.name, 'instructor', stf.name, 'staff_id', b.staff_id,
                   'can_change', b.start_at > now() + make_interval(hours => sc.cancel_cutoff_hours)) order by b.start_at), '[]')
                 from bookings b left join lesson_types lt on lt.id = b.lesson_type_id
                 join staff stf on stf.id = b.staff_id
                 where b.student_id = s.id and b.status = 'booked' and b.start_at > now()))
  from students s join schools sc on sc.id = s.school_id
  where s.token = p_token
$$;

create or replace function get_school_public(p_slug text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'name', s.name, 'slug', s.slug, 'lesson_minutes', s.lesson_minutes, 'whatsapp', s.whatsapp,
    'brand_color', s.brand_color, 'logo_url', s.logo_url, 'cancel_cutoff_hours', s.cancel_cutoff_hours,
    'lesson_types', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'minutes', minutes,
                       'price_cents', price_cents) order by minutes, price_cents), '[]') from lesson_types where school_id = s.id and active),
    'packages', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'lessons', lessons,
                       'price_cents', price_cents, 'valid_days', valid_days) order by price_cents), '[]')
                 from packages where school_id = s.id and active),
    'instructors', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]')
                    from staff where school_id = s.id and active
                     and exists (select 1 from availability a where a.staff_id = staff.id)))
  from schools s where s.slug = p_slug
$$;

-- ═══════════════ Part 7: public booking with honeypot + limits ═══════════════
drop function if exists create_booking(text, text, text, text, timestamptz, uuid, uuid, uuid, text);
create or replace function create_booking(
  p_slug text, p_name text, p_phone text, p_pickup text, p_start timestamptz, p_staff uuid,
  p_lesson_type uuid default null, p_package uuid default null, p_token text default null, p_hp text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  sc schools; st students; lt lesson_types; pk packages; bk bookings; stf staff;
  ph text := norm_phone(p_phone);
  nm text := btrim(coalesce(p_name, ''));
  addr text := left(btrim(coalesce(p_pickup, '')), 300);
  dur int; due int; sid uuid; is_new boolean;
begin
  if coalesce(p_hp, '') <> '' then raise exception 'Something went wrong. Please WhatsApp the school.'; end if;  -- bot filled the hidden field
  select * into sc from schools where slug = p_slug;
  if not found then raise exception 'School not found'; end if;
  if ph is null then raise exception 'Please enter a valid South African cellphone number, e.g. 082 123 4567'; end if;
  if length(nm) < 2 or length(nm) > 80 then raise exception 'Please enter your name'; end if;
  if addr = '' then raise exception 'Please enter a pickup address'; end if;
  if p_staff is null then raise exception 'Please choose a time'; end if;

  if p_lesson_type is not null then
    select * into lt from lesson_types where id = p_lesson_type and school_id = sc.id and active;
    if not found then raise exception 'That lesson is no longer available'; end if;
    dur := lt.minutes; due := lt.price_cents;
  elsif p_package is not null then
    select * into pk from packages where id = p_package and school_id = sc.id and active;
    if not found then raise exception 'That package is no longer available'; end if;
    select * into lt from lesson_types where school_id = sc.id and active
      order by (minutes = sc.lesson_minutes) desc, price_cents limit 1;
    if not found then raise exception 'This school has no lesson types yet'; end if;
    dur := sc.lesson_minutes; due := pk.price_cents;
  else
    raise exception 'Please choose a lesson or package';
  end if;

  if not exists (select 1 from get_free_slots(p_slug, (p_start at time zone 'Africa/Johannesburg')::date, p_staff, dur) f
                  where f.slot_start = p_start) then
    raise exception 'Sorry, that time was just taken. Please pick another.';
  end if;

  insert into students (school_id, name, phone, pickup_address) values (sc.id, nm, ph, addr)
    on conflict (school_id, phone) do update set pickup_address = coalesce(students.pickup_address, excluded.pickup_address)
    returning id, (xmax = 0) into sid, is_new;
  select * into st from students where id = sid;

  if (select count(*) from bookings where student_id = sid and created_at > now() - interval '1 day') >= 3 then
    raise exception 'You have made 3 bookings today already. Please WhatsApp the school for more.';
  end if;
  if (select count(*) from bookings where student_id = sid and status = 'booked' and start_at > now()) >= 5 then
    raise exception 'You already have 5 upcoming lessons. Please WhatsApp the school to book more.';
  end if;

  begin
    insert into bookings (school_id, staff_id, student_id, lesson_type_id, start_at, end_at, pickup_address)
      values (sc.id, p_staff, sid, lt.id, p_start, p_start + make_interval(mins => dur), addr) returning * into bk;
  exception when exclusion_violation then
    raise exception 'Sorry, that time was just taken. Please pick another.';
  end;

  if pk.id is not null then
    if not exists (select 1 from package_left where student_id = sid and package_id = pk.id
                    and paid_status = 'unpaid' and remaining > 0 and not expired) then
      insert into student_packages (student_id, package_id, lessons_total) values (sid, pk.id, pk.lessons);
    end if;
  elsif (select coalesce(sum(remaining), 0) from package_left where student_id = sid and not expired and remaining > 0)
      > (select count(*) from bookings where student_id = sid and status = 'booked' and start_at > now() and id <> bk.id) then
    due := 0;
  end if;

  select * into stf from staff where id = p_staff;
  return jsonb_build_object(
    'booking_id', bk.id, 'start_at', bk.start_at, 'end_at', bk.end_at,
    'lesson', case when pk.id is not null then pk.name || ' (first lesson)' else lt.name end,
    'instructor', stf.name, 'due_cents', due,
    'student_name', st.name, 'school', sc.name, 'whatsapp', sc.whatsapp,
    'eft_details', sc.eft_details, 'card_link', sc.card_link,
    'token', case when is_new or p_token = st.token then st.token end);
end $$;

-- ═══════════════ privileges for everything above ═══════════════
revoke all on package_left from anon, authenticated;
revoke all on package_status, student_balance from anon;
grant select on package_status, student_balance to authenticated;
revoke execute on function set_package_expiry(), free_slots(uuid, date, uuid, int, uuid, interval) from public, anon, authenticated;
revoke execute on function my_staff_id(), is_owner(), complete_booking(uuid, text),
  staff_free_slots(date, uuid, int, uuid), staff_book(uuid, uuid, uuid, timestamptz, int, text),
  staff_reschedule(uuid, timestamptz, uuid) from public, anon;
grant execute on function my_staff_id(), is_owner(), complete_booking(uuid, text),
  staff_free_slots(date, uuid, int, uuid), staff_book(uuid, uuid, uuid, timestamptz, int, text),
  staff_reschedule(uuid, timestamptz, uuid) to authenticated;
revoke execute on function student_cancel(text, uuid), student_reschedule(text, uuid, timestamptz, uuid),
  create_booking(text, text, text, text, timestamptz, uuid, uuid, uuid, text, text) from public;
grant execute on function get_school_public(text), get_free_slots(text, date, uuid, int), get_student_summary(text),
  create_booking(text, text, text, text, timestamptz, uuid, uuid, uuid, text, text),
  student_cancel(text, uuid), student_reschedule(text, uuid, timestamptz, uuid) to anon, authenticated;
