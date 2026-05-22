create table if not exists public.gallinero_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.gallinero_state enable row level security;

drop policy if exists "gallinero_state_select" on public.gallinero_state;
drop policy if exists "gallinero_state_insert" on public.gallinero_state;
drop policy if exists "gallinero_state_update" on public.gallinero_state;

create policy "gallinero_state_select"
on public.gallinero_state
for select
to anon
using (true);

create policy "gallinero_state_insert"
on public.gallinero_state
for insert
to anon
with check (true);

create policy "gallinero_state_update"
on public.gallinero_state
for update
to anon
using (true)
with check (true);
