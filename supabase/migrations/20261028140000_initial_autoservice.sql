-- Vieno autoserviso demonstracija. Paleiskite visa faila per Supabase SQL Editor.
-- Visos kainos yra EUR. Tiekejo duomenys yra DEMONSTRACINIAI.
-- Esamas penkiu lenteliu demonstracinis modelis; taikomas vienam autoservisui.


create table if not exists public.services (
  id text primary key,
  name text not null,
  duration_minutes integer not null check (duration_minutes > 0),
  price_eur numeric(10,2) not null check (price_eur >= 0)
);

create table if not exists public.mechanics (
  id text primary key,
  name text not null
);

create table if not exists public.inventory (
  id text primary key,
  name text not null,
  tyre_size text not null,
  season text not null check (season in ('winter', 'summer', 'all_season')),
  stock_quantity integer not null default 0 check (stock_quantity >= 0),
  stock_price_eur numeric(10,2) not null check (stock_price_eur >= 0),
  supplier_customer_price_eur numeric(10,2) check (supplier_customer_price_eur >= 0),
  supplier_available_quantity integer not null default 0 check (supplier_available_quantity >= 0),
  supplier_ready_at timestamptz,
  supplier_is_demo boolean not null default true
);

create table if not exists public.time_slots (
  id bigint generated always as identity primary key,
  mechanic_id text not null references public.mechanics(id),
  service_id text not null references public.services(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  constraint time_slots_positive_duration check (ends_at > starts_at),
  constraint time_slots_mechanic_start_unique unique (mechanic_id, starts_at)
);

-- Viena rezervacija vienam paruostam laikui. Kainos fiksuojamos rezervavimo metu.
create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  slot_id bigint not null unique references public.time_slots(id),
  customer_name text not null check (length(btrim(customer_name)) > 0),
  customer_phone text not null check (length(btrim(customer_phone)) > 0),
  inventory_id text not null references public.inventory(id),
  quantity integer not null check (quantity > 0),
  fulfillment_source text not null check (fulfillment_source in ('stock', 'supplier')),
  tyre_unit_price_eur numeric(10,2) not null check (tyre_unit_price_eur >= 0),
  service_price_eur numeric(10,2) not null check (service_price_eur >= 0),
  total_price_eur numeric(12,2) generated always as
    (quantity * tyre_unit_price_eur + service_price_eur) stored,
  created_at timestamptz not null default now()
);

-- Duomenu prieiga per serveri. SQL Editor ir Table Editor lieka prieinami savininkui.
alter table public.services enable row level security;
alter table public.mechanics enable row level security;
alter table public.inventory enable row level security;
alter table public.time_slots enable row level security;
alter table public.bookings enable row level security;

revoke all on table public.services, public.mechanics, public.inventory,
  public.time_slots, public.bookings from public, anon, authenticated;
revoke all on sequence public.time_slots_id_seq from public, anon, authenticated;

grant select, insert, update, delete on table public.services, public.mechanics,
  public.inventory, public.time_slots, public.bookings to service_role;
grant usage, select on sequence public.time_slots_id_seq to service_role;

