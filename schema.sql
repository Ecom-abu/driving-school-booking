-- Driving school booking: schema, RLS and RPCs.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- All times are stored as timestamptz; "wall clock" logic uses Africa/Johannesburg (UTC+2, no DST).

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

-- ───────────── tables ─────────────
create table schools (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null check (slug ~ '^[a-z0-9-]{3,40}$'),
  name text not null,
  whatsapp text,                -- 27XXXXXXXXX
  eft_details text,
  card_link text,
  lesson_minutes int not null default 60 check (lesson_minutes between 15 and 240),
  created_at timestamptz not null default now()
);

create table staff (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(id) on delete cascade,
  auth_user_id uuid references auth.users(id) on delete set null,
  name text not null,
  phone text,
  email text,                   -- matched to the login email by claim_staff()
  role text not null default 'instructor' check (role in ('owner','instructor')),
  active boolean not null default true
);
create index on staff (auth_user_id);
create index on staff (school_id);

create table availability (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),   -- 0 = Sunday
  start_time time not null,
  end_time time not null,
  check (end_time > start_time)
);
create index on availability (staff_id);

create table lesson_types (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(id) on delete cascade,
  name text not null,
  minutes int not null check (minutes > 0),
  price_cents int not null check (price_cents >= 0),
  active boolean not null default true
);

create table packages (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(id) on delete cascade,
  name text not null,
  lessons int not null check (lessons > 0),
  price_cents int not null check (price_cents >= 0),
  active boolean not null default true
);

create table students (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(id) on delete cascade,
  name text not null,
  phone text not null,          -- 27XXXXXXXXX
  pickup_address text,
  notes text,
  token text unique not null default encode(gen_random_bytes(8), 'hex'),
  created_at timestamptz not null default now(),
  unique (school_id, phone)
);

create table student_packages (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students(id) on delete cascade,
  package_id uuid not null references packages(id),
  lessons_total int not null check (lessons_total > 0),
  bought_at timestamptz not null default now(),
  paid_status text not null default 'unpaid' check (paid_status in ('unpaid','partial','paid'))
);
create index on student_packages (student_id);

create table bookings (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(id) on delete cascade,
  staff_id uuid not null references staff(id),
  student_id uuid not null references students(id) on delete cascade,
  lesson_type_id uuid references lesson_types(id) on delete set null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  pickup_address text,
  status text not null default 'booked' check (status in ('booked','done','no_show','cancelled')),
  student_package_id uuid references student_packages(id) on delete set null,
  created_at timestamptz not null default now(),
  check (end_at > start_at),
  -- an instructor can never be double-booked (cancelled lessons free the slot)
  constraint bookings_no_overlap exclude using gist
    (staff_id with =, tstzrange(start_at, end_at) with &&) where (status <> 'cancelled')
);
create index on bookings (school_id, start_at);
create index on bookings (student_id);
create index on bookings (student_package_id);

create table payments (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  booking_id uuid references bookings(id) on delete set null,
  student_package_id uuid references student_packages(id) on delete set null,
  amount_cents int not null check (amount_cents > 0),
  method text not null check (method in ('cash','eft','card_link','other')),
  received_by uuid references staff(id) on delete set null,
  note text,
  created_at timestamptz not null default now()
);
create index on payments (student_id);

-- ───────────── helpers ─────────────
-- South African number -> 27XXXXXXXXX (null if it doesn't look valid)
create function norm_phone(p text) returns text language sql immutable as $$
  select case
    when d ~ '^27[1-9]\d{8}$' then d
    when d ~ '^270\d{9}$' then '27' || substr(d, 4)
    when d ~ '^0\d{9}$' then '27' || substr(d, 2)
    when d ~ '^[1-9]\d{8}$' then '27' || d
  end
  from (select regexp_replace(regexp_replace(coalesce(p, ''), '\D', '', 'g'), '^00', '') as d) x
$$;

-- the school of the signed-in staff member (SECURITY DEFINER so policies don't recurse)
create function my_school() returns uuid language sql stable security definer set search_path = public as $$
  select school_id from staff where auth_user_id = auth.uid() and active limit 1
$$;

-- link a pre-created staff row (added by the owner with an email) to the user who just signed in
create function claim_staff() returns void language sql security definer set search_path = public as $$
  update staff set auth_user_id = auth.uid()
  where auth_user_id is null and active and lower(email) = lower(auth.jwt() ->> 'email')
$$;

-- first login: create a school + owner, with a sample lesson type and Mon-Fri 08:00-16:00 hours
create function create_school(p_name text, p_slug text, p_staff_name text, p_whatsapp text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare sid uuid; stid uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if my_school() is not null then raise exception 'You already have a school'; end if;
  insert into schools (name, slug, whatsapp)
    values (btrim(p_name), lower(btrim(p_slug)), norm_phone(p_whatsapp)) returning id into sid;
  insert into staff (school_id, auth_user_id, name, email, role)
    values (sid, auth.uid(), btrim(p_staff_name), auth.jwt() ->> 'email', 'owner') returning id into stid;
  insert into availability (staff_id, weekday, start_time, end_time)
    select stid, d, '08:00', '16:00' from generate_series(1, 5) d;
  insert into lesson_types (school_id, name, minutes, price_cents) values (sid, 'Driving lesson', 60, 35000);
  return sid;
end $$;

-- ───────────── views (RLS applies to the caller) ─────────────
create view package_left with (security_invoker = true) as
select sp.id, sp.student_id, sp.package_id, sp.lessons_total, sp.paid_status, sp.bought_at,
  sp.lessons_total - (select count(*) from bookings b
     where b.student_package_id = sp.id and b.status in ('done','no_show'))::int as remaining
from student_packages sp;

-- credits = sum(lessons_total) - done/no_show lessons charged to a package
-- owing   = packages bought + done/no_show single lessons - payments received
create view student_balance with (security_invoker = true) as
select s.id as student_id, s.school_id, s.name, s.phone, s.pickup_address, s.notes, s.token,
  coalesce((select sum(remaining) from package_left pl where pl.student_id = s.id), 0)::int as credits,
  (coalesce((select sum(p.price_cents) from student_packages sp join packages p on p.id = sp.package_id
              where sp.student_id = s.id), 0)
   + coalesce((select sum(lt.price_cents) from bookings b join lesson_types lt on lt.id = b.lesson_type_id
              where b.student_id = s.id and b.status in ('done','no_show') and b.student_package_id is null), 0)
   - coalesce((select sum(amount_cents) from payments pay where pay.student_id = s.id), 0))::int as owing_cents
from students s;

-- keep student_packages.paid_status in step with payments linked to the package
create function sync_paid() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.student_package_id is not null then
    update student_packages sp set paid_status = case
      when coalesce((select sum(amount_cents) from payments where student_package_id = sp.id), 0)
           >= (select price_cents from packages where id = sp.package_id) then 'paid'
      else 'partial' end
    where sp.id = new.student_package_id;
  end if;
  return new;
end $$;
create trigger payments_sync_paid after insert on payments for each row execute function sync_paid();

-- ───────────── row level security ─────────────
alter table schools enable row level security;
create policy schools_sel on schools for select to authenticated using (id = my_school());
create policy schools_upd on schools for update to authenticated using (id = my_school()) with check (id = my_school());

do $$ declare t text; begin
  foreach t in array array['staff','lesson_types','packages','students','bookings','payments'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for all to authenticated using (school_id = my_school()) with check (school_id = my_school())', t || '_rw', t);
  end loop;
end $$;

alter table availability enable row level security;
create policy availability_rw on availability for all to authenticated
  using (staff_id in (select id from staff where school_id = my_school()))
  with check (staff_id in (select id from staff where school_id = my_school()));

alter table student_packages enable row level security;
create policy student_packages_rw on student_packages for all to authenticated
  using (student_id in (select id from students where school_id = my_school()))
  with check (student_id in (select id from students where school_id = my_school()));

-- ───────────── staff RPC: mark a lesson done / no-show ─────────────
-- Runs as the caller (RLS applies). Charges the oldest package that still has credits.
create function complete_booking(p_id uuid, p_status text) returns jsonb
language plpgsql set search_path = public as $$
declare b bookings; sp uuid; r jsonb;
begin
  if p_status not in ('done','no_show') then raise exception 'Bad status'; end if;
  update bookings set status = p_status where id = p_id returning * into b;
  if not found then raise exception 'Booking not found'; end if;
  if b.student_package_id is null then
    select id into sp from package_left where student_id = b.student_id and remaining > 0 order by bought_at, id limit 1;
    if sp is not null then update bookings set student_package_id = sp where id = p_id; end if;
  end if;
  select jsonb_build_object('name', s.name, 'phone', s.phone, 'token', s.token, 'slug', sc.slug,
                            'credits', coalesce(bal.credits, 0))
    into r
    from students s join schools sc on sc.id = s.school_id
    left join student_balance bal on bal.student_id = s.id
   where s.id = b.student_id;
  return r;
end $$;

-- ───────────── public RPCs (SECURITY DEFINER; the only things anon can call) ─────────────
create function get_school_public(p_slug text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'name', s.name,
    'lesson_minutes', s.lesson_minutes,
    'lesson_types', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'minutes', minutes,
                       'price_cents', price_cents) order by price_cents), '[]') from lesson_types where school_id = s.id and active),
    'packages', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'lessons', lessons,
                       'price_cents', price_cents) order by price_cents), '[]') from packages where school_id = s.id and active),
    'instructors', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]')
                    from staff where school_id = s.id and active
                     and exists (select 1 from availability a where a.staff_id = staff.id)))
  from schools s where s.slug = p_slug
$$;

-- free slots on a date: availability windows cut into lesson_minutes steps, minus existing bookings
create function get_free_slots(p_slug text, p_date date, p_staff uuid default null, p_minutes int default null)
returns table (staff_id uuid, staff_name text, slot_start timestamptz)
language sql stable security definer set search_path = public as $$
  select st.id, st.name, g.s
  from schools sc
  join staff st on st.school_id = sc.id and st.active and (p_staff is null or st.id = p_staff)
  join availability a on a.staff_id = st.id and a.weekday = extract(dow from p_date)::int
  cross join lateral (select coalesce(p_minutes, sc.lesson_minutes) as dur) d
  cross join lateral generate_series(p_date + a.start_time,
                                     p_date + a.end_time - make_interval(mins => d.dur),
                                     make_interval(mins => sc.lesson_minutes)) gs(ts)
  cross join lateral (select gs.ts at time zone 'Africa/Johannesburg' as s) g
  where sc.slug = p_slug
    and g.s > now() + interval '1 hour'
    and not exists (select 1 from bookings b
                    where b.staff_id = st.id and b.status <> 'cancelled'
                      and b.start_at < g.s + make_interval(mins => d.dur) and b.end_at > g.s)
  order by g.s, st.name
$$;

-- book a lesson (or buy a package + book its first lesson). Returns what the success screen needs.
-- The student token is only returned for a NEW student, or when the caller already holds it,
-- so typing someone else's phone number never reveals their token.
create function create_booking(
  p_slug text, p_name text, p_phone text, p_pickup text, p_start timestamptz, p_staff uuid,
  p_lesson_type uuid default null, p_package uuid default null, p_token text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  sc schools; st students; lt lesson_types; pk packages; bk bookings; stf staff;
  ph text := norm_phone(p_phone);
  nm text := btrim(coalesce(p_name, ''));
  addr text := left(btrim(coalesce(p_pickup, '')), 300);
  dur int; due int; sid uuid; is_new boolean;
begin
  select * into sc from schools where slug = p_slug;
  if not found then raise exception 'School not found'; end if;
  if ph is null then raise exception 'Enter a valid South African number, e.g. 082 123 4567'; end if;
  if length(nm) < 2 or length(nm) > 80 then raise exception 'Enter your name'; end if;
  if addr = '' then raise exception 'Enter a pickup address'; end if;
  if p_staff is null then raise exception 'Choose a time'; end if;

  if p_lesson_type is not null then
    select * into lt from lesson_types where id = p_lesson_type and school_id = sc.id and active;
    if not found then raise exception 'Lesson not available'; end if;
    dur := lt.minutes; due := lt.price_cents;
  elsif p_package is not null then
    select * into pk from packages where id = p_package and school_id = sc.id and active;
    if not found then raise exception 'Package not available'; end if;
    select * into lt from lesson_types where school_id = sc.id and active
      order by (minutes = sc.lesson_minutes) desc, price_cents limit 1;
    if not found then raise exception 'This school has no lesson types yet'; end if;
    dur := sc.lesson_minutes; due := pk.price_cents;
  else
    raise exception 'Choose a lesson or package';
  end if;

  if p_start < now() or p_start > now() + interval '60 days' then raise exception 'Pick a valid time'; end if;
  if not exists (select 1 from get_free_slots(p_slug, (p_start at time zone 'Africa/Johannesburg')::date, p_staff, dur) f
                  where f.slot_start = p_start) then
    raise exception 'That time was just taken, please pick another';
  end if;

  insert into students (school_id, name, phone, pickup_address) values (sc.id, nm, ph, addr)
    on conflict (school_id, phone) do update set pickup_address = coalesce(students.pickup_address, excluded.pickup_address)
    returning id, (xmax = 0) into sid, is_new;
  select * into st from students where id = sid;

  if (select count(*) from bookings where student_id = sid and status = 'booked' and start_at > now()) >= 5 then
    raise exception 'You already have several upcoming lessons. Please WhatsApp the school to change them.';
  end if;

  begin
    insert into bookings (school_id, staff_id, student_id, lesson_type_id, start_at, end_at, pickup_address)
      values (sc.id, p_staff, sid, lt.id, p_start, p_start + make_interval(mins => dur), addr) returning * into bk;
  exception when exclusion_violation then
    raise exception 'That time was just taken, please pick another';
  end;

  if pk.id is not null then   -- package purchase: reuse an unpaid, unused one instead of piling up duplicates
    if not exists (select 1 from package_left where student_id = sid and package_id = pk.id
                    and paid_status = 'unpaid' and remaining > 0) then
      insert into student_packages (student_id, package_id, lessons_total) values (sid, pk.id, pk.lessons);
    end if;
  elsif (select coalesce(sum(remaining), 0) from package_left where student_id = sid)
      > (select count(*) from bookings where student_id = sid and status = 'booked' and start_at > now() and id <> bk.id) then
    due := 0;                 -- covered by package credits
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

create function get_student_summary(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'name', s.name, 'phone', s.phone, 'pickup_address', s.pickup_address, 'school', sc.name,
    'credits', (select coalesce(sum(remaining), 0) from package_left where student_id = s.id),
    'upcoming', (select coalesce(jsonb_agg(jsonb_build_object('start_at', b.start_at, 'lesson', lt.name,
                        'instructor', stf.name) order by b.start_at), '[]')
                 from bookings b left join lesson_types lt on lt.id = b.lesson_type_id
                 join staff stf on stf.id = b.staff_id
                 where b.student_id = s.id and b.status = 'booked' and b.start_at > now()))
  from students s join schools sc on sc.id = s.school_id
  where s.token = p_token
$$;

-- ───────────── privileges ─────────────
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke delete on schools from authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function get_school_public(text), get_free_slots(text, date, uuid, int),
  create_booking(text, text, text, text, timestamptz, uuid, uuid, uuid, text),
  get_student_summary(text) to anon, authenticated;
grant execute on function my_school(), claim_staff(), complete_booking(uuid, text),
  create_school(text, text, text, text) to authenticated;
