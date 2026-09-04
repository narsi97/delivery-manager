import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import AddCustomerDialog from '../AddCustomerDialog';
import * as api from '../api';
import {
  AddButton,
  Banner,
  Button,
  Card,
  DeclaredFields,
  Disclosure,
  Empty,
  Field,
  FieldRow,
  Pill,
  SectionTitle,
  ViewToggle,
} from '../components';
import EntityMapPanel from '../EntityMapPanel';
import { customFieldsFor, labelsFor, lower } from '../labels';
import LocationPicker from '../LocationPicker';
import PriorityPicker, { PriorityBadge, priorityRank } from '../PriorityPicker';
import ProductQuantities, { chosenProducts } from '../ProductQuantities';
import { placeOrders } from '../orders';
import { nearestAreaFor, serviceRouteFor } from '../serviceAreas';
import { colors, radius, spacing } from '../theme';
import { UndoBar, useUndoStack } from '../undo';

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
  const [drivers, setDrivers] = useState([]);
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
  // How each group is ordered. "priority" is the order deliveries are
  // actually driven in, which is why it is the default and the only one
  // that can be dragged — see sortCustomers.
  const [sortBy, setSortBy] = useState('priority');
  const [reordering, setReordering] = useState('');
  // Everything on this screen saves as soon as you press the button, so
  // the browser's own undo cannot help once you have. See undo.js.
  const undoStack = useUndoStack({ onError: setError });
  const [adding, setAdding] = useState(false);
  // The same customers, two ways of looking at them — see ViewToggle.
  const [view, setView] = useState('list');

  // Scopes every map below to the business's own operating area instead
  // of an India-wide default view — see MapPicker.web.js.
  const home = business.home_lat || business.home_lng ? { lat: business.home_lat, lng: business.home_lng } : null;

  const refresh = useCallback(async () => {
    try {
      const [customerResponse, productResponse, subscriptionResponse, areaResponse, driverResponse, dayResponse] =
        await Promise.all([
          api.listCustomers(token),
          api.listProducts(token),
          api.listRecurringOrders(token),
          api.listServiceAreas(token),
          api.listDrivers(token),
          api.getDay(token),
        ]);
      setCustomers(customerResponse.customers || []);
      setProducts(productResponse.products || []);
      setSubscriptions(subscriptionResponse.recurring_orders || []);
      setAreas(areaResponse.service_areas || []);
      setDrivers(driverResponse.drivers || []);
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
  // resolved — so CustomerCard can show "delivered on Kodad route"
  // read-only without needing the routes list itself.
  const routeNames = new Map((day?.routes || []).map((route) => [route.id, route.name]));
  const todayByCustomer = new Map(
    (day?.stops || []).map((stop) => [
      stop.customer_id,
      { status: stop.status, routeName: stop.route_id ? routeNames.get(stop.route_id) : null },
    ]),
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
      <UndoBar
        canUndo={undoStack.canUndo}
        canRedo={undoStack.canRedo}
        undoLabel={undoStack.undoLabel}
        redoLabel={undoStack.redoLabel}
        busy={undoStack.busy}
        onUndo={undoStack.undo}
        onRedo={undoStack.redo}
      />

      <Card>
        <SectionTitle
          after={
            <AddButton
              open={adding}
              onPress={() => setAdding((prev) => !prev)}
              label={adding ? `Cancel adding a ${lower(labels.customer)}` : `Add a ${lower(labels.customer)}`}
            />
          }
          right={
            <ViewToggle
              value={view}
              onChange={setView}
              options={[
                { value: 'list', label: 'List' },
                { value: 'map', label: 'Map' },
              ]}
            />
          }
        >
          {labels.customer_plural} ({visibleCustomers.length}
          {visibleCustomers.length !== customers.length ? ` of ${customers.length}` : ''})
        </SectionTitle>
        <View style={styles.headingDivider} />

        <AddCustomerDialog
          open={adding}
          onClose={() => setAdding(false)}
          token={token}
          labels={labels}
          fieldSpecs={fieldSpecs}
          home={home}
          areas={areas}
          products={products}
          onCreated={async (name) => {
            setNotice(`Added ${name}.`);
            setAdding(false);
            await refresh();
          }}
          onError={setError}
        />

        {view === 'list' ? (
          <>
            <View style={styles.toolsRow}>
              <Field
                label="Search"
                size="md"
                value={search}
                onChangeText={setSearch}
                placeholder="Name, phone, or address"
              />
              <View style={styles.groupByField}>
                <Text style={styles.groupByLabel}>Group by</Text>
                <select value={groupBy} style={groupBySelectStyle} onChange={(event) => setGroupBy(event.target.value)}>
                  <option value="city">Cities</option>
                </select>
              </View>
              <View style={styles.groupByField}>
                <Text style={styles.groupByLabel}>Sort by</Text>
                <select value={sortBy} style={groupBySelectStyle} onChange={(event) => setSortBy(event.target.value)}>
                  <option value="priority">Delivery order</option>
                  <option value="name">Name</option>
                </select>
              </View>
            </View>

            {customers.length === 0 ? (
              <Empty>No {lower(labels.customer_plural)} yet. Add the first one with the + above.</Empty>
            ) : visibleCustomers.length === 0 ? (
              <Empty>
                No {lower(labels.customer_plural)} match &quot;{search.trim()}&quot;.
              </Empty>
            ) : (
              groups.map((group) => (
                <CustomerGroup
                  key={group.key}
                  name={group.name}
                  routed={group.key !== 'unassigned'}
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
                  areas={areas}
                  sortBy={sortBy}
                  onRecord={undoStack.record}
                  busy={reordering === group.key}
                  onReorder={async (orderedIds, options) => {
                    setReordering(group.key);
                    setError('');
                    // Captured before the write: if nobody in this group
                    // was ranked, undoing means clearing rather than
                    // writing back the order we happen to be showing,
                    // which would leave them ranked when they weren't.
                    const wasRanked = group.customers.some((customer) => customer.rank > 0);
                    const previous = [...group.customers]
                      .sort((a, b) => (a.rank || 0) - (b.rank || 0))
                      .map((customer) => customer.id);
                    const allIds = group.customers.map((customer) => customer.id);
                    try {
                      await api.setCustomerOrder(token, orderedIds, options);
                      await refresh();
                      undoStack.record({
                        label: options?.clear
                          ? `${group.name}: back to the shortest route`
                          : `${group.name}: delivery order changed`,
                        undo: async () => {
                          await api.setCustomerOrder(token, wasRanked ? previous : allIds, {
                            clear: !wasRanked,
                          });
                          await refresh();
                        },
                        redo: async () => {
                          await api.setCustomerOrder(token, orderedIds, options);
                          await refresh();
                        },
                      });
                    } catch (err) {
                      setError(err.message);
                    } finally {
                      setReordering('');
                    }
                  }}
                  onChanged={refresh}
                  onError={setError}
                />
              ))
            )}
          </>
        ) : (
          <EntityMapPanel
            token={token}
            editableKind="customer"
            home={home}
            drivers={drivers}
            customers={customers}
            areas={areas}
            onChanged={refresh}
            onError={setError}
          />
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

// Buckets customers by which service route they are on — the route they
// were put on by hand, or the one their pin falls in. The same
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
        const area = serviceRouteFor(customer, areas);
        const key = area ? area.id : 'unassigned';
        if (!groups.has(key)) {
          groups.set(key, {
            key,
            name: area ? area.name : 'Not on a service route',
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
  routed,
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
  areas,
  sortBy,
  busy,
  onReorder,
  onRecord,
  onChanged,
  onError,
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  // Which row is being dragged, and which one it is currently over.
  // Held here rather than per-row so the list can render the gap in the
  // right place without every row knowing about every other one.
  //
  // The dragged id is also kept in a ref, and that is the copy the drop
  // reads. A drop handler closes over the state as it was when the row
  // rendered, and nothing guarantees a render happened between picking a
  // row up and letting it go — so reading state there means a drop that
  // sometimes does nothing. The ref is always current.
  const [dragging, setDragging] = useState(null);
  const draggingRef = useRef(null);
  const [over, setOver] = useState(null);
  const isExpanded = expanded || forceExpanded;

  const ordered = sortCustomers(sortBy, customers);
  // Nothing to order in the catch-all: these customers are on no round
  // at all, so "which order are they driven in" has no answer to give.
  // Offering the grip there was the app asking a question it could not
  // act on.
  const canReorder = sortBy === 'priority' && routed;
  const anyRanked = customers.some((customer) => customer.rank > 0);

  // Moving a row is the same operation whether it came from a drag or an
  // arrow: take the list as shown, move one entry, send the whole thing.
  // The server numbers them 1..N, so what the admin sees is what gets
  // driven — see handleSetCustomerOrder.
  const moveTo = (from, to) => {
    if (from === to || to < 0 || to >= ordered.length) {
      return;
    }
    const next = [...ordered];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onReorder(next.map((customer) => customer.id));
  };

  return (
    <View style={styles.group}>
      <Disclosure
        open={isExpanded}
        onToggle={() => setExpanded((prev) => !prev)}
        right={<Pill label={String(customers.length)} tone="neutral" />}
      >
        {name}
      </Disclosure>
      {isExpanded && !routed ? (
        <Text style={styles.orderHint}>
          Not on any {lower(labels.route)} yet — give them a pin inside one, or put them on one from their card.
        </Text>
      ) : null}
      {isExpanded && canReorder ? (
        <View style={styles.orderHintRow}>
          <Text style={styles.orderHint}>
            {anyRanked
              ? 'Delivered in this order. Drag a row, or use the arrows, to change it.'
              : 'Ordered by the shortest route. Drag a row to set your own order instead.'}
          </Text>
          {anyRanked ? (
            <Pressable
              onPress={() => onReorder(customers.map((customer) => customer.id), { clear: true })}
              accessibilityRole="button"
              style={styles.resetOrder}
            >
              <Text style={styles.resetOrderText}>Use shortest route</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {isExpanded
        ? ordered.map((customer, index) => (
            <SortableRow
              key={customer.id}
              draggable={canReorder && !busy}
              isDragging={dragging === customer.id}
              isOver={over === customer.id && dragging !== customer.id}
              onDragStart={() => {
                draggingRef.current = customer.id;
                setDragging(customer.id);
              }}
              onDragEnter={() => setOver(customer.id)}
              onDragEnd={() => {
                draggingRef.current = null;
                setDragging(null);
                setOver(null);
              }}
              onDrop={() => {
                const picked = draggingRef.current;
                draggingRef.current = null;
                setDragging(null);
                setOver(null);
                const from = ordered.findIndex((c) => c.id === picked);
                if (from !== -1) {
                  moveTo(from, index);
                }
              }}
            >
            <CustomerCard
              customer={customer}
              products={products}
              // Active only. A standing order that was replaced or stood
              // down is history, not something this customer still takes —
              // listing them made a customer whose order had been changed
              // twice look like they were getting three deliveries of the
              // same thing.
              subscriptions={subscriptions.filter((sub) => sub.customer_id === customer.id && sub.active !== false)}
              today={todayByCustomer.get(customer.id) || null}
              todayDate={todayDate}
              token={token}
              labels={labels}
              fieldSpecs={fieldSpecs}
              home={home}
              areas={areas}
              onRecord={onRecord}
              reorder={
                canReorder
                  ? {
                      position: index + 1,
                      onUp: index > 0 ? () => moveTo(index, index - 1) : null,
                      onDown: index < ordered.length - 1 ? () => moveTo(index, index + 1) : null,
                    }
                  : null
              }
              onChanged={onChanged}
              onError={onError}
            />
            </SortableRow>
          ))
        : null}
    </View>
  );
}

// One row of the roster, with the controls for moving it.
//
// Two ways to move the same thing, on purpose. Dragging is what an admin
// reaches for with a mouse and a list they can see all of; the arrows
// are what works on a phone, with a keyboard, and with a screen reader —
// and dragging in a scrolling list on a touch screen is the thing that
// has never once worked well. Neither is the "real" one.
//
// A raw <div> because RN's View has no drag events on web; same reason
// the <select>s and coordinate boxes in this app are raw elements.
function SortableRow({ children, draggable, isDragging, isOver, onDragStart, onDragEnter, onDragEnd, onDrop }) {
  if (!draggable) {
    return <View style={styles.plainRow}>{children}</View>;
  }
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onDragOver={(event) => event.preventDefault()}
      onDragEnd={onDragEnd}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      style={{
        display: 'block',
        opacity: isDragging ? 0.4 : 1,
        borderTop: isOver ? `2px solid ${colors.accent}` : '2px solid transparent',
        cursor: 'grab',
      }}
    >
      <div>{children}</div>
    </div>
  );
}

// The reorder strip, rendered inside the customer's own card.
//
// It was a column in the gutter beside the card, which squeezed the card,
// put the arrows at a different height on every row depending on how tall
// that customer was, and left an empty channel running down the whole
// list. Across the top of the card it belongs to the card, lines up with
// every other row, and gives the card its full width back.
function ReorderControls({ position, onUp, onDown }) {
  return (
    <View style={styles.orderControls}>
      {/* The eight dots are the universal "you can pick this up", turned
          the way the strip runs. Decorative — everything it hints at is
          also on the two buttons, which is what keeps this usable
          without a mouse. */}
      <Text style={styles.grip} accessibilityElementsHidden importantForAccessibility="no">
        ⠿
      </Text>
      <Text style={styles.position}>{position}</Text>
      <Pressable
        onPress={onUp || undefined}
        disabled={!onUp}
        accessibilityRole="button"
        accessibilityLabel="Move up"
        style={[styles.moveButton, !onUp && styles.moveButtonOff]}
      >
        <Text style={[styles.moveGlyph, !onUp && styles.moveGlyphOff]}>↑</Text>
      </Pressable>
      <Pressable
        onPress={onDown || undefined}
        disabled={!onDown}
        accessibilityRole="button"
        accessibilityLabel="Move down"
        style={[styles.moveButton, !onDown && styles.moveButtonOff]}
      >
        <Text style={[styles.moveGlyph, !onDown && styles.moveGlyphOff]}>↓</Text>
      </Pressable>
    </View>
  );
}

// The order a group is shown in.
//
// "Delivery order" is not a display preference — it is what the driver
// will actually do, so it mirrors the backend exactly: tier first, then
// the admin's own rank, then name for anything still tied. Sorting by
// name is a way to *find* somebody, and deliberately turns dragging off:
// a drag in an alphabetical list would mean nothing.
function sortCustomers(sortBy, customers) {
  const list = [...customers];
  if (sortBy === 'name') {
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return list.sort((a, b) => {
    const tierA = priorityRank(a.priority);
    const tierB = priorityRank(b.priority);
    if (tierA !== tierB) {
      return tierA - tierB;
    }
    // Unranked sorts after everyone the admin has actually placed —
    // mirrors domain.Customer.RouteBand, where unranked shares the last
    // band in its tier.
    const rankA = a.rank > 0 ? a.rank : Number.MAX_SAFE_INTEGER;
    const rankB = b.rank > 0 ? b.rank : Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    return a.name.localeCompare(b.name);
  });
}

const STATUS_TONE = { pending: 'neutral', delivered: 'success', failed: 'error', skipped: 'warning' };

function CustomerCard({
  customer,
  products,
  subscriptions,
  today,
  todayDate,
  token,
  labels,
  fieldSpecs,
  home,
  areas = [],
  onRecord,
  reorder = null,
  onChanged,
  onError,
}) {
  const [expanded, setExpanded] = useState(false);
  const [customFields, setCustomFields] = useState(customer.custom_fields || {});
  const [details, setDetails] = useState({
    name: customer.name,
    phone: customer.phone,
    address: customer.address,
    priority: customer.priority || 'normal',
  });
  const [busy, setBusy] = useState(false);

  // The standing order in one line. Shown under the name while
  // collapsed, and as the order section's own heading once open —
  // once in each state, never twice at the same time.
  const orderSummary =
    subscriptions.length === 0
      ? 'No standing order yet'
      : subscriptions
          .map((sub) => `${sub.quantity} × ${productName(products, sub.product_id)} on ${weekdayLabel(sub.weekday_mask)}`)
          .join('  ·  ');

  // What "from their pin" would actually resolve to, so the default
  // option says which round that is rather than making the admin work
  // it out from the map.
  const byPin = nearestAreaFor(customer.lat, customer.lng, areas);
  const pinnedRouteName = byPin ? byPin.name : '';

  // Every edit on this card goes through here, so every one of them can
  // be taken back. `before` is the same shape as `changes` — the fields
  // as they were — which is all an undo needs: PATCH is partial, so
  // sending the old values back is the reversal. See undo.js.
  const save = async (changes, before, label) => {
    setBusy(true);
    try {
      await api.updateCustomer(token, customer.id, changes);
      await onChanged();
      if (onRecord && before) {
        onRecord({
          label,
          undo: async () => {
            await api.updateCustomer(token, customer.id, before);
            await onChanged();
          },
          redo: async () => {
            await api.updateCustomer(token, customer.id, changes);
            await onChanged();
          },
        });
      }
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Only the pin is sent — PATCH is partial, so the name, address and
  // notes already saved are left untouched.
  const savePin = (newLat, newLng) =>
    save(
      { lat: newLat, lng: newLng },
      customer.lat || customer.lng ? { lat: customer.lat, lng: customer.lng } : null,
      `${customer.name}: pin moved`,
    );

  const saveDetails = () =>
    save(
      details,
      {
        name: customer.name,
        phone: customer.phone,
        address: customer.address,
        priority: customer.priority || 'normal',
      },
      `${customer.name}: details saved`,
    );

  return (
    <Card>
      <Disclosure
        open={expanded}
        onToggle={() => setExpanded((prev) => !prev)}
        middle={reorder ? <ReorderControls {...reorder} /> : null}
        right={
          <View style={styles.pills}>
            <PriorityBadge value={customer.priority} />
            {today ? <Pill label={today.status} tone={STATUS_TONE[today.status] || 'neutral'} /> : null}
            {customer.lat || customer.lng ? null : <Pill label="no pin" tone="warning" />}
            {!customer.active ? <Pill label="paused" tone="neutral" /> : null}
          </View>
        }
      >
        {customer.name}
      </Disclosure>
      {/* Collapsed, this is the whole customer at a glance. Expanded,
          every line of it turns into the field that edits it just below
          — so it is not repeated here. Showing the address as grey text
          and again in a box two inches down made the card look like it
          held two different customers. */}
      {!expanded ? (
        <View>
          {customer.address || customer.phone ? (
            <Text style={styles.customerMeta}>{[customer.address, customer.phone].filter(Boolean).join(' · ')}</Text>
          ) : null}
          <Text style={styles.subsHeading}>{orderSummary}</Text>
        </View>
      ) : null}

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
          <Field
            label="Name"
            size="md"
            value={details.name}
            onChangeText={(value) => setDetails((prev) => ({ ...prev, name: value }))}
          />
          <Field
            label="Phone"
            size="sm"
            value={details.phone}
            onChangeText={(value) => setDetails((prev) => ({ ...prev, phone: value }))}
            keyboardType="phone-pad"
          />
          <Field
            label="Address"
            size="md"
            value={details.address}
            onChangeText={(value) => setDetails((prev) => ({ ...prev, address: value }))}
          />
          {/* Not only on the add form: which customers open early is
              something a business learns after they have been signed up,
              and the ones who most need marking are the hundred already
              on the list. Saved with the contact details, because it is
              a fact about the customer rather than about today. */}
          <PriorityPicker
            value={details.priority}
            onChange={(value) => setDetails((prev) => ({ ...prev, priority: value }))}
          />
          {/* Which round they are on. "From their pin" is the default and
              stays the answer for almost everybody — this exists for the
              cases geography cannot express, like a house on the evening
              round in the middle of the morning one. Saved on its own
              rather than with the contact details, because moving
              somebody to another round moves today's delivery with them
              and that deserves to be its own deliberate act. */}
          {areas.length > 0 ? (
            <View style={styles.routePicker}>
              <Text style={styles.label}>Which {lower(labels.route)}?</Text>
              <select
                value={customer.service_area_id || ''}
                style={groupBySelectStyle}
                onChange={(event) =>
                  save(
                    { service_area_id: event.target.value },
                    { service_area_id: customer.service_area_id || '' },
                    `${customer.name}: ${lower(labels.route)} changed`,
                  )
                }
              >
                <option value="">From their pin{pinnedRouteName ? ` (${pinnedRouteName})` : ''}</option>
                {areas.map((area) => (
                  <option key={area.id} value={area.id}>
                    {area.name}
                  </option>
                ))}
              </select>
              <Text style={styles.note}>
                {customer.service_area_id
                  ? `On this ${lower(labels.route)} because you put them here, whatever their pin says.`
                  : `Their pin decides, which is right unless two ${lower(labels.route)}s cover the same streets.`}
              </Text>
            </View>
          ) : null}
          <Button
            title="Save contact details"
            variant="secondary"
            busy={busy}
            onPress={saveDetails}
            disabled={!details.name.trim()}
          />

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
              onPress={() =>
                save(
                  { active: !customer.active },
                  { active: customer.active },
                  `${customer.name}: ${customer.active ? 'paused' : 'resumed'}`,
                )
              }
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
                onPress={() =>
                  save(
                    { custom_fields: customFields },
                    { custom_fields: customer.custom_fields || {} },
                    `${customer.name}: details saved`,
                  )
                }
              />
            </View>
          ) : null}

          <View style={styles.orderSummaryBlock}>
            <Text style={styles.label}>Order</Text>
            <Text style={styles.subsHeading}>{orderSummary}</Text>
          </View>
          <NewOrderForm
            token={token}
            customer={customer}
            subscriptions={subscriptions}
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
function NewOrderForm({ token, customer, subscriptions = [], products, labels, todayDate, onChanged, onError }) {
  const [expanded, setExpanded] = useState(false);
  const [kind, setKind] = useState('weekly');
  // The weekly form is an editor for what this customer already takes,
  // not an append-only log. Seeding it from their live standing orders is
  // what makes that true: without it, bumping a product they are already
  // on quietly created a second standing order for the same thing, and
  // they got two deliveries of it a day. Ad-hoc ("just once") orders
  // start empty, because those genuinely are one-off additions.
  const existing = useMemo(() => {
    const byProduct = {};
    for (const sub of subscriptions) {
      if (sub.active !== false) {
        byProduct[sub.product_id] = sub;
      }
    }
    return byProduct;
  }, [subscriptions]);

  const [quantities, setQuantities] = useState(() =>
    Object.fromEntries(Object.entries(existing).map(([productId, sub]) => [productId, sub.quantity])),
  );
  const [weekdays, setWeekdays] = useState(() => {
    const masks = Object.values(existing).map((sub) => sub.weekday_mask);
    // Only adopt the existing days when every standing order agrees on
    // them; a customer on different days per product has no single answer
    // this one control can show, so fall back to every day.
    if (masks.length > 0 && masks.every((m) => m === masks[0])) {
      return WEEKDAYS.map((d) => d.value).filter((v) => masks[0] & (1 << v));
    }
    return [1, 2, 3, 4, 5, 6, 0];
  });
  // Defaults to the business's own today (server-resolved, see
  // domain.Business.Today) rather than the device's — an admin on a
  // laptop in another zone must not silently book tomorrow.
  const [date, setDate] = useState(todayDate || '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const toggleDay = (day) =>
    setWeekdays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));

  // Re-seed once a save has landed and the refreshed standing orders come
  // back, so reopening the form shows what the customer now takes rather
  // than the draft that produced it. Only while collapsed — never yank
  // the numbers out from under someone mid-edit.
  useEffect(() => {
    if (!expanded) {
      setQuantities(Object.fromEntries(Object.entries(existing).map(([id, sub]) => [id, sub.quantity])));
    }
  }, [existing, expanded]);

  const chosen = chosenProducts(quantities);

  const submit = async () => {
    setBusy(true);
    try {
      // One call per product. A RecurringOrder is one row per customer per
      // product, so "milk every day and curd on Fridays" was always
      // several records — the old single-select form just made the admin
      // discover that one product at a time.
      await placeOrders({
        token,
        customerId: customer.id,
        kind,
        chosen,
        weekdays,
        date,
        note,
        // Weekly saves replace this customer's standing orders rather than
        // adding to them; anything they had that is now zero is stood down.
        replacing: kind === 'weekly' ? existing : null,
      });
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

  const ready = chosen.length > 0 && (kind === 'once' ? !!date : weekdays.length > 0);

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

          <Text style={styles.label}>What do they take?</Text>
          <ProductQuantities
            products={products}
            quantities={quantities}
            onChange={setQuantities}
            unitLabel="Set a quantity for everything they want — leave the rest at zero."
          />

          {kind === 'once' ? (
            <View>
              <Text style={styles.label}>Delivery date</Text>
              {/* A raw date input, same reasoning as DateNav's: the
                  browser's own picker is one every admin already knows,
                  and it validates the format for free. */}
              <input
                type="date"
                value={date}
                min={todayDate || undefined}
                onChange={(event) => setDate(event.target.value)}
                style={dateInputStyle}
              />
              <Field
                label="Note (optional)"
                size="md"
                value={note}
                onChangeText={setNote}
                placeholder="For the festival"
              />
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
                    <Text style={[styles.chipText, weekdays.includes(day.value) && styles.chipTextActive]}>
                      {day.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}

          <Button
            title={
              kind === 'once'
                ? `Add ${chosen.length > 1 ? `these ${chosen.length} orders` : 'this one order'}`
                : `Save standing order${chosen.length > 1 ? 's' : ''}`
            }
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
  headingDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginTop: -spacing.sm,
    marginBottom: spacing.md,
  },
  inlineForm: { marginBottom: spacing.md },
  orderSection: {
    marginTop: spacing.sm,
    marginBottom: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  headingActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  toolsRow: { flexDirection: 'row', alignItems: 'flex-end', flexWrap: 'wrap', gap: spacing.md },
  groupByField: { marginBottom: spacing.md },
  plainRow: { width: '100%' },
  routePicker: { marginBottom: spacing.sm },
  orderHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    flexWrap: 'wrap',
    marginBottom: spacing.sm,
  },
  orderHint: { fontSize: 12, color: colors.hint, lineHeight: 17, flexShrink: 1 },
  resetOrder: { paddingVertical: 2 },
  resetOrderText: { fontSize: 12, fontWeight: '700', color: colors.link },
  // A narrow rail beside the card rather than controls inside it: the
  // card is about the customer, this is about where they sit in the
  // round, and mixing the two made every row look like a form.
  // One pill holding the handle, the position and the two arrows —
  // they are a single control, and three separate outlines above a card
  // that already has one read as clutter stacked on clutter.
  orderControls: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: spacing.xs,
    paddingVertical: 3,
    paddingHorizontal: spacing.sm,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  // Rotated a quarter turn: the eight dots read as a vertical handle in
  // a column and as a horizontal one in a row, and the wrong orientation
  // reads as decoration rather than something to grab.
  grip: { fontSize: 15, color: colors.hint, lineHeight: 16, transform: [{ rotate: '90deg' }] },
  position: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.subtitle,
    minWidth: 16,
    textAlign: 'center',
    paddingHorizontal: 2,
  },
  moveButton: {
    width: 26,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
  },
  moveButtonOff: { opacity: 0.35 },
  moveGlyph: { fontSize: 13, fontWeight: '700', color: colors.link, lineHeight: 15 },
  moveGlyphOff: { color: colors.hint },
  groupByLabel: { fontSize: 13, fontWeight: '600', color: colors.label, marginBottom: spacing.xs },
  todayLine: { fontSize: 13, color: colors.label, marginBottom: spacing.md, fontWeight: '600' },
  note: { fontSize: 12, color: colors.hint, marginTop: spacing.sm, marginBottom: spacing.md, lineHeight: 17 },
  customerMeta: { fontSize: 13, color: colors.subtitle, marginTop: 2 },
  // Right-aligned inside a fixed block, so the reorder pill beside them
  // lands in the same column on every row. Without it a customer with
  // one badge pushed their pill 70px further right than the customer
  // above, and a list of controls that do not line up reads as a list
  // of different controls.
  pills: {
    flexDirection: 'row',
    gap: spacing.xs,
    alignItems: 'center',
    justifyContent: 'flex-end',
    minWidth: 148,
  },
  subsHeading: { fontSize: 13, color: colors.label, marginTop: spacing.sm },
  orderSummaryBlock: { marginTop: spacing.lg },
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
