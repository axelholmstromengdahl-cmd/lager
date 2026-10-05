-- =====================================================================
--  LAGERAPP (klänningar) – databas och säkerhetsregler
--  Kör HELA filen i Supabase: SQL Editor -> New query -> Run
--  Filen går att köra igen utan att data försvinner.
-- =====================================================================
--  Säkerhetsprincip: webbläsaren får ALDRIG ändra tabeller direkt.
--  All logik går via funktioner som kontrollerar rollen i databasen.
--  Row Level Security (RLS) är på för alla tabeller.
-- =====================================================================

-- ---------- Roller ----------
do $$ begin
  create type public.app_role as enum ('admin', 'worker');
exception when duplicate_object then null; end $$;

-- ---------- Tabeller ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text not null check (char_length(full_name) between 1 and 80),
  role        public.app_role not null default 'worker',
  created_at  timestamptz not null default now()
);

-- En rad = en klänningsmodell i en färg och en storlek (egen QR-kod)
create table if not exists public.products (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null check (char_length(name) between 1 and 120),   -- modell
  color                text not null default '' check (char_length(color) <= 40),
  size                 text not null default '' check (char_length(size) <= 20),
  -- Artikelnummer i webbshoppen (valfritt, används när webbshop-kopplingen aktiveras)
  sku                  text unique check (sku is null or char_length(sku) between 1 and 64),
  -- Slumpad kod som ligger i QR-koden (går inte att gissa)
  code                 text not null unique default replace(gen_random_uuid()::text, '-', ''),
  quantity             integer not null default 0 check (quantity >= 0),
  total_added          integer not null default 0 check (total_added >= 0),
  low_stock_threshold  integer not null default 2 check (low_stock_threshold >= 0),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
-- Streckkod som redan sitter på klänningens lapp (EAN m.m.), valfri
alter table public.products add column if not exists barcode text unique
  check (barcode is null or (barcode ~ '^[^[:cntrl:]]{3,120}$' and barcode !~ '^[0-9a-f]{32}$'));
update public.products set barcode = upper(barcode) where barcode <> upper(barcode);
-- (för den som redan kört en äldre version av filen)
alter table public.products add column if not exists color text not null default '';
alter table public.products add column if not exists size  text not null default '';
-- Klänningar som skapas automatiskt vid skanning har inget räknat lagersaldo
alter table public.products add column if not exists track_stock boolean not null default true;
alter table public.products add column if not exists sku   text unique;

create table if not exists public.stock_movements (
  id          bigint generated always as identity primary key,
  product_id  uuid not null references public.products(id) on delete cascade,
  user_id     uuid references public.profiles(id) on delete set null,
  change      integer not null,          -- negativt = uttag, positivt = påfyllning
  source      text not null default 'app' check (source in ('app', 'webbshop')),
  created_at  timestamptz not null default now()
);
alter table public.stock_movements add column if not exists source text not null default 'app';
-- Foto på utskick: sökväg till bilden och en liten miniatyr
alter table public.stock_movements add column if not exists photo_path text
  check (photo_path is null or photo_path ~ '^[0-9]{4}/[0-9]{2}/[0-9a-f-]{36}[.]jpg$');
alter table public.stock_movements add column if not exists photo_thumb text
  check (photo_thumb is null or (char_length(photo_thumb) <= 24000 and photo_thumb like 'data:image/jpeg;base64,%'));
create index if not exists stock_movements_created_idx on public.stock_movements (created_at desc);

-- Webbshop-ordrar som redan dragits från lagret (så att samma order aldrig dras två gånger)
create table if not exists public.shop_orders (
  order_ref   text primary key check (char_length(order_ref) between 1 and 100),
  created_at  timestamptz not null default now()
);

-- ---------- RLS på ----------
alter table public.profiles        enable row level security;
alter table public.products        enable row level security;
alter table public.stock_movements enable row level security;
alter table public.shop_orders     enable row level security;   -- inga policys = ingen i appen kommer åt den

revoke all on public.profiles, public.products, public.stock_movements, public.shop_orders from anon, authenticated;
grant select on public.profiles, public.products, public.stock_movements to authenticated;
grant delete on public.products to authenticated;

-- ---------- Hjälpfunktioner ----------
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false) $$;

create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.profiles where id = auth.uid()) $$;

-- ---------- Policys (vem får läsa vad) ----------
drop policy if exists "profil: egen eller admin" on public.profiles;
create policy "profil: egen eller admin" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());

drop policy if exists "produkter: admin läser" on public.products;
create policy "produkter: admin läser" on public.products
  for select to authenticated using (public.is_admin());

drop policy if exists "produkter: admin tar bort" on public.products;
create policy "produkter: admin tar bort" on public.products
  for delete to authenticated using (public.is_admin());

drop policy if exists "historik: admin läser" on public.stock_movements;
create policy "historik: admin läser" on public.stock_movements
  for select to authenticated using (public.is_admin());

-- ---------- Funktioner som appen anropar ----------
drop function if exists public.lookup_product(text);
drop function if exists public.create_product(text, integer, integer);
drop function if exists public.create_product(text, integer, integer, text, text, text);
drop function if exists public.current_role_name();

-- Arbetare + admin: slå upp klänning från QR-kod
create function public.lookup_product(p_code text)
returns table (id uuid, name text, color text, size text, quantity integer)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_staff() then raise exception 'Ingen behörighet'; end if;
  if p_code is null or char_length(p_code) > 64 then raise exception 'Ogiltig kod'; end if;
  return query select p.id, p.name, p.color, p.size, p.quantity from public.products p
    where p.code = lower(p_code) or p.barcode = upper(p_code) limit 1;
end $$;

-- Arbetare + admin: ta bort från lager (skicka), med valfritt foto
drop function if exists public.remove_stock(text, integer);
create or replace function public.remove_stock(
  p_code text, p_amount integer default 1, p_photo_path text default null, p_photo_thumb text default null)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare v_id uuid; v_qty integer;
begin
  if not public.is_staff() then raise exception 'Ingen behörighet'; end if;
  if p_amount is null or p_amount < 1 or p_amount > 1000 then raise exception 'Ogiltigt antal'; end if;
  if p_photo_path is not null and p_photo_path !~ '^[0-9]{4}/[0-9]{2}/[0-9a-f-]{36}[.]jpg$' then raise exception 'Ogiltigt foto'; end if;
  if p_photo_thumb is not null and (char_length(p_photo_thumb) > 24000 or p_photo_thumb not like 'data:image/jpeg;base64,%')
    then raise exception 'Ogiltigt foto'; end if;

  update public.products
     set quantity = quantity - p_amount, updated_at = now()
   where (code = lower(p_code) or barcode = upper(p_code)) and quantity >= p_amount
  returning id, quantity into v_id, v_qty;

  if v_id is null then
    if exists (select 1 from public.products where code = lower(p_code) or barcode = upper(p_code))
      then raise exception 'Det finns inte så många kvar i lager';
      else raise exception 'Produkten hittades inte';
    end if;
  end if;

  insert into public.stock_movements (product_id, user_id, change, photo_path, photo_thumb)
  values (v_id, auth.uid(), -p_amount, p_photo_path, p_photo_thumb);
  return v_qty;
end $$;

-- Arbetare + admin: lista att välja klänning från (för den som saknar etiketter)
create or replace function public.staff_products()
returns table (name text, color text, size text, quantity integer, code text)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_staff() then raise exception 'Ingen behörighet'; end if;
  return query select p.name, p.color, p.size, p.quantity, p.code from public.products p
    order by p.name, p.color, p.size;
end $$;

-- Arbetare + admin: koderna som kameran ska känna igen när den läser skriven text
create or replace function public.staff_codes()
returns table (barcode text)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_staff() then raise exception 'Ingen behörighet'; end if;
  return query select p.barcode from public.products p where p.barcode is not null;
end $$;

-- Admin: lägg till klänning (modell + färg + storlek)
create or replace function public.create_product(
  p_name text, p_quantity integer, p_threshold integer default 2,
  p_color text default '', p_size text default '', p_sku text default null, p_barcode text default null)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare v_id uuid;
begin
  if not public.is_admin() then raise exception 'Endast admin'; end if;
  if p_quantity is null or p_quantity < 0 or p_quantity > 1000000 then raise exception 'Ogiltigt antal'; end if;

  insert into public.products (name, color, size, sku, barcode, quantity, total_added, low_stock_threshold)
  values (trim(p_name), trim(coalesce(p_color, '')), trim(coalesce(p_size, '')),
          nullif(trim(coalesce(p_sku, '')), ''), upper(nullif(trim(coalesce(p_barcode, '')), '')),
          p_quantity, p_quantity, greatest(coalesce(p_threshold, 2), 0))
  returning id into v_id;

  if p_quantity > 0 then
    insert into public.stock_movements (product_id, user_id, change) values (v_id, auth.uid(), p_quantity);
  end if;
  return v_id;
exception
  when unique_violation then raise exception 'Artikelnumret eller streckkoden används redan';
  when check_violation then raise exception 'Ogiltig streckkod';
end $$;

-- Admin: koppla (eller ta bort) streckkod på en befintlig klänning
create or replace function public.set_barcode(p_product uuid, p_barcode text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'Endast admin'; end if;
  update public.products set barcode = upper(nullif(trim(coalesce(p_barcode, '')), '')), updated_at = now()
   where id = p_product;
  if not found then raise exception 'Produkten hittades inte'; end if;
exception
  when unique_violation then raise exception 'Artikelnumret eller streckkoden används redan';
  when check_violation then raise exception 'Ogiltig streckkod';
end $$;

-- Klänningar med samma namn/gruppnyckel: första delen av en kod, t.ex. "BLA" i "BLA-RO-M".
-- Används som gruppnyckel. Rena sifferkoder (vanliga streckkoder) har ingen sådan del.
create or replace function public.code_key(p_code text)
returns text
language sql immutable set search_path = ''
as $$
  select case
    when p_code is null or upper(p_code) ~ '^[0-9]+$' then null
    when upper(p_code) ~ '[-_. ]' then nullif(split_part(regexp_replace(upper(p_code), '[-_. ]+', '-', 'g'), '-', 1), '')
    when upper(p_code) ~ '^[A-Z]{2,}[0-9]' then substring(upper(p_code) from '^[A-Z]+')
    else upper(p_code)
  end
$$;

-- Namnet en ny kod får: samma namn som andra koder med samma första del,
-- annars första delen själv. Sifferkoder heter "Streckkod <nummer>" tills de döps om.
create or replace function public.code_name(p_code text)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare v_key text := public.code_key(p_code); v_name text;
begin
  if v_key is null then return 'Streckkod ' || upper(p_code); end if;
  select p.name into v_name from public.products p
   where p.barcode is not null and public.code_key(p.barcode) = v_key
   order by p.created_at limit 1;
  return coalesce(v_name, v_key);
end $$;

-- Delar upp en kod: "BLA-RO-M" -> nyckel BLA, färgdel RO, storleksdel M
create or replace function public.code_parts(p_code text, out key text, out color_part text, out size_part text)
language plpgsql immutable set search_path = ''
as $$
declare c text := upper(coalesce(p_code, '')); parts text[]; n integer;
begin
  key := public.code_key(p_code); color_part := ''; size_part := '';
  if key is null then return; end if;
  if c ~ '[-_. ]' then
    parts := array_remove(string_to_array(regexp_replace(c, '[-_. ]+', '-', 'g'), '-'), '');
    n := coalesce(array_length(parts, 1), 0);
    if n >= 3 then
      size_part := parts[n];
      color_part := array_to_string(parts[2:n-1], ' ');
    elsif n = 2 then
      if parts[2] ~ '^(XXS|XS|S|M|L|XL|XXL|XXXL|[0-9]{2,3})$' then size_part := parts[2]; else color_part := parts[2]; end if;
    end if;
  elsif c ~ '^[A-Z]{2,}[0-9]' then
    size_part := substring(c from '[0-9].*$');
  end if;
end $$;

-- Färgen en ny kod får: samma färg som en tidigare kod med samma färgdel
-- (t.ex. "Rosa" om någon redan rättat RO till Rosa), annars färgdelen själv.
create or replace function public.code_color(p_code text)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare v record; v_color text;
begin
  select * into v from public.code_parts(p_code);
  if v.key is null or v.color_part = '' then return ''; end if;
  select p.color into v_color from public.products p
   where p.barcode is not null and p.color <> '' and (public.code_parts(p.barcode)).color_part = v.color_part
   order by (public.code_key(p.barcode) = v.key) desc, p.updated_at desc limit 1;
  return coalesce(v_color, v.color_part);
end $$;

-- Vad en skannad kod är. Nytt: new_group säger om namnet är en helt ny grupp.
create or replace function public.scan_info(p_code text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare r record; v_name text;
begin
  if not public.is_staff() then raise exception 'Ingen behörighet'; end if;
  if p_code is null or p_code !~ '^[^[:cntrl:]]{3,120}$' then raise exception 'Ogiltig kod'; end if;
  select p.id, p.name, p.color, p.size, p.quantity, p.track_stock into r
    from public.products p where p.code = lower(p_code) or p.barcode = upper(p_code) limit 1;
  if found then
    return jsonb_build_object('known', true, 'new_group', false, 'id', r.id, 'name', r.name, 'color', r.color,
                              'size', r.size, 'quantity', r.quantity, 'track_stock', r.track_stock);
  end if;
  v_name := public.code_name(p_code);
  return jsonb_build_object('known', false,
    'new_group', not exists (select 1 from public.products p where lower(p.name) = lower(v_name)),
    'name', v_name, 'color', public.code_color(p_code), 'size', (public.code_parts(p_code)).size_part,
    'quantity', 0, 'track_stock', false);
end $$;

-- Arbetare + admin: lägg in en ny kod UTAN att markera den som såld.
-- Används av knappen "Spara som ny grupp". Finns koden redan ändras ingenting.
create or replace function public.register_code(
  p_code text, p_name text default null, p_color text default null, p_size text default null)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare v_id uuid; v_name text; v_color text; v_size text; v_created boolean := false;
        n_name text := nullif(trim(coalesce(p_name, '')), '');
        n_color text := case when p_color is null then null else trim(p_color) end;
        n_size text := case when p_size is null then null else trim(p_size) end;
begin
  if not public.is_staff() then raise exception 'Ingen behörighet'; end if;
  if p_code is null or p_code !~ '^[^[:cntrl:]]{3,120}$' then raise exception 'Ogiltig kod'; end if;
  if p_code ~ '^[0-9a-fA-F]{32}$' then raise exception 'Produkten hittades inte'; end if;
  if char_length(coalesce(n_name, '')) > 120 or char_length(coalesce(n_color, '')) > 40 or char_length(coalesce(n_size, '')) > 20
    then raise exception 'Ogiltigt värde'; end if;

  select p.id, p.name, p.color, p.size into v_id, v_name, v_color, v_size
    from public.products p where p.barcode = upper(p_code) limit 1;
  if v_id is null then
    v_name := coalesce(n_name, public.code_name(p_code));
    v_color := coalesce(n_color, public.code_color(p_code));
    v_size := coalesce(n_size, (public.code_parts(p_code)).size_part);
    insert into public.products (name, color, size, barcode, quantity, total_added, track_stock)
    values (v_name, v_color, v_size, upper(p_code), 0, 0, false)
    returning id into v_id;
    v_created := true;
  end if;
  return jsonb_build_object('id', v_id, 'name', v_name, 'color', v_color, 'size', v_size, 'created', v_created);
end $$;


-- Arbetare + admin: "Lägg in". Lägger in en klänning i lagret och registrerar det,
-- så att det syns i historiken och graferna. En ny kod skapas automatiskt.
create or replace function public.stock_in(
  p_code text, p_amount integer default 1,
  p_name text default null, p_color text default null, p_size text default null,
  p_photo_path text default null, p_photo_thumb text default null)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare v_id uuid; v_name text; v_color text; v_size text; v_qty integer; v_created boolean := false;
        n_name text := nullif(trim(coalesce(p_name, '')), '');
        n_color text := case when p_color is null then null else trim(p_color) end;
        n_size text := case when p_size is null then null else trim(p_size) end;
begin
  if not public.is_staff() then raise exception 'Ingen behörighet'; end if;
  if p_code is null or p_code !~ '^[^[:cntrl:]]{3,120}$' then raise exception 'Ogiltig kod'; end if;
  if p_amount is null or p_amount < 1 or p_amount > 1000 then raise exception 'Ogiltigt antal'; end if;
  if char_length(coalesce(n_name, '')) > 120 or char_length(coalesce(n_color, '')) > 40 or char_length(coalesce(n_size, '')) > 20
    then raise exception 'Ogiltigt värde'; end if;
  if p_photo_path is not null and p_photo_path !~ '^[0-9]{4}/[0-9]{2}/[0-9a-f-]{36}[.]jpg$' then raise exception 'Ogiltigt foto'; end if;
  if p_photo_thumb is not null and (char_length(p_photo_thumb) > 24000 or p_photo_thumb not like 'data:image/jpeg;base64,%')
    then raise exception 'Ogiltigt foto'; end if;

  select p.id, p.name, p.color, p.size into v_id, v_name, v_color, v_size
    from public.products p where p.code = lower(p_code) or p.barcode = upper(p_code) limit 1 for update;

  if v_id is null then
    if p_code ~ '^[0-9a-fA-F]{32}$' then raise exception 'Produkten hittades inte'; end if;   -- appens egna QR-koder skapas aldrig så
    v_name := coalesce(n_name, public.code_name(p_code));
    v_color := coalesce(n_color, public.code_color(p_code));
    v_size := coalesce(n_size, (public.code_parts(p_code)).size_part);
    insert into public.products (name, color, size, barcode, quantity, total_added, track_stock)
    values (v_name, v_color, v_size, upper(p_code), 0, 0, true)
    returning id into v_id;
    v_created := true;
  else
    v_color := coalesce(n_color, v_color); v_size := coalesce(n_size, v_size);
  end if;

  update public.products
     set quantity = quantity + p_amount, total_added = total_added + p_amount, track_stock = true,
         color = v_color, size = v_size, updated_at = now()
   where id = v_id
  returning quantity into v_qty;

  insert into public.stock_movements (product_id, user_id, change, photo_path, photo_thumb)
  values (v_id, auth.uid(), p_amount, p_photo_path, p_photo_thumb);

  return jsonb_build_object('id', v_id, 'name', v_name, 'color', v_color, 'size', v_size,
                            'quantity', v_qty, 'track_stock', true, 'created', v_created);
end $$;

revoke execute on function public.stock_in(text, integer, text, text, text, text, text) from public, anon;
grant execute on function public.stock_in(text, integer, text, text, text, text, text) to authenticated;

-- Admin: ångra en händelse i historiken. Lagret räknas tillbaka och händelsen tas bort.
--  - Såld: antalet läggs tillbaka i lagret (om lagret räknas för klänningen).
--  - Inlagd: antalet tas bort ur lagret, men bara om det inte redan har sålts.
drop function if exists public.undo_movement(bigint);
create or replace function public.undo_movement(p_movement_id bigint)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare m record; p record; v_qty integer;
begin
  if not public.is_admin() then raise exception 'Endast admin'; end if;

  select sm.id, sm.product_id, sm.change, sm.source, sm.photo_path into m
    from public.stock_movements sm where sm.id = p_movement_id for update;
  if not found then raise exception 'Händelsen hittades inte'; end if;
  if m.source = 'webbshop' then raise exception 'Försäljning från webbshoppen kan inte ångras här'; end if;

  select pr.id, pr.name, pr.color, pr.size, pr.quantity, pr.total_added, pr.track_stock into p
    from public.products pr where pr.id = m.product_id for update;
  v_qty := p.quantity;

  if m.change < 0 then
    -- Såld: lägg tillbaka
    if p.track_stock then
      update public.products set quantity = quantity - m.change, updated_at = now()
       where id = p.id returning quantity into v_qty;
    end if;
  elsif m.change > 0 then
    -- Inlagd: ta bort igen, om de finns kvar
    if p.quantity < m.change then raise exception 'Kan inte ångras: klänningarna har redan sålts'; end if;
    update public.products
       set quantity = quantity - m.change, total_added = greatest(total_added - m.change, 0), updated_at = now()
     where id = p.id returning quantity into v_qty;
  end if;

  delete from public.stock_movements where id = m.id;

  return jsonb_build_object('id', m.id, 'change', m.change, 'name', p.name, 'color', p.color, 'size', p.size,
                            'quantity', v_qty, 'track_stock', p.track_stock, 'photo_path', m.photo_path);
end $$;

revoke execute on function public.undo_movement(bigint) from public, anon;
grant execute on function public.undo_movement(bigint) to authenticated;

-- Registrera att en klänning skickas. Namn, färg och storlek kan skickas med:
--  - ny kod: de används i stället för förslagen ur koden
--  - känd kod: färg och storlek rättas om de skiljer sig. Namnet ändras inte här
--    (det gör admin med rename_product, eftersom det gäller hela gruppen).
drop function if exists public.ship(text, integer, text, text);
create or replace function public.ship(
  p_code text, p_amount integer default 1, p_photo_path text default null, p_photo_thumb text default null,
  p_name text default null, p_color text default null, p_size text default null)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare v_id uuid; v_name text; v_color text; v_size text; v_qty integer; v_track boolean; v_created boolean := false;
        n_name text := nullif(trim(coalesce(p_name, '')), '');
        n_color text := case when p_color is null then null else trim(p_color) end;
        n_size text := case when p_size is null then null else trim(p_size) end;
begin
  if not public.is_staff() then raise exception 'Ingen behörighet'; end if;
  if p_code is null or p_code !~ '^[^[:cntrl:]]{3,120}$' then raise exception 'Ogiltig kod'; end if;
  if p_amount is null or p_amount < 1 or p_amount > 1000 then raise exception 'Ogiltigt antal'; end if;
  if char_length(coalesce(n_name, '')) > 120 or char_length(coalesce(n_color, '')) > 40 or char_length(coalesce(n_size, '')) > 20
    then raise exception 'Ogiltigt värde'; end if;
  if p_photo_path is not null and p_photo_path !~ '^[0-9]{4}/[0-9]{2}/[0-9a-f-]{36}[.]jpg$' then raise exception 'Ogiltigt foto'; end if;
  if p_photo_thumb is not null and (char_length(p_photo_thumb) > 24000 or p_photo_thumb not like 'data:image/jpeg;base64,%')
    then raise exception 'Ogiltigt foto'; end if;

  select p.id, p.name, p.color, p.size, p.quantity, p.track_stock into v_id, v_name, v_color, v_size, v_qty, v_track
    from public.products p where p.code = lower(p_code) or p.barcode = upper(p_code) limit 1 for update;

  if v_id is null then
    if p_code ~ '^[0-9a-fA-F]{32}$' then raise exception 'Produkten hittades inte'; end if;   -- appens egna QR-koder skapas aldrig så
    v_name := coalesce(n_name, public.code_name(p_code));
    v_color := coalesce(n_color, public.code_color(p_code));
    v_size := coalesce(n_size, (public.code_parts(p_code)).size_part);
    insert into public.products (name, color, size, barcode, quantity, total_added, track_stock)
    values (v_name, v_color, v_size, upper(p_code), 0, 0, false)
    returning id, quantity, track_stock into v_id, v_qty, v_track;
    v_created := true;
  elsif (n_color is not null and n_color <> v_color) or (n_size is not null and n_size <> v_size) then
    v_color := coalesce(n_color, v_color); v_size := coalesce(n_size, v_size);
    update public.products set color = v_color, size = v_size, updated_at = now() where id = v_id;
  end if;

  if v_track then
    if v_qty < p_amount then raise exception 'Det finns inte så många kvar i lager'; end if;
    update public.products set quantity = quantity - p_amount, updated_at = now() where id = v_id returning quantity into v_qty;
  end if;

  insert into public.stock_movements (product_id, user_id, change, photo_path, photo_thumb)
  values (v_id, auth.uid(), -p_amount, p_photo_path, p_photo_thumb);

  return jsonb_build_object('id', v_id, 'name', v_name, 'color', v_color, 'size', v_size,
                            'quantity', v_qty, 'track_stock', v_track, 'created', v_created);
end $$;

-- Admin: byt namn. Med p_whole_group = true får alla med samma namn det nya namnet.
create or replace function public.rename_product(p_product uuid, p_name text, p_whole_group boolean default true)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare v_old text; v_new text := trim(coalesce(p_name, '')); v_count integer;
begin
  if not public.is_admin() then raise exception 'Endast admin'; end if;
  if char_length(v_new) < 1 or char_length(v_new) > 120 then raise exception 'Ogiltigt namn'; end if;
  select name into v_old from public.products where id = p_product;
  if v_old is null then raise exception 'Produkten hittades inte'; end if;
  if p_whole_group then
    update public.products set name = v_new, updated_at = now() where lower(name) = lower(v_old);
  else
    update public.products set name = v_new, updated_at = now() where id = p_product;
  end if;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Admin: fyll på lager. Lagret börjar räknas för en klänning så fort admin lägger in ett antal.
create or replace function public.add_stock(p_product uuid, p_amount integer)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare v_qty integer;
begin
  if not public.is_admin() then raise exception 'Endast admin'; end if;
  if p_amount is null or p_amount < 1 or p_amount > 1000000 then raise exception 'Ogiltigt antal'; end if;

  update public.products
     set quantity = quantity + p_amount, total_added = total_added + p_amount, track_stock = true, updated_at = now()
   where id = p_product
  returning quantity into v_qty;
  if v_qty is null then raise exception 'Produkten hittades inte'; end if;

  insert into public.stock_movements (product_id, user_id, change) values (p_product, auth.uid(), p_amount);
  return v_qty;
end $$;

-- ---------- WEBBSHOP (används bara av serverfunktionen shop-sync) ----------
-- Drar en såld klänning från lagret. Samma order_ref kan bara dras en gång.
-- Kan INTE anropas från appen – bara från servern med service-nyckeln.
create or replace function public.shop_remove_stock(p_sku text, p_amount integer, p_order_ref text)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare v_id uuid; v_qty integer;
begin
  if p_amount is null or p_amount < 1 or p_amount > 1000 then raise exception 'Ogiltigt antal'; end if;

  begin
    insert into public.shop_orders (order_ref) values (p_order_ref || ':' || p_sku);
  exception when unique_violation then
    return (select quantity from public.products where sku = p_sku);   -- redan hanterad
  end;

  update public.products
     set quantity = greatest(quantity - p_amount, 0), updated_at = now()
   where sku = p_sku
  returning id, quantity into v_id, v_qty;
  if v_id is null then raise exception 'Okänt artikelnummer'; end if;

  insert into public.stock_movements (product_id, user_id, change, source) values (v_id, null, -p_amount, 'webbshop');
  return v_qty;
end $$;

-- ---------- Vem får köra funktionerna ----------
revoke execute on all functions in schema public from public, anon;

grant execute on function public.is_admin(), public.is_staff(),
  public.lookup_product(text), public.remove_stock(text, integer, text, text),
  public.create_product(text, integer, integer, text, text, text, text), public.add_stock(uuid, integer),
  public.set_barcode(uuid, text), public.staff_products(), public.staff_codes()
  to authenticated;

-- Skanna-flödet (arbetare + admin, och admin för namnbyte)
revoke execute on function public.code_key(text), public.code_name(text), public.code_parts(text), public.code_color(text), public.scan_info(text),
  public.ship(text, integer, text, text, text, text, text), public.register_code(text, text, text, text), public.rename_product(uuid, text, boolean), public.add_stock(uuid, integer)
  from public, anon;
grant execute on function public.code_key(text), public.code_name(text), public.code_parts(text), public.code_color(text), public.scan_info(text),
  public.ship(text, integer, text, text, text, text, text), public.register_code(text, text, text, text), public.rename_product(uuid, text, boolean), public.add_stock(uuid, integer)
  to authenticated;

revoke execute on function public.shop_remove_stock(text, integer, text) from authenticated;
do $$ begin
  grant execute on function public.shop_remove_stock(text, integer, text) to service_role;
exception when undefined_object then null; end $$;

-- ---------- Foto på utskick (privat lagringsplats) ----------
-- Personal laddar upp, bara admin tittar och tar bort.
do $$ begin if exists (select 1 from pg_namespace where nspname = 'storage') then
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('utskick', 'utskick', false, 1048576, array['image/jpeg'])
  on conflict (id) do update set public = false, file_size_limit = 1048576, allowed_mime_types = array['image/jpeg'];

  drop policy if exists "utskick: personal laddar upp" on storage.objects;
  create policy "utskick: personal laddar upp" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'utskick' and public.is_staff()
                and name ~ '^[0-9]{4}/[0-9]{2}/[0-9a-f-]{36}[.]jpg$');

  drop policy if exists "utskick: admin läser" on storage.objects;
  create policy "utskick: admin läser" on storage.objects
    for select to authenticated using (bucket_id = 'utskick' and public.is_admin());

  drop policy if exists "utskick: admin tar bort" on storage.objects;
  create policy "utskick: admin tar bort" on storage.objects
    for delete to authenticated using (bucket_id = 'utskick' and public.is_admin());
end if; end $$;

notify pgrst, 'reload schema';
