import { getFrontendConfig } from './config/environments';

const API_BASE_URL = getFrontendConfig().apiBaseUrl;

// The server slides the session forward: any authenticated request made
// with a token more than a day old comes back with a fresh one in
// X-Refreshed-Token. Handing it straight to whoever is holding the
// session keeps a daily user signed in forever without a refresh
// endpoint, a refresh token, or any screen knowing this happens.
//
// Set once by App.js. Requests made before then (there are none — every
// authenticated call happens after sign-in) simply drop the new token,
// which costs a re-issue on the next request rather than anything worse.
let onTokenRefreshed = null;

export function setTokenRefreshHandler(handler) {
  onTokenRefreshed = handler;
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {}),
    },
  });

  const refreshed = response.headers.get('X-Refreshed-Token');
  if (refreshed && onTokenRefreshed) {
    onTokenRefreshed(refreshed);
  }

  const text = await response.text();

  // The API answers in JSON, but the things in front of it don't always:
  // Go's mux 404s with plain "404 page not found", a proxy can return an
  // HTML error page, and a dropped connection returns nothing at all.
  // Parsing those as JSON produced the genuinely unhelpful "Unexpected
  // non-whitespace character after JSON at position 4" — an error about
  // our parser, shown to someone trying to move a delivery. Fall back to
  // saying what actually happened instead.
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (err) {
      if (response.ok) {
        throw new Error('The server sent a response this app could not read.');
      }
      const failure = new Error(
        response.status === 404
          ? 'That action is not available on this server — it may be running an older version.'
          : `The server returned an error (${response.status}).`
      );
      failure.status = response.status;
      throw failure;
    }
  }

  if (!response.ok) {
    const error = new Error(body.error || 'Request failed');
    error.status = response.status;
    error.code = body.code;
    throw error;
  }
  return body;
}

// ---------- auth ----------

// Sign in with a phone number and a password.
//
// The one-time-code calls below are intact and still work against a
// server that has them switched on — see passwordauth.go for why this is
// the door that is open today.
export function signIn(phone, password) {
  return request('/api/v1/auth/signin', {
    method: 'POST',
    body: JSON.stringify({ phone, password }),
  });
}

// Change your own. The current one is required, so an unlocked phone
// can't be used to lock its owner out.
export function changePassword(token, currentPassword, newPassword) {
  return request('/api/v1/auth/password', {
    method: 'POST',
    token,
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
}

// The owner setting a driver's — their first one, and a new one when
// they forget it. There is no channel to send a reset link down.
export function setDriverPassword(token, id, password) {
  return request(`/api/v1/drivers/${id}/password`, {
    method: 'POST',
    token,
    body: JSON.stringify({ password }),
  });
}

// Ask for a one-time code.
//
// The same call covers signing in and signing up: a number the server
// already knows gets a sign-in code, and one it doesn't gets a signup
// code — but only if the business details come with it, since there
// would otherwise be nothing to create. Rejecting with `no_account` is
// how the screen learns to show the signup fields.
export function requestOTP({ phone, businessName, businessType, ownerName }) {
  return request('/api/v1/auth/otp/request', {
    method: 'POST',
    body: JSON.stringify({
      phone,
      business_name: businessName || undefined,
      business_type: businessType || undefined,
      owner_name: ownerName || undefined,
    }),
  });
}

// Exchange a code for a session. Creates the business too, if this was a
// signup — see handleVerifyOTP.
export function verifyOTP(phone, code) {
  return request('/api/v1/auth/otp/verify', {
    method: 'POST',
    body: JSON.stringify({ phone, code }),
  });
}

// Local-dev-only bypass — see backend/internal/httpapi/server.go
// handleDevLogin. The route isn't registered in prod, so this 404s there.
// Kept through the move to phone + OTP precisely so a demo needs neither
// a phone number nor a code.
export function devLogin() {
  return request('/api/v1/auth/dev-login', { method: 'POST' });
}

// Validates a token restored from storage after a reload and re-fetches a
// fresh user/business snapshot in one call. Throws (401/403) exactly like
// any other authed call if the token is expired or the account has since
// been deactivated.
export function getMe(token) {
  return request('/api/v1/auth/me', { method: 'GET', token });
}

// ---------- admin ----------

// Edits the business record itself — name and/or home location (the
// depot). Partial like the customer PATCH: send only what's changing.
// home_lat/home_lng must travel together — the server rejects one sent
// without the other rather than silently moving the pin to a broken spot.
export function updateBusiness(token, changes) {
  return request('/api/v1/business', { method: 'PATCH', token, body: JSON.stringify(changes) });
}

export function listServiceAreas(token) {
  return request('/api/v1/service-areas', { method: 'GET', token });
}

// Where this business already delivers, read back from where its
// customers' pins cluster — so a new business can accept an area in one
// tap instead of inventing a radius in kilometres. Only ever proposes
// places no existing area covers, so it goes quiet once they're set up.
export function suggestServiceAreas(token) {
  return request('/api/v1/service-areas/suggest', { method: 'GET', token });
}

export function createServiceArea(token, area) {
  return request('/api/v1/service-areas', { method: 'POST', token, body: JSON.stringify(area) });
}

// Hand customers to a service route by hand. Creating a route
// deliberately leaves settled customers on the route they were already
// on (see keepCustomersWhereTheyAre); this is how the screen offers to
// hand them over anyway.
export function addCustomersToServiceArea(token, areaId, customerIds) {
  return request(`/api/v1/service-areas/${areaId}/customers`, {
    method: 'POST',
    token,
    body: JSON.stringify({ customer_ids: customerIds }),
  });
}

export function updateServiceArea(token, id, changes) {
  return request(`/api/v1/service-areas/${id}`, { method: 'PATCH', token, body: JSON.stringify(changes) });
}

// Who is delivering this area today. One driver means one route; several
// means the area is split between them, each finishing at their own home
// (see handleSetAreaDrivers). Returns the whole day, since one area's
// routes changing changes the day's shape.
export function setAreaDrivers(token, areaId, driverIds, date, maxPerDriver) {
  return request(`/api/v1/service-areas/${areaId}/drivers`, {
    method: 'POST',
    token,
    body: JSON.stringify({
      driver_ids: driverIds,
      date: date || undefined,
      // Absent or zero means no limit — see route.PartitionCapped.
      max_per_driver: maxPerDriver && Object.keys(maxPerDriver).length > 0 ? maxPerDriver : undefined,
    }),
  });
}

export function listCustomers(token) {
  return request('/api/v1/customers', { method: 'GET', token });
}

export function createCustomer(token, customer) {
  return request('/api/v1/customers', { method: 'POST', token, body: JSON.stringify(customer) });
}

// PATCH is a partial update: send only the fields being changed. Sending
// just { lat, lng } is the "drop the pin at the door" case and leaves the
// name/address/notes alone.
export function updateCustomer(token, id, changes) {
  return request(`/api/v1/customers/${id}`, { method: 'PATCH', token, body: JSON.stringify(changes) });
}

// The admin's own visiting order for a list of customers: the first id
// becomes rank 1. Customers not in the list keep the rank they had, so
// ordering one town says nothing about another. Pass clear:true to hand
// the listed customers back to the shortest path.
export function setCustomerOrder(token, customerIds, { clear = false } = {}) {
  return request('/api/v1/customers/order', {
    method: 'POST',
    token,
    body: JSON.stringify({ customer_ids: customerIds, clear }),
  });
}

export function listProducts(token) {
  return request('/api/v1/products', { method: 'GET', token });
}

export function createProduct(token, product) {
  return request('/api/v1/products', { method: 'POST', token, body: JSON.stringify(product) });
}

// Partial: send only what changed. The stock control sends a stock
// number alone and must not blank out a price someone else set.
export function updateProduct(token, id, changes) {
  return request(`/api/v1/products/${id}`, { method: 'PATCH', token, body: JSON.stringify(changes) });
}

// How much of each product the day's still-pending deliveries add up to,
// keyed by product id — what stock has to be measured against.
export function getProductDemand(token, date) {
  return request(`/api/v1/products/demand${date ? `?date=${date}` : ''}`, { method: 'GET', token });
}

export function listDrivers(token) {
  return request('/api/v1/drivers', { method: 'GET', token });
}

export function createDriver(token, driver) {
  return request('/api/v1/drivers', { method: 'POST', token, body: JSON.stringify(driver) });
}

// Where a driver finishes their day. Not a contact detail — any route
// they are assigned to ends here, and the last stop is chosen for it.
export function setDriverHome(token, id, lat, lng) {
  return request(`/api/v1/drivers/${id}/home`, {
    method: 'POST',
    token,
    body: JSON.stringify({ home_lat: lat, home_lng: lng }),
  });
}


// Where this driver's round ends: the farm, their own home, or a pin.
// Changing it re-orders their routes for today, so the whole day comes
// back — same shape as assigning a driver.
export function setDriverFinish(token, id, finishAt, lat, lng) {
  return request(`/api/v1/drivers/${id}/finish`, {
    method: 'POST',
    token,
    body: JSON.stringify({ finish_at: finishAt, finish_lat: lat || 0, finish_lng: lng || 0 }),
  });
}

// How many deliveries fit in this driver's van. Zero clears the limit.
// Stored on the driver, not on today's route: rounds re-prepare
// themselves on every read of the day, and anything the server didn't
// remember would be undone by the next page load.
export function setDriverMaxStops(token, id, maxStops) {
  return request(`/api/v1/drivers/${id}/max-stops`, {
    method: 'POST',
    token,
    body: JSON.stringify({ max_stops: maxStops }),
  });
}

export function setDriverActive(token, id, active) {
  return request(`/api/v1/drivers/${id}/active`, { method: 'POST', token, body: JSON.stringify({ active }) });
}

export function listRecurringOrders(token) {
  return request('/api/v1/recurring-orders', { method: 'GET', token });
}

export function createRecurringOrder(token, order) {
  return request('/api/v1/recurring-orders', { method: 'POST', token, body: JSON.stringify(order) });
}

// Standing orders are never edited in place — changing one is a
// deactivate plus a create, which keeps the old arrangement on the record
// rather than rewriting history. Used to replace a customer's standing
// order for a product instead of stacking a second one beside it.
export function setRecurringActive(token, id, active) {
  return request(`/api/v1/recurring-orders/${id}/active`, {
    method: 'POST',
    token,
    body: JSON.stringify({ active }),
  });
}

// Move one stop to a 1-based position on its route. Out of range is
// clamped rather than rejected, so "move the first one up" is a no-op
// instead of an error. Pins the route: see handleMoveStopPosition.
export function moveStopToPosition(token, orderId, position) {
  return request(`/api/v1/orders/${orderId}/position`, {
    method: 'POST',
    token,
    body: JSON.stringify({ position }),
  });
}

// ---------- start of day ----------

// The driver reporting what they loaded at the farm. Their stops stay
// hidden until an admin agrees with the count.
export function driverCheckin(token, units, note) {
  return request('/api/v1/driver/checkin', {
    method: 'POST',
    token,
    body: JSON.stringify({ units, note: note || '' }),
  });
}

export function listCheckins(token, date) {
  return request(`/api/v1/checkins${date ? `?date=${date}` : ''}`, { method: 'GET', token });
}

// Approving unlocks that driver's round. Rejecting requires a reason —
// the driver needs to know what to recount.
export function reviewCheckin(token, driverId, approve, note, date) {
  return request(`/api/v1/checkins/${driverId}/review${date ? `?date=${date}` : ''}`, {
    method: 'POST',
    token,
    body: JSON.stringify({ approve, note: note || '' }),
  });
}

// date is optional and defaults, server-side, to today in the business's
// own timezone — never the device's. See domain.Business.Today.
export function getDay(token, date) {
  return request(`/api/v1/day${date ? `?date=${date}` : ''}`, { method: 'GET', token });
}

// Safe to call repeatedly: existing deliveries — including overrides and
// anything the driver has already completed — are left untouched.
export function generateDay(token, date) {
  return request(`/api/v1/day/generate${date ? `?date=${date}` : ''}`, { method: 'POST', token });
}

// The date-specific override. Changing a quantity or skipping a date here
// never touches the customer's standing subscription.
export function overrideOrder(token, id, changes) {
  return request(`/api/v1/orders/${id}`, { method: 'PATCH', token, body: JSON.stringify(changes) });
}

export function createAdHocOrder(token, order) {
  return request('/api/v1/orders', { method: 'POST', token, body: JSON.stringify(order) });
}


// Moves one delivery onto a different route, or off every route with an
// empty route_id. Both affected routes are re-ordered server-side.
export function moveStopToRoute(token, orderId, routeId) {
  return request(`/api/v1/orders/${orderId}/route`, {
    method: 'PATCH',
    token,
    body: JSON.stringify({ route_id: routeId || '' }),
  });
}

// Deletes one route. Its deliveries survive and go back to unrouted.
// Refused if the route carries deliveries already completed on it.
export function deleteRoute(token, id) {
  return request(`/api/v1/routes/${id}`, { method: 'DELETE', token });
}


// Pass route_id to rebuild an existing route in place (absorbing any
// newly-added stops) instead of creating a second one for the same day.
export function buildRoute(token, options) {
  return request('/api/v1/routes', { method: 'POST', token, body: JSON.stringify(options) });
}

export function assignRoute(token, id, driverId) {
  return request(`/api/v1/routes/${id}/assign`, {
    method: 'POST',
    token,
    body: JSON.stringify({ driver_id: driverId }),
  });
}

// ---------- driver ----------

export function getDriverToday(token, date) {
  return request(`/api/v1/driver/today${date ? `?date=${date}` : ''}`, { method: 'GET', token });
}

// captures are the doorstep values the business declared it needs for
// this outcome (see the config endpoint). Validated server-side against
// those declarations — this call deliberately does no client-side
// checking of its own, so the two can't drift.
export function setStopStatus(token, id, status, note, captures) {
  return request(`/api/v1/driver/stops/${id}/status`, {
    method: 'POST',
    token,
    body: JSON.stringify({ status, note, captures: captures || {} }),
  });
}
