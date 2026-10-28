-- DEMONSTRACINIAI duomenys. Tiekejo kainos ir pristatymo laikai nera realus.
insert into public.services (id, name, duration_minutes, price_eur)
values ('tyre_change', '4 padangų keitimas', 60, 40.00)
on conflict (id) do nothing;

insert into public.mechanics (id, name)
values ('jonas', 'Jonas'), ('mantas', 'Mantas')
on conflict (id) do nothing;

-- Kainos uz viena padanga klientui, paslaugos kaina skaiciuojama atskirai.
insert into public.inventory (
  id, name, tyre_size, season, stock_quantity, stock_price_eur,
  supplier_customer_price_eur, supplier_available_quantity,
  supplier_ready_at, supplier_is_demo
)
values
  ('demo_r16_winter', 'DEMO žieminė R16', '205/55 R16', 'winter', 8, 65.00,
   72.00, 20,
   (((now() at time zone 'Europe/Vilnius')::date + 2) + time '12:00')
     at time zone 'Europe/Vilnius', true),
  ('demo_r17_winter', 'DEMO žieminė R17', '225/45 R17', 'winter', 0, 80.00,
   85.00, 20,
   (((now() at time zone 'Europe/Vilnius')::date + 2) + time '12:00')
     at time zone 'Europe/Vilnius', true)
on conflict (id) do nothing;

-- 2 meistrai x 5 artimiausios darbo dienos x 4 vienos valandos laikai = 40.
-- Siandienos diena neitraukiama. Laikai sudaromi Lietuvos laiko juostoje.
with demo_slots as (
  select
    m.id as mechanic_id,
    s.id as service_id,
    s.duration_minutes,
    (
      (now() at time zone 'Europe/Vilnius')::date
      + d.day_offset + make_time(h.hour_of_day, 0, 0)
    ) at time zone 'Europe/Vilnius' as starts_at
  from public.mechanics m
  cross join public.services s
  cross join generate_series(1, 7) as d(day_offset)
  cross join (values (9), (10), (11), (13)) as h(hour_of_day)
  where m.id in ('jonas', 'mantas')
    and s.id = 'tyre_change'
    and extract(isodow from
      ((now() at time zone 'Europe/Vilnius')::date + d.day_offset)
    ) between 1 and 5
)
insert into public.time_slots (mechanic_id, service_id, starts_at, ends_at)
select mechanic_id, service_id, starts_at,
  starts_at + make_interval(mins => duration_minutes)
from demo_slots
on conflict (mechanic_id, starts_at) do nothing;
