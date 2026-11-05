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
