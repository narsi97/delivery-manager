package storage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"delivery-manager/internal/domain"
)

// PostgresStore is the real store: everything except a laptop with no
// Docker running (see MemoryStore).
type PostgresStore struct {
	pool *pgxpool.Pool
}

var _ Store = (*PostgresStore)(nil)
var _ Store = (*MemoryStore)(nil)

func NewPostgresStore(ctx context.Context, databaseURL string) (*PostgresStore, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}

	store := &PostgresStore{pool: pool}
	if err := store.applySchema(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return store, nil
}

func (s *PostgresStore) applySchema(ctx context.Context) error {
	for _, statement := range schemaStatements {
		if _, err := s.pool.Exec(ctx, statement); err != nil {
			return fmt.Errorf("apply schema: %w", err)
		}
	}
	return nil
}

func (s *PostgresStore) Close() { s.pool.Close() }

// isUniqueViolation maps Postgres's 23505 to ErrConflict, so callers get
// a domain-level "already exists" instead of having to know SQLSTATEs.
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func (s *PostgresStore) CreateBusiness(ctx context.Context, b domain.Business, admin domain.User) (domain.Business, domain.User, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Business{}, domain.User{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	now := time.Now().UTC()
	b.CreatedAt = now
	b.Config = b.Config.WithDefaults()
	configJSON, err := marshalConfig(b.Config)
	if err != nil {
		return domain.Business{}, domain.User{}, err
	}
	if _, err := tx.Exec(ctx,
		`insert into businesses (id, name, business_type, timezone, created_at, config, home_lat, home_lng)
		 values ($1,$2,$3,$4,$5,$6,$7,$8)`,
		b.ID, b.Name, string(b.Type), b.Timezone, b.CreatedAt, configJSON, b.HomeLat, b.HomeLng); err != nil {
		return domain.Business{}, domain.User{}, err
	}

	admin.BusinessID = b.ID
	admin.Email = strings.ToLower(strings.TrimSpace(admin.Email))
	admin.Active = true
	admin.CreatedAt = now
	if _, err := tx.Exec(ctx,
		`insert into users (id, business_id, role, name, email, phone, pin_hash, active, created_at)
		 values ($1,$2,$3,$4,$5,null,null,$6,$7)`,
		admin.ID, admin.BusinessID, string(admin.Role), admin.Name, nullableText(admin.Email), admin.Active, admin.CreatedAt); err != nil {
		if isUniqueViolation(err) {
			return domain.Business{}, domain.User{}, ErrConflict
		}
		return domain.Business{}, domain.User{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return domain.Business{}, domain.User{}, err
	}
	return b, admin, nil
}

func (s *PostgresStore) GetBusiness(ctx context.Context, id string) (domain.Business, error) {
	row := s.pool.QueryRow(ctx,
		`select `+businessColumns+` from businesses where id = $1`, id)
	return scanBusiness(row)
}

// UpdateBusiness persists the plain scalar fields an admin edits directly
// (name, home location). Config has its own replace-the-document path
// below, UpdateBusinessConfig, kept separate because a nested JSON blob
// has merge ambiguity that two scalars and a name don't.
func (s *PostgresStore) UpdateBusiness(ctx context.Context, b domain.Business) (domain.Business, error) {
	row := s.pool.QueryRow(ctx,
		`update businesses set name=$2, home_lat=$3, home_lng=$4 where id=$1
		 returning `+businessColumns,
		b.ID, b.Name, b.HomeLat, b.HomeLng)
	return scanBusiness(row)
}

func (s *PostgresStore) UpdateBusinessConfig(ctx context.Context, businessID string, config domain.BusinessConfig) (domain.Business, error) {
	configJSON, err := marshalConfig(config.WithDefaults())
	if err != nil {
		return domain.Business{}, err
	}
	row := s.pool.QueryRow(ctx,
		`update businesses set config=$2 where id=$1
		 returning `+businessColumns, businessID, configJSON)
	return scanBusiness(row)
}

// One list, repeated inline in five queries before this — the kind of
// duplication that quietly breaks the moment a column is added, which is
// exactly what happened when drivers got a home location.
const userColumns = `id, business_id, role, name, coalesce(email,''), coalesce(phone,''), active, home_lat, home_lng,
	coalesce(finish_at,'farm'), finish_lat, finish_lng, created_at`

func (s *PostgresStore) GetAdminByEmail(ctx context.Context, email string) (domain.User, error) {
	row := s.pool.QueryRow(ctx,
		`select `+userColumns+`
		 from users where lower(email) = lower($1) and role in ('admin','admin_driver')`,
		strings.TrimSpace(email))
	return scanUser(row)
}

func (s *PostgresStore) GetDriverByPhone(ctx context.Context, phone string) (domain.User, string, error) {
	normalized := domain.NormalizePhone(phone)
	if normalized == "" {
		return domain.User{}, "", ErrNotFound
	}
	row := s.pool.QueryRow(ctx,
		`select `+userColumns+`, coalesce(pin_hash,'')
		 from users where phone = $1 and role in ('driver','admin_driver')`, normalized)

	var u domain.User
	var pinHash string
	err := row.Scan(&u.ID, &u.BusinessID, &u.Role, &u.Name, &u.Email, &u.Phone, &u.Active,
		&u.HomeLat, &u.HomeLng, &u.CreatedAt, &pinHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.User{}, "", ErrNotFound
	}
	if err != nil {
		return domain.User{}, "", err
	}
	return u, pinHash, nil
}

func (s *PostgresStore) CreateUser(ctx context.Context, u domain.User, pinHash string) (domain.User, error) {
	u.Email = strings.ToLower(strings.TrimSpace(u.Email))
	u.Phone = domain.NormalizePhone(u.Phone)
	u.CreatedAt = time.Now().UTC()

	_, err := s.pool.Exec(ctx,
		`insert into users (id, business_id, role, name, email, phone, pin_hash, active, home_lat, home_lng, created_at)
		 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		u.ID, u.BusinessID, string(u.Role), u.Name,
		nullableText(u.Email), nullableText(u.Phone), nullableText(pinHash), u.Active,
		u.HomeLat, u.HomeLng, u.CreatedAt)
	if isUniqueViolation(err) {
		return domain.User{}, ErrConflict
	}
	if err != nil {
		return domain.User{}, err
	}
	return u, nil
}

func (s *PostgresStore) GetUserByID(ctx context.Context, businessID string, id string) (domain.User, error) {
	row := s.pool.QueryRow(ctx,
		`select `+userColumns+`
		 from users where id = $1 and business_id = $2`, id, businessID)
	return scanUser(row)
}

func (s *PostgresStore) ListUsers(ctx context.Context, businessID string) ([]domain.User, error) {
	rows, err := s.pool.Query(ctx,
		`select `+userColumns+`
		 from users where business_id = $1 order by created_at`, businessID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *PostgresStore) SetUserActive(ctx context.Context, businessID string, id string, active bool) (domain.User, error) {
	row := s.pool.QueryRow(ctx,
		`update users set active = $3 where id = $1 and business_id = $2
		 returning `+userColumns,
		id, businessID, active)
	return scanUser(row)
}

func (s *PostgresStore) SetUserHome(ctx context.Context, businessID string, id string, lat, lng float64) (domain.User, error) {
	row := s.pool.QueryRow(ctx,
		`update users set home_lat = $3, home_lng = $4 where id = $1 and business_id = $2
		 returning `+userColumns,
		id, businessID, lat, lng)
	return scanUser(row)
}

// SetUserFinish records where this driver's round ends. lat/lng are only
// meaningful for the custom choice and are stored regardless, so that
// switching to custom and back doesn't lose the pin the admin set.
func (s *PostgresStore) SetUserFinish(ctx context.Context, businessID string, id string, finishAt domain.FinishAt, lat, lng float64) (domain.User, error) {
	row := s.pool.QueryRow(ctx,
		`update users set finish_at = $3, finish_lat = $4, finish_lng = $5 where id = $1 and business_id = $2
		 returning `+userColumns,
		id, businessID, string(domain.NormalizeFinishAt(finishAt)), lat, lng)
	return scanUser(row)
}

func (s *PostgresStore) SetUserPIN(ctx context.Context, businessID string, id string, pinHash string) error {
	tag, err := s.pool.Exec(ctx,
		`update users set pin_hash = $3 where id = $1 and business_id = $2`, id, businessID, nullableText(pinHash))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PostgresStore) CreateCustomer(ctx context.Context, c domain.Customer) (domain.Customer, error) {
	c.CreatedAt = time.Now().UTC()
	fieldsJSON, err := marshalFields(c.CustomFields)
	if err != nil {
		return domain.Customer{}, err
	}
	_, err = s.pool.Exec(ctx,
		`insert into customers (`+customerColumns+`)
		 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
		c.ID, c.BusinessID, c.Name, c.Phone, c.Address, c.Lat, c.Lng, c.Notes,
		string(domain.NormalizePriority(c.Priority)), c.AccountID, c.Active, c.CreatedAt, fieldsJSON)
	if err != nil {
		return domain.Customer{}, err
	}
	return c, nil
}

func (s *PostgresStore) UpdateCustomer(ctx context.Context, c domain.Customer) (domain.Customer, error) {
	fieldsJSON, err := marshalFields(c.CustomFields)
	if err != nil {
		return domain.Customer{}, err
	}
	row := s.pool.QueryRow(ctx,
		`update customers set name=$3, phone=$4, address=$5, lat=$6, lng=$7, notes=$8, active=$9,
		        custom_fields=$10, priority=$11
		 where id=$1 and business_id=$2
		 returning `+customerColumns,
		c.ID, c.BusinessID, c.Name, c.Phone, c.Address, c.Lat, c.Lng, c.Notes, c.Active, fieldsJSON,
		string(domain.NormalizePriority(c.Priority)))
	return scanCustomer(row)
}

func (s *PostgresStore) GetCustomer(ctx context.Context, businessID string, id string) (domain.Customer, error) {
	row := s.pool.QueryRow(ctx,
		`select `+customerColumns+` from customers where id=$1 and business_id=$2`, id, businessID)
	return scanCustomer(row)
}

func (s *PostgresStore) ListCustomers(ctx context.Context, businessID string) ([]domain.Customer, error) {
	rows, err := s.pool.Query(ctx,
		`select `+customerColumns+` from customers where business_id=$1 order by name`, businessID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.Customer{}
	for rows.Next() {
		c, err := scanCustomer(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *PostgresStore) CreateServiceArea(ctx context.Context, sa domain.ServiceArea) (domain.ServiceArea, error) {
	sa.CreatedAt = time.Now().UTC()
	_, err := s.pool.Exec(ctx,
		`insert into service_areas (`+serviceAreaColumns+`) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
		sa.ID, sa.BusinessID, sa.Name, sa.Lat, sa.Lng, sa.RadiusMeters, sa.Active, sa.CreatedAt)
	if err != nil {
		return domain.ServiceArea{}, err
	}
	return sa, nil
}

func (s *PostgresStore) GetServiceArea(ctx context.Context, businessID string, id string) (domain.ServiceArea, error) {
	row := s.pool.QueryRow(ctx,
		`select `+serviceAreaColumns+` from service_areas where id=$1 and business_id=$2`, id, businessID)
	return scanServiceArea(row)
}

func (s *PostgresStore) ListServiceAreas(ctx context.Context, businessID string) ([]domain.ServiceArea, error) {
	rows, err := s.pool.Query(ctx,
		`select `+serviceAreaColumns+` from service_areas where business_id=$1 order by name`, businessID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.ServiceArea{}
	for rows.Next() {
		sa, err := scanServiceArea(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sa)
	}
	return out, rows.Err()
}

func (s *PostgresStore) UpdateServiceArea(ctx context.Context, sa domain.ServiceArea) (domain.ServiceArea, error) {
	row := s.pool.QueryRow(ctx,
		`update service_areas set name=$3, lat=$4, lng=$5, radius_meters=$6, active=$7
		 where id=$1 and business_id=$2
		 returning `+serviceAreaColumns,
		sa.ID, sa.BusinessID, sa.Name, sa.Lat, sa.Lng, sa.RadiusMeters, sa.Active)
	return scanServiceArea(row)
}

// One list, so the create/list/get/update queries can't drift apart —
// same reasoning as serviceAreaColumns above.
const productColumns = `id, business_id, name, unit, price_cents, stock_quantity, active`

func scanProduct(row interface{ Scan(...any) error }) (domain.Product, error) {
	var p domain.Product
	if err := row.Scan(&p.ID, &p.BusinessID, &p.Name, &p.Unit, &p.PriceCents, &p.StockQuantity, &p.Active); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Product{}, ErrNotFound
		}
		return domain.Product{}, err
	}
	return p, nil
}

func (s *PostgresStore) CreateProduct(ctx context.Context, p domain.Product) (domain.Product, error) {
	_, err := s.pool.Exec(ctx,
		`insert into products (id, business_id, name, unit, price_cents, stock_quantity, active) values ($1,$2,$3,$4,$5,$6,$7)`,
		p.ID, p.BusinessID, p.Name, p.Unit, p.PriceCents, p.StockQuantity, p.Active)
	if err != nil {
		return domain.Product{}, err
	}
	return p, nil
}

func (s *PostgresStore) GetProduct(ctx context.Context, businessID string, id string) (domain.Product, error) {
	row := s.pool.QueryRow(ctx,
		`select `+productColumns+` from products where business_id=$1 and id=$2`, businessID, id)
	return scanProduct(row)
}

func (s *PostgresStore) UpdateProduct(ctx context.Context, p domain.Product) (domain.Product, error) {
	row := s.pool.QueryRow(ctx,
		`update products set name=$3, unit=$4, price_cents=$5, stock_quantity=$6, active=$7
		 where id=$1 and business_id=$2
		 returning `+productColumns,
		p.ID, p.BusinessID, p.Name, p.Unit, p.PriceCents, p.StockQuantity, p.Active)
	return scanProduct(row)
}

func (s *PostgresStore) ListProducts(ctx context.Context, businessID string) ([]domain.Product, error) {
	rows, err := s.pool.Query(ctx,
		`select `+productColumns+` from products where business_id=$1 order by name`, businessID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.Product{}
	for rows.Next() {
		var p domain.Product
		if err := rows.Scan(&p.ID, &p.BusinessID, &p.Name, &p.Unit, &p.PriceCents, &p.StockQuantity, &p.Active); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *PostgresStore) CreateRecurringOrder(ctx context.Context, r domain.RecurringOrder) (domain.RecurringOrder, error) {
	r.CreatedAt = time.Now().UTC()
	_, err := s.pool.Exec(ctx,
		`insert into recurring_orders (id, business_id, customer_id, product_id, quantity, weekday_mask, start_date, end_date, active, created_at)
		 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		r.ID, r.BusinessID, r.CustomerID, r.ProductID, r.Quantity, r.WeekdayMask, r.StartDate, r.EndDate, r.Active, r.CreatedAt)
	if err != nil {
		return domain.RecurringOrder{}, err
	}
	return r, nil
}

func (s *PostgresStore) ListRecurringOrders(ctx context.Context, businessID string) ([]domain.RecurringOrder, error) {
	rows, err := s.pool.Query(ctx,
		`select id, business_id, customer_id, product_id, quantity, weekday_mask, start_date, end_date, active, created_at
		 from recurring_orders where business_id=$1 order by created_at`, businessID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.RecurringOrder{}
	for rows.Next() {
		r, err := scanRecurring(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *PostgresStore) SetRecurringOrderActive(ctx context.Context, businessID string, id string, active bool) (domain.RecurringOrder, error) {
	row := s.pool.QueryRow(ctx,
		`update recurring_orders set active=$3 where id=$1 and business_id=$2
		 returning id, business_id, customer_id, product_id, quantity, weekday_mask, start_date, end_date, active, created_at`,
		id, businessID, active)
	return scanRecurring(row)
}

// Column lists are named constants so that a select, an insert and a
// `returning` clause can never drift apart — a mismatch there is a scan
// error at runtime rather than a compile error.
const businessColumns = `id, name, business_type, timezone, created_at, config, home_lat, home_lng`

const customerColumns = `id, business_id, name, phone, address, lat, lng, notes, priority, account_id, active, created_at, custom_fields`

const serviceAreaColumns = `id, business_id, name, lat, lng, radius_meters, active, created_at`

const dailyOrderColumns = `id, business_id, customer_id, product_id, recurring_order_id, delivery_date,
	quantity, base_quantity, status, override_reason, note, route_id, stop_sequence, completed_at, created_at, updated_at,
	custom_fields, captures`

func (s *PostgresStore) EnsureDailyOrder(ctx context.Context, o domain.DailyOrder) (domain.DailyOrder, bool, error) {
	if o.RecurringOrderID == nil {
		created, err := s.CreateDailyOrder(ctx, o)
		return created, err == nil, err
	}

	now := time.Now().UTC()
	o.CreatedAt = now
	o.UpdatedAt = now

	// `do nothing` rather than `do update`: an existing row may already
	// carry an override or a completed delivery, and regeneration must
	// never clobber either. See EnsureDailyOrder's doc comment on Store.
	fieldsJSON, capturesJSON, err := marshalOrderBags(o)
	if err != nil {
		return domain.DailyOrder{}, false, err
	}
	row := s.pool.QueryRow(ctx,
		`insert into daily_orders (`+dailyOrderColumns+`)
		 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
		 on conflict (business_id, recurring_order_id, delivery_date) where recurring_order_id is not null
		 do nothing
		 returning `+dailyOrderColumns,
		o.ID, o.BusinessID, o.CustomerID, o.ProductID, o.RecurringOrderID, o.DeliveryDate,
		o.Quantity, o.BaseQuantity, string(o.Status), o.OverrideReason, o.Note, o.RouteID, o.Sequence,
		o.CompletedAt, o.CreatedAt, o.UpdatedAt, fieldsJSON, capturesJSON)

	inserted, scanErr := scanDailyOrder(row)
	err = scanErr
	if err == nil {
		return inserted, true, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return domain.DailyOrder{}, false, err
	}

	existingRow := s.pool.QueryRow(ctx,
		`select `+dailyOrderColumns+` from daily_orders
		 where business_id=$1 and recurring_order_id=$2 and delivery_date=$3`,
		o.BusinessID, *o.RecurringOrderID, o.DeliveryDate)
	existing, err := scanDailyOrder(existingRow)
	if err != nil {
		return domain.DailyOrder{}, false, err
	}
	return existing, false, nil
}

func (s *PostgresStore) CreateDailyOrder(ctx context.Context, o domain.DailyOrder) (domain.DailyOrder, error) {
	now := time.Now().UTC()
	o.CreatedAt = now
	o.UpdatedAt = now
	fieldsJSON, capturesJSON, err := marshalOrderBags(o)
	if err != nil {
		return domain.DailyOrder{}, err
	}
	_, err = s.pool.Exec(ctx,
		`insert into daily_orders (`+dailyOrderColumns+`)
		 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
		o.ID, o.BusinessID, o.CustomerID, o.ProductID, o.RecurringOrderID, o.DeliveryDate,
		o.Quantity, o.BaseQuantity, string(o.Status), o.OverrideReason, o.Note, o.RouteID, o.Sequence,
		o.CompletedAt, o.CreatedAt, o.UpdatedAt, fieldsJSON, capturesJSON)
	if err != nil {
		return domain.DailyOrder{}, err
	}
	return o, nil
}

func (s *PostgresStore) ListDailyOrders(ctx context.Context, businessID string, date string) ([]domain.DailyOrder, error) {
	// `stop_sequence = 0 last` keeps unrouted stops after the ordered
	// ones, matching the in-memory store's ordering so the two
	// implementations are interchangeable from a handler's point of view.
	rows, err := s.pool.Query(ctx,
		`select `+dailyOrderColumns+` from daily_orders
		 where business_id=$1 and delivery_date=$2
		 order by (stop_sequence = 0), stop_sequence, created_at`, businessID, date)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.DailyOrder{}
	for rows.Next() {
		o, err := scanDailyOrder(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

func (s *PostgresStore) GetDailyOrder(ctx context.Context, businessID string, id string) (domain.DailyOrder, error) {
	row := s.pool.QueryRow(ctx,
		`select `+dailyOrderColumns+` from daily_orders where id=$1 and business_id=$2`, id, businessID)
	return scanDailyOrder(row)
}

func (s *PostgresStore) UpdateDailyOrder(ctx context.Context, o domain.DailyOrder) (domain.DailyOrder, error) {
	fieldsJSON, capturesJSON, err := marshalOrderBags(o)
	if err != nil {
		return domain.DailyOrder{}, err
	}
	row := s.pool.QueryRow(ctx,
		`update daily_orders set quantity=$3, base_quantity=$4, status=$5, override_reason=$6, note=$7,
			route_id=$8, stop_sequence=$9, completed_at=$10, custom_fields=$11, captures=$12, updated_at=now()
		 where id=$1 and business_id=$2
		 returning `+dailyOrderColumns,
		o.ID, o.BusinessID, o.Quantity, o.BaseQuantity, string(o.Status), o.OverrideReason, o.Note,
		o.RouteID, o.Sequence, o.CompletedAt, fieldsJSON, capturesJSON)
	return scanDailyOrder(row)
}

func (s *PostgresStore) CreateRoute(ctx context.Context, r domain.Route) (domain.Route, error) {
	r.CreatedAt = time.Now().UTC()
	_, err := s.pool.Exec(ctx,
		`insert into routes (id, business_id, route_date, name, driver_id, status, start_lat, start_lng, end_lat, end_lng, estimated_meters, created_at)
		 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
		r.ID, r.BusinessID, r.RouteDate, r.Name, r.DriverID, string(r.Status),
		r.StartLat, r.StartLng, r.EndLat, r.EndLng, r.EstimatedMeters, r.CreatedAt)
	if err != nil {
		return domain.Route{}, err
	}
	return r, nil
}

const routeColumns = `id, business_id, route_date, name, driver_id, status, start_lat, start_lng, end_lat, end_lng, estimated_meters, created_at`

func (s *PostgresStore) DeleteRoute(ctx context.Context, businessID string, id string) error {
	// The business_id predicate is the tenant guard: a route id from
	// another business must come back as not-found, never delete.
	tag, err := s.pool.Exec(ctx, `delete from routes where business_id = $1 and id = $2`, businessID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	// daily_orders.route_id is ON DELETE SET NULL (see schema.go), so the
	// stops detach on their own; the sequence numbers are stale once a
	// stop is off a route, so clear them too.
	_, err = s.pool.Exec(ctx,
		`update daily_orders set stop_sequence = 0 where business_id = $1 and route_id is null and stop_sequence <> 0`,
		businessID)
	return err
}

func (s *PostgresStore) GetRoute(ctx context.Context, businessID string, id string) (domain.Route, error) {
	row := s.pool.QueryRow(ctx, `select `+routeColumns+` from routes where id=$1 and business_id=$2`, id, businessID)
	return scanRoute(row)
}

func (s *PostgresStore) ListRoutes(ctx context.Context, businessID string, date string) ([]domain.Route, error) {
	query := `select ` + routeColumns + ` from routes where business_id=$1 order by created_at`
	args := []any{businessID}
	if date != "" {
		query = `select ` + routeColumns + ` from routes where business_id=$1 and route_date=$2 order by created_at`
		args = append(args, date)
	}

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.Route{}
	for rows.Next() {
		r, err := scanRoute(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *PostgresStore) UpdateRoute(ctx context.Context, r domain.Route) (domain.Route, error) {
	row := s.pool.QueryRow(ctx,
		`update routes set name=$3, driver_id=$4, status=$5, start_lat=$6, start_lng=$7, end_lat=$8, end_lng=$9, estimated_meters=$10
		 where id=$1 and business_id=$2 returning `+routeColumns,
		r.ID, r.BusinessID, r.Name, r.DriverID, string(r.Status),
		r.StartLat, r.StartLng, r.EndLat, r.EndLng, r.EstimatedMeters)
	return scanRoute(row)
}

func (s *PostgresStore) AssignStops(ctx context.Context, businessID string, routeID string, orderedDailyOrderIDs []string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var exists bool
	if err := tx.QueryRow(ctx, `select true from routes where id=$1 and business_id=$2`, routeID, businessID).Scan(&exists); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}

	// Detach first, then reattach in order, inside one transaction — so a
	// rebuild is atomic and never leaves stops on a half-built route.
	if _, err := tx.Exec(ctx,
		`update daily_orders set route_id=null, stop_sequence=0, updated_at=now()
		 where business_id=$1 and route_id=$2`, businessID, routeID); err != nil {
		return err
	}

	for i, id := range orderedDailyOrderIDs {
		tag, err := tx.Exec(ctx,
			`update daily_orders set route_id=$3, stop_sequence=$4, updated_at=now()
			 where id=$1 and business_id=$2`, id, businessID, routeID, i+1)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
	}

	return tx.Commit(ctx)
}

func (s *PostgresStore) AppendDeliveryEvent(ctx context.Context, e domain.DeliveryEvent) error {
	_, err := s.pool.Exec(ctx,
		`insert into delivery_events (id, business_id, daily_order_id, actor_user_id, status, note, created_at)
		 values ($1,$2,$3,$4,$5,$6,now())`,
		e.ID, e.BusinessID, e.DailyOrderID, e.ActorUserID, string(e.Status), e.Note)
	return err
}

func (s *PostgresStore) ListDeliveryEvents(ctx context.Context, businessID string, dailyOrderID string) ([]domain.DeliveryEvent, error) {
	rows, err := s.pool.Query(ctx,
		`select id, business_id, daily_order_id, actor_user_id, status, note, created_at
		 from delivery_events where business_id=$1 and daily_order_id=$2 order by created_at`, businessID, dailyOrderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.DeliveryEvent{}
	for rows.Next() {
		var e domain.DeliveryEvent
		if err := rows.Scan(&e.ID, &e.BusinessID, &e.DailyOrderID, &e.ActorUserID, &e.Status, &e.Note, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// scanner is satisfied by both pgx.Row and pgx.Rows, so each record type
// needs only one scan function regardless of whether it came from a
// single-row query or a loop.
type scanner interface {
	Scan(dest ...any) error
}

// noRows normalizes pgx's "no rows" into this package's ErrNotFound. Every
// scan helper runs its error through it, so a caller never has to import
// pgx to tell "missing" from "broken".
func noRows(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func scanBusiness(row scanner) (domain.Business, error) {
	var b domain.Business
	var configJSON []byte
	if err := row.Scan(&b.ID, &b.Name, &b.Type, &b.Timezone, &b.CreatedAt, &configJSON, &b.HomeLat, &b.HomeLng); err != nil {
		return domain.Business{}, noRows(err)
	}
	config, err := unmarshalConfig(configJSON)
	if err != nil {
		return domain.Business{}, err
	}
	b.Config = config
	return b, nil
}

func scanServiceArea(row scanner) (domain.ServiceArea, error) {
	var sa domain.ServiceArea
	if err := row.Scan(&sa.ID, &sa.BusinessID, &sa.Name, &sa.Lat, &sa.Lng, &sa.RadiusMeters, &sa.Active, &sa.CreatedAt); err != nil {
		return domain.ServiceArea{}, noRows(err)
	}
	return sa, nil
}

func scanUser(row scanner) (domain.User, error) {
	var u domain.User
	var finishAt string
	if err := row.Scan(&u.ID, &u.BusinessID, &u.Role, &u.Name, &u.Email, &u.Phone, &u.Active,
		&u.HomeLat, &u.HomeLng, &finishAt, &u.FinishLat, &u.FinishLng, &u.CreatedAt); err != nil {
		return domain.User{}, noRows(err)
	}
	u.FinishAt = domain.NormalizeFinishAt(domain.FinishAt(finishAt))
	return u, nil
}

func scanCustomer(row scanner) (domain.Customer, error) {
	var c domain.Customer
	var fieldsJSON []byte
	var priority string
	if err := row.Scan(&c.ID, &c.BusinessID, &c.Name, &c.Phone, &c.Address, &c.Lat, &c.Lng, &c.Notes,
		&priority, &c.AccountID, &c.Active, &c.CreatedAt, &fieldsJSON); err != nil {
		return domain.Customer{}, noRows(err)
	}
	c.Priority = domain.NormalizePriority(domain.PriorityTier(priority))
	fields, err := unmarshalFields(fieldsJSON)
	if err != nil {
		return domain.Customer{}, err
	}
	c.CustomFields = fields
	return c, nil
}

func scanRecurring(row scanner) (domain.RecurringOrder, error) {
	var r domain.RecurringOrder
	if err := row.Scan(&r.ID, &r.BusinessID, &r.CustomerID, &r.ProductID, &r.Quantity, &r.WeekdayMask,
		&r.StartDate, &r.EndDate, &r.Active, &r.CreatedAt); err != nil {
		return domain.RecurringOrder{}, noRows(err)
	}
	return r, nil
}

func scanDailyOrder(row scanner) (domain.DailyOrder, error) {
	var o domain.DailyOrder
	var fieldsJSON, capturesJSON []byte
	if err := row.Scan(&o.ID, &o.BusinessID, &o.CustomerID, &o.ProductID, &o.RecurringOrderID, &o.DeliveryDate,
		&o.Quantity, &o.BaseQuantity, &o.Status, &o.OverrideReason, &o.Note, &o.RouteID, &o.Sequence,
		&o.CompletedAt, &o.CreatedAt, &o.UpdatedAt, &fieldsJSON, &capturesJSON); err != nil {
		return domain.DailyOrder{}, noRows(err)
	}

	fields, err := unmarshalFields(fieldsJSON)
	if err != nil {
		return domain.DailyOrder{}, err
	}
	captures, err := unmarshalFields(capturesJSON)
	if err != nil {
		return domain.DailyOrder{}, err
	}
	o.CustomFields = fields
	o.Captures = captures
	return o, nil
}

// marshalOrderBags renders a daily order's two JSONB bags together, since
// every write path needs both and neither is meaningful without the other.
func marshalOrderBags(o domain.DailyOrder) (fields []byte, captures []byte, err error) {
	fields, err = marshalFields(o.CustomFields)
	if err != nil {
		return nil, nil, err
	}
	captures, err = marshalFields(o.Captures)
	if err != nil {
		return nil, nil, err
	}
	return fields, captures, nil
}

func scanRoute(row scanner) (domain.Route, error) {
	var r domain.Route
	if err := row.Scan(&r.ID, &r.BusinessID, &r.RouteDate, &r.Name, &r.DriverID, &r.Status,
		&r.StartLat, &r.StartLng, &r.EndLat, &r.EndLng, &r.EstimatedMeters, &r.CreatedAt); err != nil {
		return domain.Route{}, noRows(err)
	}
	return r, nil
}

// nullableText stores empty strings as SQL NULL. The partial unique
// indexes on users.email/users.phone rely on this: many drivers have no
// email, and ” would collide with every other ” while NULL does not.
func nullableText(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

// ---------- JSONB plumbing ----------
//
// Config and custom-field bags are marshalled here rather than relying on
// pgx's struct scanning, so that the exact bytes written to and read from
// jsonb columns are this package's responsibility and a decoding failure
// surfaces as a normal storage error.

// marshalConfig renders a business config for storage. A zero config
// round-trips as `{}` rather than SQL NULL, so every read path can assume
// a document is present.
func marshalConfig(config domain.BusinessConfig) ([]byte, error) {
	return json.Marshal(config)
}

func unmarshalConfig(raw []byte) (domain.BusinessConfig, error) {
	var config domain.BusinessConfig
	if len(raw) == 0 {
		return config.WithDefaults(), nil
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		return domain.BusinessConfig{}, fmt.Errorf("decode business config: %w", err)
	}
	// Defaults are applied on read as well as write so that a config
	// stored before a terminology field existed still renders a complete
	// UI, rather than showing blank labels after a deploy.
	return config.WithDefaults(), nil
}

// marshalFields stores an empty or nil bag as `{}`, keeping the column
// non-null and letting readers skip a nil check.
func marshalFields(values domain.FieldValues) ([]byte, error) {
	if values == nil {
		values = domain.FieldValues{}
	}
	return json.Marshal(values)
}

func unmarshalFields(raw []byte) (domain.FieldValues, error) {
	if len(raw) == 0 {
		return domain.FieldValues{}, nil
	}
	values := domain.FieldValues{}
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, fmt.Errorf("decode custom fields: %w", err)
	}
	return values, nil
}

func (s *PostgresStore) GetUserByPhone(ctx context.Context, phone string) (domain.User, error) {
	row := s.pool.QueryRow(ctx,
		`select `+userColumns+` from users where phone = $1`, strings.TrimSpace(phone))
	return scanUser(row)
}

func (s *PostgresStore) PutOTPChallenge(ctx context.Context, c domain.OTPChallenge) error {
	_, err := s.pool.Exec(ctx,
		`insert into otp_challenges
			(phone, code_hash, purpose, attempts, expires_at, created_at, business_name, business_type, owner_name)
		 values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 on conflict (phone) do update set
			code_hash = excluded.code_hash,
			purpose = excluded.purpose,
			attempts = 0,
			expires_at = excluded.expires_at,
			created_at = excluded.created_at,
			business_name = excluded.business_name,
			business_type = excluded.business_type,
			owner_name = excluded.owner_name`,
		c.Phone, c.CodeHash, c.Purpose, c.Attempts, c.ExpiresAt, c.CreatedAt,
		c.BusinessName, string(c.BusinessType), c.OwnerName)
	return err
}

func (s *PostgresStore) GetOTPChallenge(ctx context.Context, phone string) (domain.OTPChallenge, error) {
	var c domain.OTPChallenge
	var businessType string
	err := s.pool.QueryRow(ctx,
		`select phone, code_hash, purpose, attempts, expires_at, created_at,
		        business_name, business_type, owner_name
		 from otp_challenges where phone = $1`, phone).
		Scan(&c.Phone, &c.CodeHash, &c.Purpose, &c.Attempts, &c.ExpiresAt, &c.CreatedAt,
			&c.BusinessName, &businessType, &c.OwnerName)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.OTPChallenge{}, ErrNotFound
	}
	if err != nil {
		return domain.OTPChallenge{}, err
	}
	c.BusinessType = domain.BusinessType(businessType)
	return c, nil
}

func (s *PostgresStore) BumpOTPAttempts(ctx context.Context, phone string) (int, error) {
	var attempts int
	err := s.pool.QueryRow(ctx,
		`update otp_challenges set attempts = attempts + 1 where phone = $1 returning attempts`,
		phone).Scan(&attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	return attempts, nil
}

func (s *PostgresStore) DeleteOTPChallenge(ctx context.Context, phone string) error {
	_, err := s.pool.Exec(ctx, `delete from otp_challenges where phone = $1`, phone)
	return err
}
