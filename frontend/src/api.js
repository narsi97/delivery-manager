import { getFrontendConfig } from './config/environments';

const API_BASE_URL = getFrontendConfig().apiBaseUrl;

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {}),
    },
  });

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

export function signUpBusiness(idToken, businessName, businessType, timezone) {
  return request('/api/v1/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      id_token: idToken,
      business_name: businessName,
      business_type: businessType,
      timezone: timezone,
    }),
  });
}

export function googleSignIn(idToken) {
  return request('/api/v1/auth/google', {
    method: 'POST',
    body: JSON.stringify({ id_token: idToken }),
  });
}

// Drivers never touch Google — an admin issues them a phone number and a
// 6-digit PIN. See backend/internal/auth/pin.go.
export function driverSignIn(phone, pin) {
  return request('/api/v1/auth/driver-login', {
    method: 'POST',
    body: JSON.stringify({ phone, pin }),
  });
}

// Local-dev-only bypass — see backend/internal/httpapi/server.go
// handleDevLogin. The route isn't registered in prod, so this 404s there.
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

export function createServiceArea(token, area) {
  return request('/api/v1/service-areas', { method: 'POST', token, body: JSON.stringify(area) });
}

export function updateServiceArea(token, id, changes) {
  return request(`/api/v1/service-areas/${id}`, { method: 'PATCH', token, body: JSON.stringify(changes) });
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

export function resetDriverPin(token, id, pin) {
  return request(`/api/v1/drivers/${id}/pin`, { method: 'POST', token, body: JSON.stringify({ pin }) });
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

// Splits a day's pending deliveries across `count` routes (1-10) and
// orders each one. Replaces whatever routes the day already had, except
// any holding work a driver already completed. Pass return_home to count
// the drive back to the start point, which changes the order chosen.
export function planRoutes(token, options) {
  return request('/api/v1/routes/plan', { method: 'POST', token, body: JSON.stringify(options) });
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

// Clears a day's routes and starts over. With service areas set up the
// next read prepares the per-area routes again, so this is "back to what
// we'd have had without planning by hand" rather than "no routes".
export function resetRoutes(token, date) {
  return request(`/api/v1/routes/reset${date ? `?date=${date}` : ''}`, { method: 'POST', token });
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
