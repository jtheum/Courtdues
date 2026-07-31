# Court Dues

Pickup-run payment tracker for your basketball group. React + Vite frontend,
Supabase (Postgres) for the shared board. Free to run; you only pay for a domain.

---

## 1. Set up the database (Supabase)

1. Go to **supabase.com**, sign up, and create a new project. Pick a strong DB
   password (you won't need it day to day) and the region closest to you.
2. When it's ready, open **SQL Editor -> New query**, paste the entire contents
   of `supabase/schema.sql`, and click **Run**. This creates the `boards` table,
   turns on security, and seeds your four courts.
3. Go to **Project Settings -> API** and copy two things:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - **anon public** key (a long token; safe to use in the frontend)

## 2. Run it locally (optional but recommended)

You need Node.js 18+ installed.

```bash
cp .env.example .env      # then paste your URL + anon key into .env
npm install
npm run dev
```

Open the local URL it prints. Add a player, log a session — refresh to confirm
it saved to Supabase.

## 3. Put it online (Vercel — free)

1. Push this folder to a new **GitHub** repo.
2. Go to **vercel.com**, sign in with GitHub, and **Import** the repo.
   Vercel auto-detects Vite (build `npm run build`, output `dist`).
3. Before deploying, add two **Environment Variables**:
   - `VITE_SUPABASE_URL` = your Project URL
   - `VITE_SUPABASE_ANON_KEY` = your anon public key
4. Deploy. You get a live `your-app.vercel.app` link in about a minute.

(Netlify and Cloudflare Pages work identically — same build command, same two
env vars.)

## 4. Add your domain

1. Buy a domain. Cheapest options: **Cloudflare Registrar** (at-cost, ~$10/yr for
   a `.com`), **Porkbun**, or **Namecheap**. If `courtdues.com` is taken, try
   `courtdues.app`, `getcourtdues.com`, or `courtdues.io`.
2. In Vercel: **Project -> Settings -> Domains -> Add**, type your domain.
3. Vercel shows you a DNS record to add at your registrar:
   - Subdomain (e.g. `dues.courtdues.com`) -> add a **CNAME** to the value Vercel gives.
   - Bare/apex (`courtdues.com`) -> add the **A record** Vercel gives.
4. Save. SSL (https) is issued and renewed automatically — nothing to manage.

Done. Share the link with the crew.

---

## Good to know

- **The 7-day nap.** On Supabase's free plan a project pauses after a week with
  zero activity, then you just click **Restore** in the dashboard. Your group
  plays weekly so this rarely bites; between seasons it might. (Optional fix: a
  free uptime pinger like cron-job.org hitting your site once a day keeps it awake.)
- **No backups on free.** If it ever matters, the $25/mo Pro plan adds daily
  backups — overkill for this, but that's the lever.
- **Who can edit.** Right now anyone with the link can edit, same as before, with
  the in-app PIN as a soft lock. To make it truly you-only, see the commented
  section at the bottom of `supabase/schema.sql`.
- **Tailwind.** Styling loads from the Tailwind Play CDN in `index.html` — zero
  config. It logs a "not for production" note in the console; harmless at this
  scale. To silence it, install Tailwind as a dev dependency later.
