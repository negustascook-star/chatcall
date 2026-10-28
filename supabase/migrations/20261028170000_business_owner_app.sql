-- Owner-scoped AIcall business workspace. Apply after the initial demo migration.
create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  address text not null default '',
  phone text not null default '',
  opening_hours jsonb not null default '{}'::jsonb,
  unresolved_contact text not null default '',
  onboarding_complete boolean not null default false,
  plan_code text not null default 'pending' check (plan_code in ('pending','receptionist','warehouse')),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint companies_one_per_owner unique(owner_id)
);
create index if not exists companies_owner_idx on public.companies(owner_id);

create table if not exists public.business_services (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
  name text not null, price_eur numeric(10,2), duration_minutes integer not null default 30 check(duration_minutes > 0),
  active boolean not null default true, created_at timestamptz not null default now()
);
create table if not exists public.specialists (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
  name text not null, qualifications text not null default '', working_schedule jsonb not null default '{}'::jsonb,
  unavailable_periods jsonb not null default '[]'::jsonb, active boolean not null default true, created_at timestamptz not null default now()
);
create table if not exists public.business_faq (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
  question text not null, answer text not null, created_at timestamptz not null default now()
);
create table if not exists public.business_inventory (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
  product_name text not null, sku text not null default '', quantity integer not null default 0 check(quantity >= 0),
  updated_at timestamptz not null default now()
);
create table if not exists public.business_calls (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
  customer_name text not null default '', customer_phone text not null default '', summary text not null default '',
  status text not null default 'completed', created_at timestamptz not null default now()
);
create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
  customer_name text not null, customer_phone text not null, service_name text not null,
  specialist_id uuid references public.specialists(id) on delete set null,
  starts_at timestamptz not null, ends_at timestamptz not null, status text not null default 'confirmed',
  created_at timestamptz not null default now(), check(ends_at > starts_at)
);

alter table public.companies enable row level security;
create policy "owners manage their company" on public.companies for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

do $$ declare t text; begin
  foreach t in array array['business_services','specialists','business_faq','business_inventory','business_calls','appointments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "owners manage company records" on public.%I for all to authenticated using (company_id in (select id from public.companies where owner_id = (select auth.uid()))) with check (company_id in (select id from public.companies where owner_id = (select auth.uid())))', t);
  end loop;
end $$;
revoke all on public.companies, public.business_services, public.specialists, public.business_faq,
  public.business_inventory, public.business_calls, public.appointments from anon, public;
grant select, insert, update, delete on public.companies, public.business_services, public.specialists,
  public.business_faq, public.business_inventory, public.business_calls, public.appointments to authenticated;
-- Owners may edit business details but cannot mark a subscription as paid or
-- grant themselves a trial. Payment/admin code must use the server role.
revoke insert, update on public.companies from authenticated;
grant select on public.companies to authenticated;
grant insert (owner_id, name, address, phone, opening_hours, unresolved_contact, onboarding_complete)
  on public.companies to authenticated;
grant update (name, address, phone, opening_hours, unresolved_contact, onboarding_complete, updated_at)
  on public.companies to authenticated;
alter table public.specialists add constraint specialists_id_company_unique unique (id, company_id);
alter table public.appointments add constraint appointments_specialist_same_company_fk
  foreign key (specialist_id, company_id) references public.specialists(id, company_id);
