# Driving school booking PWA

Mobile-first booking + daily run-sheet for South African driving schools.
Plain HTML + vanilla JS + one CSS file. No framework, no npm, no build step. Backend is Supabase; hosting is Cloudflare Pages (repo root served as-is).

| File | What it is |
|---|---|
| `index.html` + `app.js` | Staff app (magic-link login): Today/Tomorrow, Week, Students, Money, Settings |
| `book.html` + `book.js` | Public booking page + student self-service (`?s=<slug>&p=<token>`) |
| `lib.js` | Shared helpers: render helper `h()`, icons, sheets, toasts, Rand, phone, timezone |
| `config.js` | Supabase URL + anon key (+ optional `SITE_URL`) |
| `schema.sql` | Full schema for a **fresh** install (original + upgrade 002) |
| `migrations/002_upgrade.sql` | Upgrade for a database that already has the original schema |
| `styles.css`, `manifest.json`, `sw.js`, `icon-*.png` | Design system, PWA install, static-file cache |

## Upgrading an existing install (do this first)

1. Supabase → **SQL Editor → New query** → paste all of **`migrations/002_upgrade.sql`** → **Run**.
   It is safe on the live database and safe to run twice (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP POLICY IF EXISTS`).
2. Deploy the new files to Cloudflare Pages (Git push or drag-and-drop).
3. Open the staff app → **Settings** and set: brand colour/logo, booking rules (slot interval, buffer, notice, cancel cutoff, no-show rule), package validity, instructor phone numbers (for the daily schedule) and any time off.

New installs run only `schema.sql`.

## What changed (upgrade 002)

**1. 30-minute slots.** Start times every `schools.slot_interval_minutes` (default 30) inside each instructor's hours. Lesson length comes from the lesson type (60/90/120). `buffer_minutes` adds travel time around every booking. `blocked_times` covers leave and holidays (`staff_id` empty = whole school). Slots inside `min_notice_hours` (default 2) are hidden from students. Staff can book with no notice.

**2. Design.**
- A new design system: Inter font, tokens, cards, bottom sheets, confirm sheets, toasts, skeleton loaders, empty states, focus rings, inline SVG icons and reduced-motion support.
- Per-school `brand_color` and `logo_url`.
- The booking page has a branded header and 4-step progress (Lesson → Time → Details → Confirm).
- Packages show "Save R… vs single lessons". Slots are grouped Morning/Afternoon/Evening, with a sticky bottom button.
- The success screen has calendar and .ics, and payment by cash on the day, EFT (with a copy button) or card link.
- The staff app has bottom tabs and a colour-coded week calendar for each instructor.

**3. Student self-service.**
- The personal link (`?p=token`) shows lessons left, package expiry, a countdown to the K53 test and upcoming lessons.
- Students can reschedule or cancel themselves up to `cancel_cutoff_hours` before (default 24). Inside the cutoff they see "WhatsApp the school".

**4. Staff booking and roles.**
- The **+** button books a student: search or add one, pick any instructor, and optionally repeat weekly for N weeks. Weeks that aren't free are skipped and listed.
- Staff can reschedule or cancel from any lesson's ⋯ menu, with an optional WhatsApp to the student.
- **Roles are enforced in RLS:**
  - Owners see and edit everything.
  - Instructors only read and write their own bookings and payments. They can't change settings, hours, prices or packages.
  - Instructors can still find, add and edit students and sell packages.

**5. Today and Tomorrow.**
- Today shows a lesson count, total cash to collect, a route-all-pickups link, and Navigate / Remind / Done / No-show on each lesson.
- Done uses up a credit and opens the WhatsApp rebooking message.
- No-show follows `schools.no_show_rule`:
  - `credit` uses a package lesson, or the student owes the price.
  - `owe` always charges the lesson price.
  - `free` charges nothing.
- Tomorrow has a reminder button per student. Owners also get "Send schedule to <instructor>": times, students, pickups and cash to collect, sent on WhatsApp.

**6. Packages and money.**
- `packages.valid_days` (default 180). `student_packages.expires_at` is set automatically, and expired packages give no credits.
- Money tab (owner only): received, packages sold, outstanding total, single lessons, cash collected today per instructor, an outstanding-balances list with a WhatsApp payment reminder, unpaid lessons, and recent payments. You can switch between today, this week and this month.

**7. Safety and polish.**
- Public booking checks: a hidden honeypot field, max 3 bookings per phone per day, max 5 upcoming per student, and friendlier error messages.
- Student profiles have K53 test date and venue, notes, history, packages and payments.
- Better manifest. The service worker caches static files only: network-first for our own files, so a deploy is picked up immediately, and cache-first for the pinned supabase-js file.

## Decisions I made

- **`config.js`:** the `SITE_URL` line on main was a JavaScript syntax error that stopped both pages loading. I set it to `''`, so links use the address the app is opened from. Your keys are unchanged. If you set it, use your stable production address, not a per-deploy URL like `https://19aade98.….pages.dev`.
- **Fresh installs:** `schema.sql` is the original schema followed by the 002 upgrade verbatim, so one file still sets up everything. `migrations/002_upgrade.sql` is the source of truth for the changes.
- **Slots:** free slots are computed on a grid that starts at each availability window's start time. Staff bookings use the same grid, with no minimum notice. There is no off-grid manual time entry.
- **Buffer:** the travel buffer applies on both sides of existing bookings. The database's double-booking constraint only blocks real overlaps, so lessons can be back-to-back if the buffer is 0.
- **Package lessons:** these use `lesson_minutes` ("package lesson length") and the lesson type that matches that length.
- **Balances:** `student_balance` and the new `package_status` view run with the owner's rights but filter to your school. This way instructors, who can only see their own bookings and payments, still get correct balances. The `package_left` view is internal only.
- **"Cash to collect":** for each student it's any old debt plus the price of today's lessons not covered by package credits.
- **Instructor visibility:** instructors see all students in the school, so they can find and book anyone, but only their own lessons.
- **Reschedule:** students may pick another instructor when moving a lesson. The same instructor is preselected.
- **Rate limits:** "3 bookings per day" counts bookings *created* in the last 24 hours for that phone number.
- **Staff cancellations:** these offer a WhatsApp notice with the rebooking link.
- **Week calendar:** shows 06:00–20:00, widened automatically if a lesson falls outside. Colours are per instructor, faded means done, striped means no-show.
- **Logo:** you paste an image URL. There is no upload, to keep the stack static.

## First-time setup (new project)

1. Create a Supabase project and run **`schema.sql`** in the SQL Editor.
2. **Authentication → URL Configuration**: set Site URL and Redirect URLs to your Pages address (plus `http://localhost:8000` for testing). Add your own SMTP under Authentication → SMTP Settings, because the built-in sender only sends a few emails per hour.
3. Put the Project URL and anon/publishable key in `config.js`.
4. Run locally with `python3 -m http.server 8000`, open <http://localhost:8000>, sign in, then create your school.
5. Add instructors in Settings with their login email. When they sign in with it they are linked automatically as instructors.

## Deploy to Cloudflare Pages

- **Git:** Workers & Pages → Create → Pages → Connect to Git. Framework **None**, build command **blank**, output directory **`/`**.
- **Drag and drop:** Create → Pages → Upload assets, then drop this folder.

Pages redirects `/book.html` to `/book` and keeps the query string, so both links work.

## Google Business Profile

Edit profile → **Bookings** → Add link → paste the link from Settings (`https://<your-site>/book.html?s=<slug>`). If your category has no Bookings option, add it as the Website or Appointment link.

## Security notes

- Anonymous visitors can only call these RPCs: `get_school_public`, `get_free_slots`, `create_booking`, `get_student_summary`, `student_cancel`, `student_reschedule`. They have no table access.
- A student token is only returned to a new student or to someone who already holds it.
- The honeypot and limits slow down spam but are not a CAPTCHA. If you get abuse, add Cloudflare Turnstile.

## Not included yet

Logo upload, SMS, automatic (scheduled) WhatsApp reminders (they are one tap, sent by staff), online card payment confirmation, and offline mode for the staff app.
