-- Court Dues — Supabase schema
-- Paste this whole file into the Supabase dashboard: SQL Editor -> New query -> Run.

-- 1) One table. The whole board (players, sessions, payments, courts) lives in a
--    single JSONB blob, which mirrors how the app already works and keeps this
--    dead simple. Last write wins, exactly like the original shared board.
create table if not exists public.boards (
  slug        text primary key,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- 2) Seed the single shared board with your four courts pre-loaded.
insert into public.boards (slug, data)
values (
  'main',
  jsonb_build_object(
    'players',  '[]'::jsonb,
    'sessions', '[]'::jsonb,
    'payments', '[]'::jsonb,
    'courts', jsonb_build_array(
      jsonb_build_object('id', gen_random_uuid()::text, 'name', 'Tyngsborough Sports Center', 'cost', 0),
      jsonb_build_object('id', gen_random_uuid()::text, 'name', 'TJL Training', 'cost', 0),
      jsonb_build_object('id', gen_random_uuid()::text, 'name', 'The Mill Works', 'cost', 0),
      jsonb_build_object('id', gen_random_uuid()::text, 'name', 'Game Time Sports and Fitness', 'cost', 0)
    ),
    'pin', '',
    'seeded', true
  )
)
on conflict (slug) do nothing;

-- 3) Row Level Security.
alter table public.boards enable row level security;

-- OPEN policy (default): anyone with the site can read AND write the board.
-- This matches the original "shared link" trust model — great for a private
-- crew, and the in-app PIN is the same soft lock you already have.
create policy "anyone can read the board"
  on public.boards for select
  using (true);

create policy "anyone can update the board"
  on public.boards for update
  using (true) with check (true);

create policy "anyone can insert the board"
  on public.boards for insert
  with check (true);

-- 4) (Optional) Live updates: let other people's open tabs refresh instantly.
--    Adds the table to Supabase's realtime feed. Safe to skip.
alter publication supabase_realtime add table public.boards;


-- =============================================================================
-- WANT ONLY YOU TO EDIT? (real lock instead of the soft PIN)
-- Turn on an auth provider in Supabase (Auth -> Providers, e.g. magic link),
-- then REPLACE the two write policies above with these so viewers can only read
-- and a signed-in editor can write. You'd also add a tiny login screen to the app
-- (ask and I'll wire it up).
--
--   drop policy "anyone can update the board" on public.boards;
--   drop policy "anyone can insert the board" on public.boards;
--
--   create policy "signed-in can update" on public.boards
--     for update using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
--   create policy "signed-in can insert" on public.boards
--     for insert with check (auth.role() = 'authenticated');
-- =============================================================================
