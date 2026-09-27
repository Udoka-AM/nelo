-- The landing page's waitlist, as applied to the nelo Supabase project
-- (migration "waitlist"). The site holds only the publishable key, so the
-- public can add a row and do nothing else: no reading, updating or deleting.
-- Everything a browser could get wrong is checked here, not trusted to it.
create table public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique
    check (email = lower(email))
    check (char_length(email) between 6 and 254)
    check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role text not null check (role in ('merchant', 'payer')),
  page text not null default 'business' check (page in ('business', 'pay')),
  created_at timestamptz not null default now()
);

comment on table public.waitlist is
  'Sign-ups from the nelo landing page. Insert-only for anon; read it from the dashboard.';

alter table public.waitlist enable row level security;

-- Only inserts, and only of new rows with the defaults the database sets.
create policy "anyone can join the waitlist"
  on public.waitlist for insert
  to anon, authenticated
  with check (true);

revoke all on public.waitlist from anon, authenticated;
grant insert (email, role, page) on public.waitlist to anon, authenticated;
