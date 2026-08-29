import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from '../api';
import { Banner, Button, Card, DeclaredFields, Disclosure, Empty, Field, FieldRow, Pill, SectionTitle } from '../components';
import { customFieldsFor, labelsFor, lower } from '../labels';
import LocationPicker from '../LocationPicker';
import { nearestAreaFor } from '../serviceAreas';
import { colors, radius, spacing } from '../theme';

const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

export default function CustomersScreen({ token, business }) {
  const labels = labelsFor(business);
  const fieldSpecs = customFieldsFor(business, 'customer');
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [areas, setAreas] = useState([]);
  const [day, setDay] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  // Only "city" does anything today — the control exists now so "Today's
  // pending" / "Today's failed" (need today's per-customer status, which
  // the day fetch below now carries) slot in later as more modes without
  // reshaping this screen again.
  const [groupBy, setGroupBy] = useState('city');

  // Scopes every map below to the business's own operating area instead
  // of an India-wide default view — see MapPicker.web.js.
  const home = business.home_lat || business.home_lng ? { lat: business.home_lat, lng: business.home_lng } : null;

  const refresh = useCallback(async () => {
    try {
      const [customerResponse, productResponse, subscriptionResponse, areaResponse, dayResponse] = await Promise.all([
        api.listCustomers(token),
        api.listProducts(token),
        api.listRecurringOrders(token),
        api.listServiceAreas(token),
        api.getDay(token),
      ]);
      setCustomers(customerResponse.customers || []);
      setProducts(productResponse.products || []);
      setSubscriptions(subscriptionResponse.recurring_orders || []);
      setAreas(areaResponse.service_areas || []);
      setDay(dayResponse);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading) {
    return <ActivityIndicator style={styles.loader} color={colors.accent} />;
  }

  // Today's stop for each customer, by id, with the route name already
  // resolved — so CustomerCard can show "delivered on Kodad round"
  // read-only without needing the routes list itself.
  const routeNames = new Map((day?.routes || []).map((route) => [route.id, route.name]));
  const todayByCustomer = new Map(
    (day?.stops || []).map((stop) => [
      stop.customer_id,
      { status: stop.status, routeName: stop.route_id ? routeNames.get(stop.route_id) : null },
    ])
  );

  const query = search.trim().toLowerCase();
  const words = query.split(/\s+/).filter(Boolean);
  const visibleCustomers =
    words.length === 0
      ? customers
      : customers.filter((customer) => {
          const haystack = `${customer.name} ${customer.phone} ${customer.address}`.toLowerCase();
          return words.every((word) => haystack.includes(word));
        });

  const groups = groupCustomers(groupBy, visibleCustomers, areas);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Banner message={error} />
      <Banner message={notice} tone="success" />

      <NewCustomerCard
        token={token}
        labels={labels}
        fieldSpecs={fieldSpecs}
        home={home}
        areas={areas}
        onCreated={async (name) => {
          setNotice(`Added ${name}.`);
          await refresh();
        }}
        onError={setError}
      />

      <Card>
        <View style={styles.toolsRow}>
          <Field label="Search" size="md" value={search} onChangeText={setSearch} placeholder="Name, phone, or address" />
          <View style={styles.groupByField}>
            <Text style={styles.groupByLabel}>Group by</Text>
            <select value={groupBy} style={groupBySelectStyle} onChange={(event) => setGroupBy(event.target.value)}>
              <option value="city">Cities</option>
            </select>
          </View>
        </View>

        <SectionTitle>
          {labels.customer_plural} ({visibleCustomers.length}
          {visibleCustomers.length !== customers.length ? ` of ${customers.length}` : ''})
        </SectionTitle>
        {customers.length === 0 ? (
          <Empty>No {lower(labels.customer_plural)} yet. Add the first one above.</Empty>
        ) : visibleCustomers.length === 0 ? (
          <Empty>No {lower(labels.customer_plural)} match &quot;{search.trim()}&quot;.</Empty>
        ) : (
          groups.map((group) => (
            <CustomerGroup
              key={group.key}
              name={group.name}
              customers={group.customers}
              defaultExpanded={group.defaultExpanded}
              forceExpanded={words.length > 0}
              products={products}
              subscriptions={subscriptions}
              todayByCustomer={todayByCustomer}
              todayDate={day?.date}
              token={token}
              labels={labels}
              fieldSpecs={fieldSpecs}
              home={home}
              onChanged={refresh}
              onError={setError}
            />
          ))
        )}
      </Card>
    </ScrollView>
  );
}

// A raw DOM element, not an RN primitive — same reasoning as the driver
// <select> elsewhere in this app. Only one <option> exists today since
// "Cities" is the only working mode — the control's presence and
// position are set now so more modes can be added as more <option>s
// later without reshaping this screen again. Sized to content rather
// than stretched — same "a picker isn't a paragraph" reasoning as the
// route screens' driver <select> (see routeCards.js's compactSelectStyle).
const groupBySelectStyle = {
  width: 'auto',
  minWidth: 100,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: radius.md,
  paddingTop: spacing.sm,
  paddingBottom: spacing.sm,
  paddingLeft: spacing.md,
  paddingRight: spacing.md,
  fontSize: 14,
  color: colors.text,
  backgroundColor: colors.surface,
  fontFamily: 'inherit',
};

// Buckets customers by which service area their pin falls in — the same
// "group by nearest city" the Routes screen already does for building
// routes, applied here so a real customer list (dozens of customers, not
// three) reads as a handful of towns instead of one long undifferentiated
// scroll. Computed live, not stored: it can't go stale if an area's
// radius changes, and a customer with no pin (or one outside every area)
// lands in the same catch-all bucket. Named groups sort alphabetically;
// the catch-all always sorts last. City groups default collapsed — the
// catch-all defaults open, since it's the one that usually needs
// attention (strays with no pin, or outside anywhere you've set up).
function groupCustomers(groupBy, customers, areas) {
  // The switch has exactly one case today on purpose — see groupBy's
  // state comment above for what else is meant to land here.
  switch (groupBy) {
    case 'city':
    default: {
      const groups = new Map();
      for (const customer of customers) {
        const hasPin = customer.lat || customer.lng;
        const area = hasPin ? nearestAreaFor(customer.lat, customer.lng, areas) : null;
        const key = area ? area.id : 'unassigned';
        if (!groups.has(key)) {
          groups.set(key, {
            key,
            name: area ? area.name : 'Outside your service areas',
            defaultExpanded: !area,
            customers: [],
          });
        }
        groups.get(key).customers.push(customer);
      }
      return [...groups.values()].sort((a, b) => {
        if (a.key === 'unassigned') return 1;
        if (b.key === 'unassigned') return -1;
        return a.name.localeCompare(b.name);
      });
    }
  }
}

// One collapsible section — city groups default collapsed, the
// "outside"/unassigned catch-all defaults open (see groupCustomers),
// and any group is forced open while a search is narrowing the list so
// matches are never hidden behind a closed chevron.
function CustomerGroup({
  name,
  customers,
  defaultExpanded,
  forceExpanded,
  products,
  subscriptions,
  todayByCustomer,
  todayDate,
  token,
  labels,
  fieldSpecs,
  home,
  onChanged,
  onError,
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const isExpanded = expanded || forceExpanded;

  return (
    <View style={styles.group}>
      <Disclosure
        open={isExpanded}
        onToggle={() => setExpanded((prev) => !prev)}
        right={<Pill label={String(customers.length)} tone="neutral" />}
      >
        {name}
      </Disclosure>
      {isExpanded
        ? customers.map((customer) => (
            <CustomerCard
              key={customer.id}
              customer={customer}
              products={products}
              subscriptions={subscriptions.filter((sub) => sub.customer_id === customer.id)}
              today={todayByCustomer.get(customer.id) || null}
              todayDate={todayDate}
              token={token}
              labels={labels}
              fieldSpecs={fieldSpecs}
              home={home}
              onChanged={onChanged}
              onError={onError}
            />
          ))
        : null}
    </View>
  );
}

// Collapsed by default — an admin visits this screen far more often to
// glance at or edit existing customers than to add a new one, and the
// full form (address, notes, custom fields, a map) is a lot to show
// before anyone's asked for it. Same expand-on-tap pattern CustomerCard
// already uses below, just defaulting the other way: closed here, closed
// there too, but this one has nothing to summarize while collapsed.
function NewCustomerCard({ token, labels, fieldSpecs, home, areas, onCreated, onError }) {
  const [expanded, setExpanded] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', address: '', lat: '', lng: '', notes: '' });
  const [customFields, setCustomFields] = useState({});
  const [busy, setBusy] = useState(false);

  const set = (key) => (value) => setForm((prev) => ({ ...prev, [key]: value }));

  const submit = async () => {
    setBusy(true);
    try {
      await api.createCustomer(token, {
        name: form.name,
        phone: form.phone,
        address: form.address,
        notes: form.notes,
        lat: Number(form.lat) || 0,
        lng: Number(form.lng) || 0,
        custom_fields: customFields,
      });
      const created = form.name;
      setForm({ name: '', phone: '', address: '', lat: '', lng: '', notes: '' });
      setCustomFields({});
      setExpanded(false);
      await onCreated(created);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Disclosure open={expanded} onToggle={() => setExpanded((prev) => !prev)}>
        Add a {lower(labels.customer)}
      </Disclosure>

      {expanded ? (
        <View style={styles.expanded}>
          <FieldRow>
            <Field label="Name" size="md" value={form.name} onChangeText={set('name')} placeholder="Anita Sharma" />
            <Field label="Phone" size="sm" value={form.phone} onChangeText={set('phone')} keyboardType="phone-pad" placeholder="98765 43210" />
          </FieldRow>
          <Field label="Address" size="md" value={form.address} onChangeText={set('address')} placeholder="12, 3rd Cross, Jayanagar" />
          <LocationPicker
            label="Where do we deliver?"
            hint="Leave it unset if you're not at the door yet — you can drop the pin later."
            lat={Number(form.lat) || 0}
            lng={Number(form.lng) || 0}
            onChange={(newLat, newLng) => setForm((prev) => ({ ...prev, lat: newLat.toFixed(6), lng: newLng.toFixed(6) }))}
            home={home}
            areas={areas}
          />
          <Field
            label={`Notes for the ${lower(labels.driver)}`}
            value={form.notes}
            onChangeText={set('notes')}
            placeholder="Gate code 1234, leave at door"
            multiline
          />
          <DeclaredFields specs={fieldSpecs} values={customFields} onChange={setCustomFields} />
          <Button title={`Add ${lower(labels.customer)}`} onPress={submit} busy={busy} disabled={!form.name.trim()} />
        </View>
      ) : null}
    </Card>
  );
}

const STATUS_TONE = { pending: 'neutral', delivered: 'success', failed: 'error', skipped: 'warning' };

function CustomerCard({ customer, products, subscriptions, today, todayDate, token, labels, fieldSpecs, home, onChanged, onError }) {
  const [expanded, setExpanded] = useState(false);
  const [customFields, setCustomFields] = useState(customer.custom_fields || {});
  const [details, setDetails] = useState({ name: customer.name, phone: customer.phone, address: customer.address });
  const [busy, setBusy] = useState(false);

  const savePin = async (newLat, newLng) => {
    setBusy(true);
    try {
      // Only the pin is sent — PATCH is partial, so the name, address and
      // notes already saved are left untouched.
      await api.updateCustomer(token, customer.id, { lat: newLat, lng: newLng });
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const saveDetails = async () => {
    setBusy(true);
    try {
      await api.updateCustomer(token, customer.id, details);
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Disclosure
        open={expanded}
        onToggle={() => setExpanded((prev) => !prev)}
        right={
          <View style={styles.pills}>
            {today ? <Pill label={today.status} tone={STATUS_TONE[today.status] || 'neutral'} /> : null}
            {customer.lat || customer.lng ? null : <Pill label="no pin" tone="warning" />}
            {!customer.active ? <Pill label="paused" tone="neutral" /> : null}
          </View>
        }
      >
        {customer.name}
      </Disclosure>
      {customer.address || customer.phone ? (
        <Text style={styles.customerMeta}>{[customer.address, customer.phone].filter(Boolean).join(' · ')}</Text>
      ) : null}

      <Text style={styles.subsHeading}>
        {subscriptions.length === 0
          ? 'No standing order yet'
          : subscriptions
              .map((sub) => `${sub.quantity} × ${productName(products, sub.product_id)} on ${weekdayLabel(sub.weekday_mask)}`)
              .join('  ·  ')}
      </Text>

      {expanded ? (
        <View style={styles.expanded}>
          {/* Read-only — reassigning which route a customer's delivery is
              on is a route-level action (Today/Routes tabs), not
              something edited from the customer list. */}
          {today ? (
            <Text style={styles.todayLine}>
              Today: {today.status}
              {today.routeName ? ` on ${today.routeName}` : today.status === 'pending' ? ' · not yet on a route' : ''}
            </Text>
          ) : null}

          <Text style={styles.label}>Contact details</Text>
          <Field label="Name" size="md" value={details.name} onChangeText={(value) => setDetails((prev) => ({ ...prev, name: value }))} />
          <Field
            label="Phone"
            size="sm"
            value={details.phone}
            onChangeText={(value) => setDetails((prev) => ({ ...prev, phone: value }))}
            keyboardType="phone-pad"
          />
          <Field label="Address" size="md" value={details.address} onChangeText={(value) => setDetails((prev) => ({ ...prev, address: value }))} />
          <Button title="Save contact details" variant="secondary" busy={busy} onPress={saveDetails} disabled={!details.name.trim()} />

          <LocationPicker
            label="Where do we deliver?"
            lat={customer.lat}
            lng={customer.lng}
            onChange={savePin}
            home={home}
          />
          <View style={styles.buttonRow}>
            <Button
              title={customer.active ? `Pause ${lower(labels.customer)}` : `Resume ${lower(labels.customer)}`}
              variant="secondary"
              onPress={async () => {
                setBusy(true);
                try {
                  await api.updateCustomer(token, customer.id, { active: !customer.active });
                  await onChanged();
                } catch (err) {
                  onError(err.message);
                } finally {
                  setBusy(false);
                }
              }}
              style={styles.flexButton}
            />
          </View>

          {fieldSpecs.length > 0 ? (
            <View style={styles.subForm}>
              <Text style={styles.label}>Details</Text>
              <DeclaredFields specs={fieldSpecs} values={customFields} onChange={setCustomFields} />
              <Button
                title="Save details"
                busy={busy}
                onPress={async () => {
                  setBusy(true);
                  try {
                    await api.updateCustomer(token, customer.id, { custom_fields: customFields });
                    await onChanged();
                  } catch (err) {
                    onError(err.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            </View>
          ) : null}

          <NewOrderForm
            token={token}
            customer={customer}
            products={products}
            labels={labels}
            todayDate={todayDate}
            onChanged={onChanged}
            onError={onError}
          />
        </View>
      ) : null}
    </Card>
  );
}

// One form, two kinds of order — because from the admin's side they're
// the same sentence with one word different: "Anita wants 2L of milk
// every weekday" vs "Anita wants 1 tub of ghee this Friday". A dairy
// customer on a daily milk subscription buying paneer once in a while is
// the normal case, not an edge case, so the two shouldn't live on
// different screens or behind different buttons.
//
// They land in genuinely different places in the backend, though:
// "Every week" creates a RecurringOrder (a standing arrangement that
// generates a delivery every matching day from here on), while "Just
// once" creates a single DailyOrder directly for one date — see
// handleCreateAdHocOrder in httpapi/admin.go, which marks it with
// BaseQuantity 0 so the day's numbers can tell a one-off apart from a
// subscription that ran.
//
// Collapsed by default, same as every other creation form in this app:
// an admin opens a customer card far more often to check something than
// to add an order.
function NewOrderForm({ token, customer, products, labels, todayDate, onChanged, onError }) {
  const [expanded, setExpanded] = useState(false);
  const [kind, setKind] = useState('weekly');
  const [productId, setProductId] = useState(products[0]?.id || '');
  const [quantity, setQuantity] = useState('1');
  const [weekdays, setWeekdays] = useState([1, 2, 3, 4, 5, 6, 0]);
  // Defaults to the business's own today (server-resolved, see
  // domain.Business.Today) rather than the device's — an admin on a
  // laptop in another zone must not silently book tomorrow.
  const [date, setDate] = useState(todayDate || '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const toggleDay = (day) =>
    setWeekdays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));

  const submit = async () => {
    setBusy(true);
    try {
      if (kind === 'once') {
        await api.createAdHocOrder(token, {
          customer_id: customer.id,
          product_id: productId,
          quantity: Number(quantity),
          date,
          note,
        });
      } else {
        await api.createRecurringOrder(token, {
          customer_id: customer.id,
          product_id: productId,
          quantity: Number(quantity),
          weekdays,
        });
      }
      setQuantity('1');
      setNote('');
      setExpanded(false);
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (products.length === 0) {
    return (
      <View style={styles.subForm}>
        <Empty>Add a {lower(labels.product)} on the Business tab before placing an order.</Empty>
      </View>
    );
  }

  const ready = kind === 'once' ? productId && date && Number(quantity) > 0 : productId && weekdays.length > 0;

  return (
    <View style={styles.subForm}>
      <Disclosure open={expanded} onToggle={() => setExpanded((prev) => !prev)}>
        Add an order
      </Disclosure>

      {expanded ? (
        <View>
          <Text style={styles.label}>How often</Text>
          <View style={styles.chipRow}>
            <Pressable onPress={() => setKind('weekly')} style={[styles.chip, kind === 'weekly' && styles.chipActive]}>
              <Text style={[styles.chipText, kind === 'weekly' && styles.chipTextActive]}>Every week</Text>
            </Pressable>
            <Pressable onPress={() => setKind('once')} style={[styles.chip, kind === 'once' && styles.chipActive]}>
              <Text style={[styles.chipText, kind === 'once' && styles.chipTextActive]}>Just once</Text>
            </Pressable>
          </View>

          <Text style={styles.label}>{labels.product}</Text>
          <View style={styles.chipRow}>
            {products.map((product) => (
              <Pressable
                key={product.id}
                onPress={() => setProductId(product.id)}
                style={[styles.chip, productId === product.id && styles.chipActive]}
              >
                <Text style={[styles.chipText, productId === product.id && styles.chipTextActive]}>{product.name}</Text>
              </Pressable>
            ))}
          </View>

          <Field label={labels.quantity} size="xs" value={quantity} onChangeText={setQuantity} keyboardType="numeric" />

          {kind === 'once' ? (
            <View>
              <Text style={styles.label}>Delivery date</Text>
              {/* A raw date input, same reasoning as DateNav's: the
                  browser's own picker is one every admin already knows,
                  and it validates the format for free. */}
              <input type="date" value={date} min={todayDate || undefined} onChange={(event) => setDate(event.target.value)} style={dateInputStyle} />
              <Field label="Note (optional)" size="md" value={note} onChangeText={setNote} placeholder="For the festival" />
              <Text style={styles.note}>
                Goes straight onto that day&apos;s deliveries — no need to press Generate. Their standing order is
                untouched.
              </Text>
            </View>
          ) : (
            <View>
              <Text style={styles.label}>Delivery days</Text>
              <View style={styles.chipRow}>
                {WEEKDAYS.map((day) => (
                  <Pressable
                    key={day.value}
                    onPress={() => toggleDay(day.value)}
                    style={[styles.chip, weekdays.includes(day.value) && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, weekdays.includes(day.value) && styles.chipTextActive]}>{day.label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}

          <Button
            title={kind === 'once' ? 'Add this one order' : 'Save standing order'}
            onPress={submit}
            busy={busy}
            disabled={!ready}
          />
        </View>
      ) : null}
    </View>
  );
}

// Matches Field's input styling — a raw <input> can't take
// StyleSheet.create output, same reasoning as groupBySelectStyle above.
// Sized like a Field of size="sm": a date is nine characters, not a
// paragraph (see FIELD_WIDTHS in components.js).
const dateInputStyle = {
  width: 170,
  maxWidth: '100%',
  boxSizing: 'border-box',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: colors.border,
  borderRadius: radius.md,
  paddingTop: spacing.sm,
  paddingBottom: spacing.sm,
  paddingLeft: spacing.md,
  paddingRight: spacing.md,
  fontSize: 15,
  color: colors.text,
  backgroundColor: colors.surface,
  fontFamily: 'inherit',
  marginBottom: spacing.md,
};

function productName(products, id) {
  return products.find((product) => product.id === id)?.name || 'item';
}

function weekdayLabel(mask) {
  const days = WEEKDAYS.filter((day) => mask & (1 << day.value));
  if (days.length === 7) {
    return 'every day';
  }
  return days.map((day) => day.label).join(', ') || 'no days';
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, maxWidth: 720, width: '100%', alignSelf: 'center' },
  loader: { marginTop: spacing.xl * 2 },
  group: { marginBottom: spacing.md },
  toolsRow: { flexDirection: 'row', alignItems: 'flex-end', flexWrap: 'wrap', gap: spacing.md },
  groupByField: { marginBottom: spacing.md },
  groupByLabel: { fontSize: 13, fontWeight: '600', color: colors.label, marginBottom: spacing.xs },
  todayLine: { fontSize: 13, color: colors.label, marginBottom: spacing.md, fontWeight: '600' },
  note: { fontSize: 12, color: colors.hint, marginTop: spacing.sm, marginBottom: spacing.md, lineHeight: 17 },
  customerMeta: { fontSize: 13, color: colors.subtitle, marginTop: 2 },
  pills: { flexDirection: 'row', gap: spacing.xs, alignItems: 'center' },
  subsHeading: { fontSize: 13, color: colors.label, marginTop: spacing.sm },
  expanded: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  flexButton: { flex: 1, minWidth: 140 },
  subForm: { marginTop: spacing.lg },
  label: { fontSize: 13, fontWeight: '600', color: colors.label, marginBottom: spacing.xs, marginTop: spacing.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { fontSize: 13, color: colors.label, fontWeight: '600' },
  chipTextActive: { color: colors.accentText },
});
