package storage

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"delivery-manager/internal/domain"
)

// MemoryStore is the local-development store used when DATABASE_URL is
// unset (see USE_DOCKER_POSTGRES=0 in run-local.sh). Data does not survive
// a restart. It exists so the whole admin/driver flow can be exercised on
// a laptop with no Docker running — not as a production fallback.
//
// It holds one mutex over everything rather than finer-grained locks: the
// contention ceiling is one developer clicking around, and a single lock
// is the version that is obviously correct.
type MemoryStore struct {
	mu sync.RWMutex

	businesses   map[string]domain.Business
	users        map[string]domain.User
	pinHashes    map[string]string
	customers    map[string]domain.Customer
	serviceAreas map[string]domain.ServiceArea
	products     map[string]domain.Product
	recurring    map[string]domain.RecurringOrder
	daily        map[string]domain.DailyOrder
	routes       map[string]domain.Route
	events       []domain.DeliveryEvent
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		businesses:   map[string]domain.Business{},
		users:        map[string]domain.User{},
		pinHashes:    map[string]string{},
		customers:    map[string]domain.Customer{},
		serviceAreas: map[string]domain.ServiceArea{},
		products:     map[string]domain.Product{},
		recurring:    map[string]domain.RecurringOrder{},
		daily:        map[string]domain.DailyOrder{},
		routes:       map[string]domain.Route{},
	}
}

func (s *MemoryStore) Close() {}

func (s *MemoryStore) CreateBusiness(ctx context.Context, b domain.Business, admin domain.User) (domain.Business, domain.User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	email := strings.ToLower(strings.TrimSpace(admin.Email))
	for _, existing := range s.users {
		if existing.Email != "" && strings.ToLower(existing.Email) == email {
			return domain.Business{}, domain.User{}, ErrConflict
		}
	}

	b.CreatedAt = time.Now().UTC()
	b.Config = b.Config.WithDefaults()
	admin.BusinessID = b.ID
	admin.Email = email
	admin.CreatedAt = b.CreatedAt
	admin.Active = true

	s.businesses[b.ID] = b
	s.users[admin.ID] = admin
	return b, admin, nil
}

func (s *MemoryStore) GetBusiness(ctx context.Context, id string) (domain.Business, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	b, ok := s.businesses[id]
	if !ok {
		return domain.Business{}, ErrNotFound
	}
	return b, nil
}

// UpdateBusiness persists the plain scalar fields an admin edits directly
// (name, home location) — see the Store interface comment for why this is
// separate from UpdateBusinessConfig.
func (s *MemoryStore) UpdateBusiness(ctx context.Context, b domain.Business) (domain.Business, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	existing, ok := s.businesses[b.ID]
	if !ok {
		return domain.Business{}, ErrNotFound
	}
	existing.Name = b.Name
	existing.HomeLat = b.HomeLat
	existing.HomeLng = b.HomeLng
	s.businesses[b.ID] = existing
	return existing, nil
}

func (s *MemoryStore) UpdateBusinessConfig(ctx context.Context, businessID string, config domain.BusinessConfig) (domain.Business, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	b, ok := s.businesses[businessID]
	if !ok {
		return domain.Business{}, ErrNotFound
	}
	b.Config = config.WithDefaults()
	s.businesses[businessID] = b
	return b, nil
}

func (s *MemoryStore) GetAdminByEmail(ctx context.Context, email string) (domain.User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	email = strings.ToLower(strings.TrimSpace(email))
	for _, u := range s.users {
		if u.Email != "" && strings.ToLower(u.Email) == email && u.Role.CanAdmin() {
			return u, nil
		}
	}
	return domain.User{}, ErrNotFound
}

func (s *MemoryStore) GetDriverByPhone(ctx context.Context, phone string) (domain.User, string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	phone = domain.NormalizePhone(phone)
	if phone == "" {
		return domain.User{}, "", ErrNotFound
	}
	for _, u := range s.users {
		if domain.NormalizePhone(u.Phone) == phone && u.Role.CanDrive() {
			return u, s.pinHashes[u.ID], nil
		}
	}
	return domain.User{}, "", ErrNotFound
}

func (s *MemoryStore) CreateUser(ctx context.Context, u domain.User, pinHash string) (domain.User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	u.Email = strings.ToLower(strings.TrimSpace(u.Email))
	u.Phone = domain.NormalizePhone(u.Phone)

	for _, existing := range s.users {
		if u.Email != "" && strings.ToLower(existing.Email) == u.Email {
			return domain.User{}, ErrConflict
		}
		if u.Phone != "" && domain.NormalizePhone(existing.Phone) == u.Phone {
			return domain.User{}, ErrConflict
		}
	}

	u.CreatedAt = time.Now().UTC()
	s.users[u.ID] = u
	if pinHash != "" {
		s.pinHashes[u.ID] = pinHash
	}
	return u, nil
}

func (s *MemoryStore) GetUserByID(ctx context.Context, businessID string, id string) (domain.User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	u, ok := s.users[id]
	if !ok || u.BusinessID != businessID {
		return domain.User{}, ErrNotFound
	}
	return u, nil
}

func (s *MemoryStore) ListUsers(ctx context.Context, businessID string) ([]domain.User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := []domain.User{}
	for _, u := range s.users {
		if u.BusinessID == businessID {
			out = append(out, u)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, nil
}

func (s *MemoryStore) SetUserActive(ctx context.Context, businessID string, id string, active bool) (domain.User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	u, ok := s.users[id]
	if !ok || u.BusinessID != businessID {
		return domain.User{}, ErrNotFound
	}
	u.Active = active
	s.users[id] = u
	return u, nil
}

func (s *MemoryStore) SetUserPIN(ctx context.Context, businessID string, id string, pinHash string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	u, ok := s.users[id]
	if !ok || u.BusinessID != businessID {
		return ErrNotFound
	}
	s.pinHashes[id] = pinHash
	return nil
}

func (s *MemoryStore) CreateCustomer(ctx context.Context, c domain.Customer) (domain.Customer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	c.CreatedAt = time.Now().UTC()
	c.CustomFields = copyFields(c.CustomFields)
	s.customers[c.ID] = c
	return c, nil
}

func (s *MemoryStore) UpdateCustomer(ctx context.Context, c domain.Customer) (domain.Customer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	existing, ok := s.customers[c.ID]
	if !ok || existing.BusinessID != c.BusinessID {
		return domain.Customer{}, ErrNotFound
	}
	c.CreatedAt = existing.CreatedAt
	c.CustomFields = copyFields(c.CustomFields)
	s.customers[c.ID] = c
	return c, nil
}

func (s *MemoryStore) GetCustomer(ctx context.Context, businessID string, id string) (domain.Customer, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	c, ok := s.customers[id]
	if !ok || c.BusinessID != businessID {
		return domain.Customer{}, ErrNotFound
	}
	return c, nil
}

func (s *MemoryStore) ListCustomers(ctx context.Context, businessID string) ([]domain.Customer, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := []domain.Customer{}
	for _, c := range s.customers {
		if c.BusinessID == businessID {
			out = append(out, c)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *MemoryStore) CreateServiceArea(ctx context.Context, sa domain.ServiceArea) (domain.ServiceArea, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	sa.CreatedAt = time.Now().UTC()
	s.serviceAreas[sa.ID] = sa
	return sa, nil
}

func (s *MemoryStore) GetServiceArea(ctx context.Context, businessID string, id string) (domain.ServiceArea, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	sa, ok := s.serviceAreas[id]
	if !ok || sa.BusinessID != businessID {
		return domain.ServiceArea{}, ErrNotFound
	}
	return sa, nil
}

func (s *MemoryStore) ListServiceAreas(ctx context.Context, businessID string) ([]domain.ServiceArea, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := []domain.ServiceArea{}
	for _, sa := range s.serviceAreas {
		if sa.BusinessID == businessID {
			out = append(out, sa)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *MemoryStore) UpdateServiceArea(ctx context.Context, sa domain.ServiceArea) (domain.ServiceArea, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	existing, ok := s.serviceAreas[sa.ID]
	if !ok || existing.BusinessID != sa.BusinessID {
		return domain.ServiceArea{}, ErrNotFound
	}
	sa.CreatedAt = existing.CreatedAt
	s.serviceAreas[sa.ID] = sa
	return sa, nil
}

func (s *MemoryStore) CreateProduct(ctx context.Context, p domain.Product) (domain.Product, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.products[p.ID] = p
	return p, nil
}

func (s *MemoryStore) GetProduct(ctx context.Context, businessID string, id string) (domain.Product, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	p, ok := s.products[id]
	if !ok || p.BusinessID != businessID {
		return domain.Product{}, ErrNotFound
	}
	return p, nil
}

func (s *MemoryStore) UpdateProduct(ctx context.Context, p domain.Product) (domain.Product, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	existing, ok := s.products[p.ID]
	if !ok || existing.BusinessID != p.BusinessID {
		return domain.Product{}, ErrNotFound
	}
	s.products[p.ID] = p
	return p, nil
}

func (s *MemoryStore) ListProducts(ctx context.Context, businessID string) ([]domain.Product, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := []domain.Product{}
	for _, p := range s.products {
		if p.BusinessID == businessID {
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *MemoryStore) CreateRecurringOrder(ctx context.Context, r domain.RecurringOrder) (domain.RecurringOrder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	r.CreatedAt = time.Now().UTC()
	s.recurring[r.ID] = r
	return r, nil
}

func (s *MemoryStore) ListRecurringOrders(ctx context.Context, businessID string) ([]domain.RecurringOrder, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := []domain.RecurringOrder{}
	for _, r := range s.recurring {
		if r.BusinessID == businessID {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, nil
}

func (s *MemoryStore) SetRecurringOrderActive(ctx context.Context, businessID string, id string, active bool) (domain.RecurringOrder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	r, ok := s.recurring[id]
	if !ok || r.BusinessID != businessID {
		return domain.RecurringOrder{}, ErrNotFound
	}
	r.Active = active
	s.recurring[id] = r
	return r, nil
}

func (s *MemoryStore) EnsureDailyOrder(ctx context.Context, o domain.DailyOrder) (domain.DailyOrder, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if o.RecurringOrderID != nil {
		for _, existing := range s.daily {
			if existing.BusinessID == o.BusinessID &&
				existing.DeliveryDate == o.DeliveryDate &&
				existing.RecurringOrderID != nil &&
				*existing.RecurringOrderID == *o.RecurringOrderID {
				return existing, false, nil
			}
		}
	}

	now := time.Now().UTC()
	o.CreatedAt = now
	o.UpdatedAt = now
	o.CustomFields = copyFields(o.CustomFields)
	o.Captures = copyFields(o.Captures)
	s.daily[o.ID] = o
	return o, true, nil
}

func (s *MemoryStore) CreateDailyOrder(ctx context.Context, o domain.DailyOrder) (domain.DailyOrder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UTC()
	o.CreatedAt = now
	o.UpdatedAt = now
	o.CustomFields = copyFields(o.CustomFields)
	o.Captures = copyFields(o.Captures)
	s.daily[o.ID] = o
	return o, nil
}

func (s *MemoryStore) ListDailyOrders(ctx context.Context, businessID string, date string) ([]domain.DailyOrder, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := []domain.DailyOrder{}
	for _, o := range s.daily {
		if o.BusinessID == businessID && o.DeliveryDate == date {
			out = append(out, o)
		}
	}
	sortDailyOrders(out)
	return out, nil
}

func (s *MemoryStore) GetDailyOrder(ctx context.Context, businessID string, id string) (domain.DailyOrder, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	o, ok := s.daily[id]
	if !ok || o.BusinessID != businessID {
		return domain.DailyOrder{}, ErrNotFound
	}
	return o, nil
}

func (s *MemoryStore) UpdateDailyOrder(ctx context.Context, o domain.DailyOrder) (domain.DailyOrder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	existing, ok := s.daily[o.ID]
	if !ok || existing.BusinessID != o.BusinessID {
		return domain.DailyOrder{}, ErrNotFound
	}
	o.CreatedAt = existing.CreatedAt
	o.UpdatedAt = time.Now().UTC()
	o.CustomFields = copyFields(o.CustomFields)
	o.Captures = copyFields(o.Captures)
	s.daily[o.ID] = o
	return o, nil
}

func (s *MemoryStore) CreateRoute(ctx context.Context, r domain.Route) (domain.Route, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Mirrors routes_business_date_name_idx in the Postgres schema — one
	// round per name per day. Kept here too so the in-memory store an
	// admin runs locally behaves like the one their business runs on.
	for _, existing := range s.routes {
		if existing.BusinessID == r.BusinessID && existing.RouteDate == r.RouteDate && existing.Name == r.Name {
			return domain.Route{}, ErrConflict
		}
	}

	r.CreatedAt = time.Now().UTC()
	s.routes[r.ID] = r
	return r, nil
}

func (s *MemoryStore) DeleteRoute(ctx context.Context, businessID string, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	existing, ok := s.routes[id]
	if !ok || existing.BusinessID != businessID {
		return ErrNotFound
	}
	delete(s.routes, id)

	// Mirrors the ON DELETE SET NULL on daily_orders.route_id: the
	// deliveries survive, they just aren't on a round any more.
	for orderID, order := range s.daily {
		if order.RouteID != nil && *order.RouteID == id {
			order.RouteID = nil
			order.Sequence = 0
			s.daily[orderID] = order
		}
	}
	return nil
}

func (s *MemoryStore) GetRoute(ctx context.Context, businessID string, id string) (domain.Route, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	r, ok := s.routes[id]
	if !ok || r.BusinessID != businessID {
		return domain.Route{}, ErrNotFound
	}
	return r, nil
}

func (s *MemoryStore) ListRoutes(ctx context.Context, businessID string, date string) ([]domain.Route, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := []domain.Route{}
	for _, r := range s.routes {
		if r.BusinessID == businessID && (date == "" || r.RouteDate == date) {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, nil
}

func (s *MemoryStore) UpdateRoute(ctx context.Context, r domain.Route) (domain.Route, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	existing, ok := s.routes[r.ID]
	if !ok || existing.BusinessID != r.BusinessID {
		return domain.Route{}, ErrNotFound
	}
	r.CreatedAt = existing.CreatedAt
	s.routes[r.ID] = r
	return r, nil
}

func (s *MemoryStore) AssignStops(ctx context.Context, businessID string, routeID string, orderedDailyOrderIDs []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if route, ok := s.routes[routeID]; !ok || route.BusinessID != businessID {
		return ErrNotFound
	}

	// Validate every ID before mutating anything, so a bad ID can't leave
	// the route half-assigned.
	for _, id := range orderedDailyOrderIDs {
		o, ok := s.daily[id]
		if !ok || o.BusinessID != businessID {
			return ErrNotFound
		}
	}

	for id, o := range s.daily {
		if o.RouteID != nil && *o.RouteID == routeID {
			o.RouteID = nil
			o.Sequence = 0
			o.UpdatedAt = time.Now().UTC()
			s.daily[id] = o
		}
	}

	for i, id := range orderedDailyOrderIDs {
		o := s.daily[id]
		assigned := routeID
		o.RouteID = &assigned
		o.Sequence = i + 1
		o.UpdatedAt = time.Now().UTC()
		s.daily[id] = o
	}
	return nil
}

func (s *MemoryStore) AppendDeliveryEvent(ctx context.Context, e domain.DeliveryEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	e.CreatedAt = time.Now().UTC()
	s.events = append(s.events, e)
	return nil
}

func (s *MemoryStore) ListDeliveryEvents(ctx context.Context, businessID string, dailyOrderID string) ([]domain.DeliveryEvent, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := []domain.DeliveryEvent{}
	for _, e := range s.events {
		if e.BusinessID == businessID && e.DailyOrderID == dailyOrderID {
			out = append(out, e)
		}
	}
	return out, nil
}

// sortDailyOrders puts routed stops first in driving order, then
// unrouted ones — the order both the admin's day view and the driver's
// stop list want to display.
func sortDailyOrders(orders []domain.DailyOrder) {
	sort.Slice(orders, func(i, j int) bool {
		a, b := orders[i], orders[j]
		if (a.Sequence == 0) != (b.Sequence == 0) {
			return b.Sequence == 0
		}
		if a.Sequence != b.Sequence {
			return a.Sequence < b.Sequence
		}
		return a.CreatedAt.Before(b.CreatedAt)
	})
}

// copyFields defensively copies a custom-field bag on the way into the
// map. The Postgres store serializes these through JSON, so a caller
// can't reach back into stored state there; without a copy here the
// in-memory store would behave differently — a handler mutating the map
// it just saved would silently rewrite history — and the two
// implementations must be interchangeable.
func copyFields(values domain.FieldValues) domain.FieldValues {
	if values == nil {
		return domain.FieldValues{}
	}
	copied := make(domain.FieldValues, len(values))
	for key, value := range values {
		copied[key] = value
	}
	return copied
}
