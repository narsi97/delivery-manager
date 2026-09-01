package storage

import (
	"context"
	"errors"

	"delivery-manager/internal/domain"
)

var (
	ErrNotFound = errors.New("not found")
	// ErrConflict means the write collided with an existing record on a
	// uniqueness rule — a second admin for an email already in use, a
	// second driver on the same phone number.
	ErrConflict = errors.New("conflicts with an existing record")
)

// Store is implemented by both the in-memory store (local dev without
// Docker/Postgres running — see USE_DOCKER_POSTGRES in run-local.sh) and
// the Postgres store (everywhere else).
//
// Every method that touches tenant-owned data takes businessID as its
// first scoping argument and filters on it, rather than trusting the
// record ID to be unguessable. This product is multi-tenant from day one
// (see 3vnsystems-infrastructure/PRODUCT-PLANNING.md) and the whole point
// of that decision is that one business can never read or write another's
// customers — enforcing it at the storage boundary means no handler can
// forget to.
type Store interface {
	// CreateBusiness creates the business and its first admin together.
	// A business with no admin is unusable and an admin with no business
	// has nothing to administer, so they are created in one call (one
	// transaction, in Postgres) rather than leaving a window where
	// either can exist alone. Returns ErrConflict if the admin's email
	// already belongs to an account.
	CreateBusiness(ctx context.Context, b domain.Business, admin domain.User) (domain.Business, domain.User, error)
	GetBusiness(ctx context.Context, id string) (domain.Business, error)
	// UpdateBusiness persists the whole record — used for the small set
	// of plain scalar fields an admin can edit directly (name, home
	// location). Business.Config has its own replace-the-document path
	// (UpdateBusinessConfig, below); this is for everything else on the
	// struct.
	UpdateBusiness(ctx context.Context, b domain.Business) (domain.Business, error)
	// UpdateBusinessConfig replaces a tenant's configuration wholesale —
	// vocabulary, custom field declarations, stop captures. Replacement
	// rather than a merge because the config is edited as one document by
	// one admin at a time, and a partial-update API for a nested
	// structure like this invites exactly the ambiguity ("does an absent
	// list mean 'unchanged' or 'empty'?") that makes it unsafe to reason
	// about. Callers validate before calling (domain.BusinessConfig.Validate).
	UpdateBusinessConfig(ctx context.Context, businessID string, config domain.BusinessConfig) (domain.Business, error)

	// GetAdminByEmail looks an admin up across all tenants, because at
	// Google sign-in time we only have an email and don't yet know which
	// business it belongs to. Email is therefore globally unique among
	// admins — one Google account administers at most one business in
	// V1. (A person who genuinely runs two dairies needs two accounts;
	// multi-business membership is a real feature, not a free side
	// effect, and isn't in this slice.)
	GetAdminByEmail(ctx context.Context, email string) (domain.User, error)
	// GetUserByPhone is the same lookup for *any* role, which is what
	// sign-in needs now that owners and drivers both identify by phone
	// and the screen has no idea which it is dealing with until the
	// number resolves.
	GetUserByPhone(ctx context.Context, phone string) (domain.User, error)

	// A one-time code in flight, keyed by phone. PutOTPChallenge
	// replaces any existing challenge for that number rather than
	// adding a second — see domain.OTPChallenge.
	PutOTPChallenge(ctx context.Context, c domain.OTPChallenge) error
	GetOTPChallenge(ctx context.Context, phone string) (domain.OTPChallenge, error)
	// BumpOTPAttempts records a wrong guess and returns the new total, so
	// the caller can burn the code once it has been guessed at too often.
	BumpOTPAttempts(ctx context.Context, phone string) (int, error)
	DeleteOTPChallenge(ctx context.Context, phone string) error

	// A driver's start-of-day check-in. PutCheckin replaces any existing
	// one for that driver and date — reporting again is a correction, not
	// a second request in a queue.
	PutCheckin(ctx context.Context, c domain.Checkin) (domain.Checkin, error)
	GetCheckin(ctx context.Context, businessID string, driverID string, date string) (domain.Checkin, error)
	ListCheckins(ctx context.Context, businessID string, date string) ([]domain.Checkin, error)

	// CreateUser adds a driver (or a second admin) to an existing
	// business. pinHash may be empty for admins, who authenticate with
	// Google instead. Returns ErrConflict on a duplicate email or phone.
	CreateUser(ctx context.Context, u domain.User, pinHash string) (domain.User, error)
	GetUserByID(ctx context.Context, businessID string, id string) (domain.User, error)
	ListUsers(ctx context.Context, businessID string) ([]domain.User, error)
	// SetUserActive is how a lost handset is dealt with: deactivating a
	// driver makes their existing token stop working at the next request
	// (see httpapi's auth middleware, which reloads the user), without
	// needing token revocation infrastructure.
	SetUserActive(ctx context.Context, businessID string, id string, active bool) (domain.User, error)
	// SetUserPIN replaces a driver's PIN — the "driver forgot their PIN"
	// path, which an admin performs.
	// SetUserHome records where a driver finishes their day, which is
	// what an assigned route ends at (see handleAssignRoute).
	SetUserHome(ctx context.Context, businessID string, id string, lat, lng float64) (domain.User, error)
	// SetUserFinish records where this driver's round ends — the farm,
	// their own home, or a custom pin. See domain.FinishAt for why the
	// farm rather than home is the default.
	SetUserFinish(ctx context.Context, businessID string, id string, finishAt domain.FinishAt, lat, lng float64) (domain.User, error)
	// SetUserMaxStops caps how many deliveries this driver takes in a
	// round. Zero clears the cap — see domain.User.MaxStops.
	SetUserMaxStops(ctx context.Context, businessID string, id string, max int) (domain.User, error)
	SetUserPIN(ctx context.Context, businessID string, id string, pinHash string) error

	CreateCustomer(ctx context.Context, c domain.Customer) (domain.Customer, error)
	UpdateCustomer(ctx context.Context, c domain.Customer) (domain.Customer, error)
	GetCustomer(ctx context.Context, businessID string, id string) (domain.Customer, error)
	ListCustomers(ctx context.Context, businessID string) ([]domain.Customer, error)

	CreateProduct(ctx context.Context, p domain.Product) (domain.Product, error)
	ListProducts(ctx context.Context, businessID string) ([]domain.Product, error)
	GetProduct(ctx context.Context, businessID string, id string) (domain.Product, error)
	// UpdateProduct edits the whole product record — price, unit, stock,
	// and whether it is still sold. Products were create-and-list only
	// until a business needed to price what it already sells and say what
	// it has in stock.
	UpdateProduct(ctx context.Context, p domain.Product) (domain.Product, error)

	// ServiceArea has no Delete — like Customer, RecurringOrder and User,
	// it is soft-deactivated (see domain.ServiceArea.Active) rather than
	// destroyed, folded into UpdateServiceArea.
	CreateServiceArea(ctx context.Context, sa domain.ServiceArea) (domain.ServiceArea, error)
	GetServiceArea(ctx context.Context, businessID string, id string) (domain.ServiceArea, error)
	ListServiceAreas(ctx context.Context, businessID string) ([]domain.ServiceArea, error)
	UpdateServiceArea(ctx context.Context, sa domain.ServiceArea) (domain.ServiceArea, error)

	CreateRecurringOrder(ctx context.Context, r domain.RecurringOrder) (domain.RecurringOrder, error)
	ListRecurringOrders(ctx context.Context, businessID string) ([]domain.RecurringOrder, error)
	SetRecurringOrderActive(ctx context.Context, businessID string, id string, active bool) (domain.RecurringOrder, error)

	// EnsureDailyOrder is the idempotent generation primitive: given the
	// daily order a subscription implies for a date, create it, or return
	// the one that already exists untouched. The second return value
	// reports whether a row was created.
	//
	// "Untouched" is the important part. Generation is triggered by an
	// admin pressing a button and may be run repeatedly during a morning
	// — after adding a late customer, say. If regeneration overwrote
	// existing rows it would silently wipe the overrides ("no milk this
	// week") and the driver's completions that had already happened,
	// which is the single most damaging bug this feature could have.
	EnsureDailyOrder(ctx context.Context, o domain.DailyOrder) (domain.DailyOrder, bool, error)
	CreateDailyOrder(ctx context.Context, o domain.DailyOrder) (domain.DailyOrder, error)
	ListDailyOrders(ctx context.Context, businessID string, date string) ([]domain.DailyOrder, error)
	GetDailyOrder(ctx context.Context, businessID string, id string) (domain.DailyOrder, error)
	UpdateDailyOrder(ctx context.Context, o domain.DailyOrder) (domain.DailyOrder, error)

	CreateRoute(ctx context.Context, r domain.Route) (domain.Route, error)
	GetRoute(ctx context.Context, businessID string, id string) (domain.Route, error)
	ListRoutes(ctx context.Context, businessID string, date string) ([]domain.Route, error)
	UpdateRoute(ctx context.Context, r domain.Route) (domain.Route, error)
	// AssignStops sets the route and 1-based sequence for exactly the
	// given daily orders, in the given order, and detaches any other stop
	// previously on that route. Rebuilding a route is therefore a single
	// atomic replacement rather than a detach-then-attach sequence that
	// could leave stops orphaned halfway through.
	AssignStops(ctx context.Context, businessID string, routeID string, orderedDailyOrderIDs []string) error

	// DeleteRoute removes a route and detaches its stops (the daily_orders
	// FK is ON DELETE SET NULL), leaving the deliveries themselves alone.
	// Planning a day's rounds replaces whatever plan was there before, and
	// without this a re-plan would pile new rounds on top of the old ones.
	// The only destructive call in this interface, and deliberately narrow:
	// it takes a route, never a date or a business.
	DeleteRoute(ctx context.Context, businessID string, id string) error

	AppendDeliveryEvent(ctx context.Context, e domain.DeliveryEvent) error
	ListDeliveryEvents(ctx context.Context, businessID string, dailyOrderID string) ([]domain.DeliveryEvent, error)

	Close()
}
