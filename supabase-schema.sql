-- ============================================================
-- DOXAMI TICKETING — SCHÉMA COMPLET (version corrigée)
-- À exécuter dans Supabase → SQL Editor.
-- Script idempotent : on peut le relancer sans risque, y compris
-- sur une base créée avec l'ancienne version.
-- ============================================================

create extension if not exists "pgcrypto" with schema extensions;

-- ============================================================
-- 1. PROFILS UTILISATEURS
-- ============================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  full_name text,
  created_at timestamptz default now() not null
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Rattrape les comptes créés avant l'installation du trigger
insert into public.profiles (id, email, full_name)
select u.id, u.email, coalesce(u.raw_user_meta_data->>'full_name', '')
from auth.users u
on conflict (id) do nothing;

-- ============================================================
-- 2. ÉVÉNEMENTS
-- ============================================================
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  prefix text not null,
  start_number int not null default 1,
  model_path text,
  thumb_path text,
  model_width int,
  model_height int,
  zones jsonb not null default '{"qr":{"x":40,"y":38,"w":20,"h":22},"num":{"x":40,"y":64,"w":20,"h":6}}'::jsonb,
  created_at timestamptz default now() not null
);

alter table public.events add column if not exists thumb_path text;
create index if not exists events_owner_idx on public.events(owner_id);

-- ============================================================
-- 3. BILLETS
-- seq = numéro entier du billet (sert au tri et à la numérotation)
-- ============================================================
create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  seq int,
  num text not null,
  token text unique not null,
  status text not null default 'valid' check (status in ('valid','used','invalid')),
  scanned_at timestamptz,
  scanned_by uuid references public.profiles(id),
  created_at timestamptz default now() not null,
  unique(event_id, num)
);

alter table public.tickets add column if not exists seq int;
update public.tickets
   set seq = nullif(regexp_replace(num, '\D', '', 'g'), '')::int
 where seq is null;
alter table public.tickets alter column seq set not null;

create unique index if not exists tickets_event_seq_idx on public.tickets(event_id, seq);
create index if not exists tickets_event_idx  on public.tickets(event_id);
create index if not exists tickets_token_idx  on public.tickets(token);
create index if not exists tickets_status_idx on public.tickets(event_id, status);

-- ============================================================
-- 4. HISTORIQUE DES SCANS
-- ============================================================
create table if not exists public.scans (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  ticket_id uuid references public.tickets(id) on delete set null,
  input text not null,
  result text not null check (result in ('valid','used','invalid')),
  scanned_by uuid references public.profiles(id),
  scanned_at timestamptz default now() not null
);

create index if not exists scans_event_idx on public.scans(event_id, scanned_at desc);

-- ============================================================
-- 5. ROW LEVEL SECURITY
-- ============================================================
alter table public.profiles enable row level security;
alter table public.events   enable row level security;
alter table public.tickets  enable row level security;
alter table public.scans    enable row level security;

-- Profils
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

-- Événements
drop policy if exists "events_select_own" on public.events;
create policy "events_select_own" on public.events
  for select using (auth.uid() = owner_id);
drop policy if exists "events_insert_own" on public.events;
create policy "events_insert_own" on public.events
  for insert with check (auth.uid() = owner_id);
drop policy if exists "events_update_own" on public.events;
create policy "events_update_own" on public.events
  for update using (auth.uid() = owner_id);
drop policy if exists "events_delete_own" on public.events;
create policy "events_delete_own" on public.events
  for delete using (auth.uid() = owner_id);

-- Billets : lecture / suppression via le propriétaire de l'événement.
-- Pas d'insert ni d'update direct : tout passe par les fonctions
-- create_tickets() et scan_ticket() ci-dessous (impossible de tricher
-- depuis le navigateur en marquant un billet comme "valide").
drop policy if exists "tickets_select_own" on public.tickets;
create policy "tickets_select_own" on public.tickets
  for select using (
    exists (select 1 from public.events e
            where e.id = event_id and e.owner_id = auth.uid())
  );
drop policy if exists "tickets_insert_own" on public.tickets;
drop policy if exists "tickets_update_own" on public.tickets;
drop policy if exists "tickets_delete_own" on public.tickets;
create policy "tickets_delete_own" on public.tickets
  for delete using (
    exists (select 1 from public.events e
            where e.id = event_id and e.owner_id = auth.uid())
  );

-- Scans : lecture seule côté client (l'écriture se fait dans scan_ticket)
drop policy if exists "scans_select_own" on public.scans;
create policy "scans_select_own" on public.scans
  for select using (
    exists (select 1 from public.events e
            where e.id = event_id and e.owner_id = auth.uid())
  );
drop policy if exists "scans_insert_own" on public.scans;

-- ============================================================
-- 6. FONCTIONS
-- ============================================================

-- 6.1 Jeton aléatoire de 12 caractères (alphabet sans 0/O/1/I)
create or replace function public.gen_ticket_token()
returns text
language plpgsql
volatile
set search_path = public, extensions
as $$
declare
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea := gen_random_bytes(12);
  res   text := '';
  i     int;
begin
  for i in 0..11 loop
    res := res || substr(chars, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  return res;
end;
$$;

-- 6.2 Création de billets (numérotation atomique, sans doublon)
create or replace function public.create_tickets(p_event_id uuid, p_count int)
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_event public.events%rowtype;
  v_last  int;
begin
  if p_count is null or p_count < 1 or p_count > 1000 then
    raise exception 'invalid_count';
  end if;

  -- Verrouille l'événement : deux ajouts simultanés ne se marchent pas dessus
  select * into v_event
    from public.events
   where id = p_event_id and owner_id = auth.uid()
   for update;

  if not found then
    raise exception 'not_authorized';
  end if;

  select coalesce(max(seq), v_event.start_number - 1) into v_last
    from public.tickets where event_id = p_event_id;

  insert into public.tickets (event_id, seq, num, token, status)
  select p_event_id,
         v_last + g,
         v_event.prefix || '-' ||
           case when length((v_last + g)::text) >= 4
                then (v_last + g)::text
                else lpad((v_last + g)::text, 4, '0') end,
         public.gen_ticket_token(),
         'valid'
    from generate_series(1, p_count) as g;

  return v_last + p_count;
end;
$$;

revoke all on function public.create_tickets(uuid, int) from public, anon;
grant execute on function public.create_tickets(uuid, int) to authenticated;

-- 6.3 Statistiques de tous les événements de l'utilisateur
--     (évite la limite de 1000 lignes de l'API)
create or replace function public.get_events_stats()
returns table (event_id uuid, total bigint, used bigint)
language sql
stable
set search_path = public
as $$
  select t.event_id,
         count(*)::bigint,
         (count(*) filter (where t.status = 'used'))::bigint
    from public.tickets t
    join public.events e on e.id = t.event_id
   where e.owner_id = auth.uid()
   group by t.event_id;
$$;

revoke all on function public.get_events_stats() from public, anon;
grant execute on function public.get_events_stats() to authenticated;

-- 6.4 Scan atomique
--     Le QR contient « NUMERO|JETON » : les deux doivent correspondre.
--     La saisie manuelle accepte le numéro seul (ou le jeton seul).
create or replace function public.scan_ticket(p_event_id uuid, p_input text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket public.tickets%rowtype;
  v_user   uuid := auth.uid();
  v_input  text := upper(trim(coalesce(p_input, '')));
  v_num    text;
  v_token  text;
begin
  if v_user is null or not exists (
    select 1 from public.events
     where id = p_event_id and owner_id = v_user
  ) then
    return jsonb_build_object('result', 'error', 'message', 'not_authorized');
  end if;

  if v_input = '' or length(v_input) > 64 then
    return jsonb_build_object('result', 'invalid', 'input', left(v_input, 64));
  end if;

  if position('|' in v_input) > 0 then
    v_num   := split_part(v_input, '|', 1);
    v_token := split_part(v_input, '|', 2);
    select * into v_ticket
      from public.tickets
     where event_id = p_event_id and num = v_num and token = v_token
       for update;
  else
    select * into v_ticket
      from public.tickets
     where event_id = p_event_id
       and (num = v_input or token = v_input)
       for update;
  end if;

  -- Billet inconnu
  if not found then
    insert into public.scans(event_id, input, result, scanned_by)
      values (p_event_id, v_input, 'invalid', v_user);
    return jsonb_build_object('result', 'invalid', 'input', split_part(v_input, '|', 1));
  end if;

  -- Billet annulé
  if v_ticket.status = 'invalid' then
    insert into public.scans(event_id, ticket_id, input, result, scanned_by)
      values (p_event_id, v_ticket.id, v_input, 'invalid', v_user);
    return jsonb_build_object('result', 'invalid', 'num', v_ticket.num, 'input', v_ticket.num);
  end if;

  -- Déjà utilisé
  if v_ticket.status = 'used' then
    insert into public.scans(event_id, ticket_id, input, result, scanned_by)
      values (p_event_id, v_ticket.id, v_input, 'used', v_user);
    return jsonb_build_object(
      'result', 'used',
      'num', v_ticket.num,
      'scanned_at', v_ticket.scanned_at
    );
  end if;

  -- Valide → marquer comme utilisé
  update public.tickets
     set status = 'used', scanned_at = now(), scanned_by = v_user
   where id = v_ticket.id;

  insert into public.scans(event_id, ticket_id, input, result, scanned_by)
    values (p_event_id, v_ticket.id, v_input, 'valid', v_user);

  return jsonb_build_object('result', 'valid', 'num', v_ticket.num);
end;
$$;

revoke all on function public.scan_ticket(uuid, text) from public, anon;
grant execute on function public.scan_ticket(uuid, text) to authenticated;

-- ============================================================
-- 7. STORAGE — BUCKET « models »
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'models', 'models', false, 10485760,
  array['application/pdf','image/jpeg','image/png']
)
on conflict (id) do update
  set public = false,
      file_size_limit = 10485760,
      allowed_mime_types = array['application/pdf','image/jpeg','image/png'];

drop policy if exists "models_select_own" on storage.objects;
create policy "models_select_own" on storage.objects
  for select using (
    bucket_id = 'models' and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "models_insert_own" on storage.objects;
create policy "models_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'models' and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "models_update_own" on storage.objects;
create policy "models_update_own" on storage.objects
  for update using (
    bucket_id = 'models' and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "models_delete_own" on storage.objects;
create policy "models_delete_own" on storage.objects
  for delete using (
    bucket_id = 'models' and (storage.foldername(name))[1] = auth.uid()::text
  );
