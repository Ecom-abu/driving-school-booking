# Driving school booking PWA

Mobile-first booking + daily run-sheet for South African driving schools.
Plain HTML + vanilla JS + one CSS file. No framework, no npm, no build step. Backend is Supabase; hosting is any static host (Cloudflare Pages).

| File | What it is |
|---|---|
| `index.html` + `app.js` | Instructor/owner app (magic-link login): Today, Tomorrow, Students, Settings |
| `book.html` + `book.js` | Public student booking page, no login |
| `lib.js` | Small helpers shared by both pages (render helper `h()`, Rand, phone, timezone) |
| `config.js` | Your Supabase URL + anon key |
| `schema.sql` | Tables, RLS policies, views, RPC functions |
| `styles.css`, `manifest.json`, `sw.js`, `icon-*.png` | Styling, PWA install, static-asset cache |

## 1. Supabase setup

1. Create a project at <https://supabase.com> (free tier is fine).
2. **SQL Editor → New query**, paste all of `schema.sql`, **Run**. Run it once on a fresh project.
3. **Authentication → URL Configuration**: set **Site URL** to your deployed address (e.g. `https://myschool.pages.dev`) and add the same address, plus `http://localhost:8000`, under **Redirect URLs**.
4. **Authentication → Providers → Email**: keep it enabled (magic link). Supabase's built-in email sender is limited to a handful of emails per hour, so before real use add your own SMTP under **Authentication → SMTP Settings** (Resend, Brevo, etc. have free tiers).
5. **Project Settings → API**: copy the **Project URL** and the **anon public** key into `config.js`. The anon key is meant to be public; RLS protects the data. Never put the `service_role` key anywhere in this folder.

## 2. Run locally

```bash
python3 -m http.server 8000
```

Open <http://localhost:8000>, enter your email, tap the link in the email. First login shows **Set up your driving school** (name, booking link name, your name, WhatsApp number). That creates the school, you as owner, one sample lesson type (R 350 / 60 min) and Mon–Fri 08:00–16:00 hours. Then go to **Settings** to set your real lesson types, packages, hours, EFT details and card link.

Your public page is `http://localhost:8000/book.html?s=<your-link-name>`.

**Adding an instructor:** Settings → Add instructor, fill in their *login email*. When they sign in with that email they are linked automatically. Instructors see only their own lessons on Today/Tomorrow; owners see everyone's.

## 3. Deploy to Cloudflare Pages

Either:

- **Drag and drop:** Cloudflare dashboard → **Workers & Pages → Create → Pages → Upload assets**, drag this whole folder in. Re-upload to update.
- **Git:** push this repo to GitHub, then **Create → Pages → Connect to Git**. Framework preset **None**, build command **blank**, output directory **`/`**.

Afterwards put the final address into Supabase **Site URL / Redirect URLs** (step 1.3), and optionally into `SITE_URL` in `config.js` (used when building links sent over WhatsApp).

Cloudflare Pages redirects `/book.html` to `/book` (keeping the query string). Open `…/book.html?s=<slug>&p=<token>` once after deploying to confirm the `s` and `p` parameters survive on your account.

After a deploy that changes JS/CSS, bump `V` in `sw.js` (e.g. `ds-v2`) so phones pick up the new files.

## 4. Add the booking link to Google Business Profile

1. Open your profile on Google Search/Maps (signed in as the owner) → **Edit profile**.
2. Go to **Bookings** (appears under "Business info" for eligible categories) → **Add booking link**.
3. Paste the link from **Settings → Your booking link** (`https://<your-site>/book.html?s=<slug>`) and save.

If your profile does not show a Bookings option, add the same link as the **Website** or an **Appointment link** under Edit profile → Business info, and in your WhatsApp business profile.

## How it behaves

- **Slots** are the instructor's availability windows cut into steps of the school's *slot length*, minus existing bookings, at least 1 hour from now. Double-booking is blocked by a database constraint.
- **Students** are matched by phone number (`27XXXXXXXXX`, entered as 082… or +27…). Their personal link `book.html?s=<slug>&p=<token>` shows "you have N lessons left" and a one-tap *Book next lesson*.
- **Done** marks the lesson, charges the student's oldest package with credits left, then opens WhatsApp with the thank-you + rebooking link. **No-show** also uses a package lesson.
- **Credits** = lessons in packages − done/no-show lessons charged to a package. **Owes** = packages bought + single done lessons − payments recorded.
- **Payments** (cash/EFT/card) are recorded by staff under Students → Record payment / Sell package. Nothing is charged online; "Pay now" just opens your card link.
- **Route all pickups** builds one Google Maps link (start = your location, last pickup = destination). Mobile Maps often accepts only 3 waypoints, so with more than 4 stops it offers split legs.
- Everything uses Africa/Johannesburg time.

## Security notes

- Public visitors (anon) can only call four RPCs: `get_school_public`, `get_free_slots`, `create_booking`, `get_student_summary`. They have no direct table access.
- EFT/card details are only returned to someone who has just made a booking, not by the school-info call.
- `create_booking` only returns a student's token for a new student or when the caller already holds it, so entering a stranger's phone number does not expose their account. It also caps a student at 5 upcoming lessons.
- There is no CAPTCHA or rate limit on public booking (the RPC only caps each student at 5 upcoming lessons). If you get spam, add Cloudflare Turnstile to `book.html` and verify it before calling `create_booking`.
- Staff can read/write everything in their own school (per the spec); owner-vs-instructor restrictions are not enforced in RLS.
- Anyone who can sign in can create a *new, separate* school. Turn off sign-ups in Supabase Auth once your staff have signed in if you don't want that.

## Not included (ideas for next)

Staff-side manual booking, rescheduling, student self-cancel, owner-only settings, push notifications, bundled Supabase JS for full offline use.
