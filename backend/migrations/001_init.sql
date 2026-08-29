-- Kept as a readable, version-controlled reference. The schema that is
-- actually applied lives in internal/storage/schema.go and runs
-- idempotently at startup (see NewPostgresStore) — there is no separate
-- migration-runner tool for this MVP, matching the other 3VNSYSTEMS
-- products.
--
-- This file is not hand-maintained: TestMigrationFileMatchesSchema in
-- internal/storage fails if it drifts from schema.go, so the two are
-- always the same statements in the same order.

create table if not exists businesses (
		id text primary key,
		name text not null,
		business_type text not null,
		timezone text not null default 'Asia/Kolkata',
		created_at timestamptz not null default now(),
		-- Per-tenant configuration (vocabulary, custom field declarations,
		-- stop captures) as one document. See domain.BusinessConfig for
		-- why a blob rather than tables: it is small, always read whole,
		-- written rarely, and never queried across tenants.
		config jsonb not null default '{}'::jsonb
	);

-- Where the business itself is based — the depot, the shop, the dairy.
alter table businesses add column if not exists home_lat double precision not null default 0;

alter table businesses add column if not exists home_lng double precision not null default 0;
-- Where the driver finishes. A delivery round ends when the driver gets
-- home, not when they get back to the depot — the last stop is chosen
-- differently if the drive afterwards is to Ramgiri rather than back
-- across town. Zero means unset, same convention as customers.lat.
alter table users add column if not exists home_lat double precision not null default 0;
alter table users add column if not exists home_lng double precision not null default 0;
-- Where a route finishes, if anywhere in particular. Set from the
-- assigned driver's home; zero leaves the route open-ended.
alter table routes add column if not exists end_lat double precision not null default 0;
alter table routes add column if not exists end_lng double precision not null default 0;

create table if not exists users (
		id text primary key,
		business_id text not null references businesses(id) on delete cascade,
		role text not null,
		name text not null default '',
		email text,
		phone text,
		pin_hash text,
		active boolean not null default true,
		created_at timestamptz not null default now()
	);

create unique index if not exists users_email_key on users(lower(email)) where email is not null and email <> '';

create unique index if not exists users_phone_key on users(phone) where phone is not null and phone <> '';

create index if not exists users_business_idx on users(business_id);

create table if not exists customers (
		id text primary key,
		business_id text not null references businesses(id) on delete cascade,
		name text not null,
		phone text not null default '',
		address text not null default '',
		lat double precision not null default 0,
		lng double precision not null default 0,
		notes text not null default '',
		account_id text,
		active boolean not null default true,
		created_at timestamptz not null default now(),
		-- Extra per-business information about this customer, constrained
		-- at the API boundary to the keys the business declared in
		-- businesses.config. See domain.ValidateFieldValues.
		custom_fields jsonb not null default '{}'::jsonb
	);

create index if not exists customers_business_idx on customers(business_id);

create table if not exists service_areas (
		id text primary key,
		business_id text not null references businesses(id) on delete cascade,
		name text not null,
		lat double precision not null default 0,
		lng double precision not null default 0,
		-- The perimeter around lat/lng this zone covers. Circle+radius
		-- rather than a polygon — same "the pin is the address"
		-- simplicity as a customer's own pin.
		radius_meters double precision not null default 0,
		active boolean not null default true,
		created_at timestamptz not null default now()
	);

create index if not exists service_areas_business_idx on service_areas(business_id);

create table if not exists products (
		id text primary key,
		business_id text not null references businesses(id) on delete cascade,
		name text not null,
		unit text not null default '',
		price_cents integer not null default 0,
		active boolean not null default true
	);

-- Added after products shipped, so an alter rather than a column in the
-- create above — the same shape businesses.home_lat used. Stock is a
-- plain running count the business keeps for itself: what is in the cold
-- room this morning, set against what today's routes need. No automatic
-- decrementing on delivery, deliberately — a dairy reconciles stock by
-- looking, not by trusting a tally that drifts the first time something
-- is spilled or given away.
alter table products add column if not exists stock_quantity double precision not null default 0;
create index if not exists products_business_idx on products(business_id);

create table if not exists recurring_orders (
		id text primary key,
		business_id text not null references businesses(id) on delete cascade,
		customer_id text not null references customers(id) on delete cascade,
		product_id text not null references products(id),
		quantity double precision not null default 0,
		weekday_mask integer not null default 0,
		start_date text not null default '',
		end_date text not null default '',
		active boolean not null default true,
		created_at timestamptz not null default now()
	);

create index if not exists recurring_orders_business_idx on recurring_orders(business_id);

create table if not exists routes (
		id text primary key,
		business_id text not null references businesses(id) on delete cascade,
		route_date text not null,
		name text not null default '',
		driver_id text references users(id) on delete set null,
		status text not null default 'draft',
		start_lat double precision not null default 0,
		start_lng double precision not null default 0,
		estimated_meters double precision not null default 0,
		created_at timestamptz not null default now()
	);

create index if not exists routes_business_date_idx on routes(business_id, route_date);
-- One round per name per day. Rounds are derived automatically now (see
-- ensureDayRounds in httpapi/admin.go), and two admins reading the same
-- day at the same moment would otherwise each create the "Kodad round"
-- that neither had seen yet — leaving the day with two of them and its
-- stops split across both. The database is the only place that race can
-- actually be settled.
create unique index if not exists routes_business_date_name_idx on routes(business_id, route_date, name);

create table if not exists daily_orders (
		id text primary key,
		business_id text not null references businesses(id) on delete cascade,
		customer_id text not null references customers(id) on delete cascade,
		product_id text not null references products(id),
		recurring_order_id text references recurring_orders(id) on delete set null,
		delivery_date text not null,
		quantity double precision not null default 0,
		base_quantity double precision not null default 0,
		status text not null default 'pending',
		override_reason text not null default '',
		note text not null default '',
		route_id text references routes(id) on delete set null,
		stop_sequence integer not null default 0,
		completed_at timestamptz,
		created_at timestamptz not null default now(),
		updated_at timestamptz not null default now(),
		-- What the office recorded about this specific delivery...
		custom_fields jsonb not null default '{}'::jsonb,
		-- ...and what the driver recorded at the door. Separate columns
		-- because a billing run wants the second and a planning screen
		-- wants the first.
		captures jsonb not null default '{}'::jsonb
	);

create unique index if not exists daily_orders_recurring_date_key
		on daily_orders(business_id, recurring_order_id, delivery_date)
		where recurring_order_id is not null;

create index if not exists daily_orders_business_date_idx on daily_orders(business_id, delivery_date);

create index if not exists daily_orders_route_idx on daily_orders(route_id);

create table if not exists delivery_events (
		id text primary key,
		business_id text not null references businesses(id) on delete cascade,
		daily_order_id text not null references daily_orders(id) on delete cascade,
		actor_user_id text not null default '',
		status text not null,
		note text not null default '',
		created_at timestamptz not null default now()
	);

create index if not exists delivery_events_order_idx on delivery_events(daily_order_id);
