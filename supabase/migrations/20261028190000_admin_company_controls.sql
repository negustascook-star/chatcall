-- Platform administrator controls: suspend and restore a business without
-- deleting its data. Deleting still relies on the existing ON DELETE CASCADE
-- relations from 20261028170000_business_owner_app.sql.
alter table public.companies add column if not exists suspended_at timestamptz;
alter table public.companies add column if not exists suspended_reason text not null default '';
create index if not exists companies_suspended_idx
  on public.companies(suspended_at) where suspended_at is not null;

comment on column public.companies.suspended_at is
  'Set by the platform administrator to block the owner workspace. NULL means active.';
comment on column public.companies.suspended_reason is
  'Optional message shown to the owner while the business is suspended.';

-- Owners must still be able to read their own company so app.html can render the
-- suspension notice. Writes are only allowed while suspended_at is NULL.
drop policy if exists "owners manage their company" on public.companies;
drop policy if exists "owners read their company" on public.companies;
create policy "owners read their company" on public.companies for select to authenticated
  using (owner_id = (select auth.uid()));
create policy "owners manage their company" on public.companies for all to authenticated
  using (owner_id = (select auth.uid()) and suspended_at is null)
  with check (owner_id = (select auth.uid()) and suspended_at is null);

-- Suspend child records too: a suspended owner cannot keep editing services,
-- specialists, appointments, calls, inventory or FAQs through the REST API.
-- The administrator uses the server secret key, which bypasses RLS.
do $$ declare t text; begin
  foreach t in array array['business_services','specialists','business_faq','business_inventory','business_calls','appointments'] loop
    execute format('drop policy if exists "owners manage company records" on public.%I', t);
    execute format(
      'create policy "owners manage company records" on public.%I for all to authenticated '
      'using (company_id in (select id from public.companies where owner_id = (select auth.uid()) and suspended_at is null)) '
      'with check (company_id in (select id from public.companies where owner_id = (select auth.uid()) and suspended_at is null))',
      t
    );
  end loop;
end $$;
