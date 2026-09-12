import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import AddCustomerDialog from '../AddCustomerDialog';
import ImportCustomersDialog from '../ImportCustomersDialog';
import CustomerTimeline from '../CustomerTimeline';
import DeleteButton from '../DeleteButton';
import { useDeleteMode } from '../deleteMode';
import * as api from '../api';
import { AddButton, Banner, Button, Card, DeclaredFields, Disclosure, Empty, Field, FieldRow, Pill, SectionTitle, SummaryRow, SummaryTile } from '../components';
import EntityMapPanel from '../EntityMapPanel';
import { customFieldsFor, labelsFor, lower } from '../labels';
import LocationPicker from '../LocationPicker';
import PriorityPicker, { PriorityBadge, priorityRank } from '../PriorityPicker';
import ProductQuantities, { chosenProducts } from '../ProductQuantities';
import { placeOrders } from '../orders';
import { nearestAreaFor, serviceRouteFor } from '../serviceAreas';
import { colors, radius, spacing } from '../theme';
import { EVERY_DAY, daysFromMask, describeDays } from '../frequency';
import { useNarrow, usePageStyle, useTouchOnly } from '../layout';
import { UndoBar, useUndoStack } from '../undo';

export default function CustomersScreen({ token, business, user, onScroll }) {
  const pageStyle = usePageStyle(720);
  const labels = labelsFor(business);
  const { open: canDelete } = useDeleteMode(user);
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
  const [reordering, setReordering] = useState('');
  // Everything on this screen saves as soon as you press the button, so
  // the browser's own undo cannot help once you have. See undo.js.
  const undoStack = useUndoStack({ onError: setError });
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  // The map is one of the ways of looking at the roster, so it is one of
  // the entries in the picker below rather than a switch of its own next
  // to it. Two controls that both answered "what am I looking at" sat
  // side by side saying different halves of it.
  const onMap = groupBy === 'map';

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

  // Grouped on everybody, not on what the search left behind. A group
  // is a round, and a round's length and order are facts about the
  // business rather than about what is in the search box — see
  // CustomerGroup, which filters for display and keeps the positions
  // honest.
  const groups = groupCustomers(groupBy, customers, areas, labels);
  const matching = words.length === 0 ? null : new Set(visibleCustomers.map((customer) => customer.id));

  // The same three-tile summary the Business tab opens with. Only the
  // exceptions show: a roster where everyone is pinned and routed says
  // so by having nothing else to say. See Docs/DESIGN.md.
  const noPin = customers.filter((c) => !(c.lat || c.lng)).length;
  const paused = customers.filter((c) => c.active === false || isAway(c)).length;
  const offRoute = customers.filter((c) => c.active !== false && !serviceRouteFor(c, areas)).length;

  return (
    <ScrollView contentContainerStyle={pageStyle} onScroll={onScroll} scrollEventThrottle={16}>
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

      <SummaryRow>
        <SummaryTile label={labels.customer_plural} value={String(customers.length)} />
        {offRoute > 0 ? (
          <SummaryTile label={`Off a ${lower(labels.route)}`} value={String(offRoute)} tone="warning" />
        ) : null}
        {noPin > 0 ? <SummaryTile label="No pin" value={String(noPin)} tone="warning" /> : null}
        {paused > 0 ? <SummaryTile label="Paused" value={String(paused)} /> : null}
      </SummaryRow>

      <Card>
        <SectionTitle
          right={
            <>
              {/* Out here rather than behind the ⋯, even though it is
                  used once and never again. That once is the first hour
                  with the product, when the list is empty and nobody has
                  learned where anything is hidden yet. */}
              <Pressable
                onPress={() => setImporting(true)}
                accessibilityRole="button"
                accessibilityLabel={`Import a list of ${lower(labels.customer_plural)}`}
                style={({ pressed }) => [styles.importButton, pressed && styles.importPressed]}
              >
                <Text style={styles.importText}>Import</Text>
              </Pressable>
              <AddButton
                open={adding}
                onPress={() => setAdding((prev) => !prev)}
                label={adding ? `Cancel adding a ${lower(labels.customer)}` : `Add a ${lower(labels.customer)}`}
              />
            </>
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

        <ImportCustomersDialog
          open={importing}
          onClose={() => setImporting(false)}
          token={token}
          labels={labels}
          home={home}
          areas={areas}
          onImported={async () => {
            await refresh();
          }}
        />

        {/* One row, no field labels. A box you type in with a magnifier
            in it is a search box everywhere else somebody uses a phone,
            and a dropdown reading "By route" says what it is by saying
            what it is set to.

            Both stay out on the map. The picker is the way back, and
            searching narrows the pins — typing a name leaves one, and a
            map that fits its pins is then a map of that door. */}
        <View style={styles.toolsRow}>
          <View style={styles.searchBox}>
            <Text style={styles.searchGlyph}>⌕</Text>
            <input
              value={search}
              aria-label={`Search ${lower(labels.customer_plural)}`}
              placeholder="Name, phone, or address"
              onChange={(event) => setSearch(event.target.value)}
              style={searchInputStyle}
            />
            {search ? (
              <Pressable
                onPress={() => setSearch('')}
                accessibilityRole="button"
                accessibilityLabel="Clear the search"
                style={({ pressed }) => [styles.searchClear, pressed && styles.pressed]}
              >
                <Text style={styles.searchClearGlyph}>✕</Text>
              </Pressable>
            ) : null}
          </View>
          <select
            value={groupBy}
            aria-label="What to show"
            style={groupBySelectStyle}
            onChange={(event) => setGroupBy(event.target.value)}
          >
            <option value="city">By {lower(labels.route)}</option>
            <option value="all">Everyone</option>
            <option value="business">Shops only</option>
            <option value="early">Needs it early</option>
            <option value="unrouted">Not on a {lower(labels.route)}</option>
            <option value="nopin">Missing a pin</option>
            <option value="paused">Paused</option>
            <option value="map">On the map</option>
          </select>
        </View>

        {!onMap ? (
          <>
            {customers.length === 0 ? (
              <Empty>No {lower(labels.customer_plural)} yet.</Empty>
            ) : visibleCustomers.length === 0 ? (
              <Empty>
                No {lower(labels.customer_plural)} match &quot;{search.trim()}&quot;.
              </Empty>
            ) : (
              groups.map((group) => (
                <CustomerGroup
                  key={group.key}
                  name={group.name}
                  routed={groupBy === 'city' && group.key !== 'unassigned'}
                  empty={group.empty}
                  customers={group.customers}
                  matching={matching}
                  canDelete={canDelete}
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
            // What the search left, so typing a name leaves one pin and
            // the map — which fits itself to what it is given — becomes
            // a map of that door.
            customers={visibleCustomers}
            areas={areas}
            searching={words.length > 0}
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
// Borderless: the box around it is the search field's, and a second
// border inside the first reads as two controls.
const searchInputStyle = {
  flex: 1,
  minWidth: 0,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  paddingTop: spacing.sm,
  paddingBottom: spacing.sm,
  fontSize: 15,
  color: colors.text,
  fontFamily: 'inherit',
};

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

// The same picker inside the customer card, where the half-width cell
// it sits in decides how wide it is rather than the text in it. Two
// pickers side by side only look like a pair if they are the same width.
const cardSelectStyle = { ...groupBySelectStyle, width: '100%', minWidth: 0 };

// Sized for three digits, because a round of a thousand doors is not a
// round. Borderless so the pill still reads as one control rather than a
// form field wedged between two buttons — it is a number you can type
// on, and selecting itself on focus is what says so.
const positionInputStyle = {
  width: 26,
  border: 'none',
  background: 'transparent',
  fontSize: 12,
  fontWeight: '700',
  color: colors.subtitle,
  textAlign: 'center',
  fontFamily: 'inherit',
  padding: 0,
  outline: 'none',
  cursor: 'text',
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
function groupCustomers(groupBy, customers, areas, labels) {
  // The views that answer a question rather than sorting the whole
  // roster. Each is a filter with a heading that says what it is, so an
  // empty one reads as "none of these" rather than an empty screen.
  const only = (predicate, name, empty) => {
    const matched = customers.filter(predicate);
    return [{ key: groupBy, name, defaultExpanded: true, customers: matched, empty }];
  };

  switch (groupBy) {
    case 'all':
      return only(() => true, `Everyone (${customers.length})`, 'Nobody yet.');
    case 'business':
      return only(
        (c) => c.priority === 'business',
        'Shops and businesses',
        'Nobody is marked as a shop. Open a customer and set when they need it.',
      );
    case 'early':
      return only(
        (c) => c.priority === 'early',
        'Needs it early',
        'Nobody is marked as needing it early.',
      );
    case 'unrouted':
      return only(
        (c) => !serviceRouteFor(c, areas),
        `Not on a ${lower(labels.route)}`,
        `Everyone is on a ${lower(labels.route)}.`,
      );
    case 'nopin':
      return only((c) => !c.lat && !c.lng, 'Missing a pin', 'Everyone has a pin.');
    case 'paused':
      return only((c) => c.active === false || isAway(c), 'Paused', 'Nobody is paused.');
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
  empty,
  customers,
  // The ids the search left, or null when nothing is being searched for.
  // Only which rows are drawn depends on this; the round underneath them
  // does not.
  matching,
  canDelete,
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
  const touchOnly = useTouchOnly();
  // Whether the reorder controls are out. Off by default: reading the
  // list is constant, rearranging it is rare.
  const [arranging, setArranging] = useState(false);
  // Which customer is open. Held here rather than in the card because
  // the card's own wrapper has to become full width when it opens, and
  // a flex item cannot resize itself from the inside.
  const [openId, setOpenId] = useState(null);

  // The whole round, in order. Positions and moves are both computed
  // against this rather than against what happens to be on screen: a
  // search that matches one customer used to number them "1" and, worse,
  // send that single id as the entire new order — which set their rank
  // to 1 and moved them to the front of a round nobody meant to touch.
  const ordered = sortCustomers(customers);
  const shown = matching ? ordered.filter((customer) => matching.has(customer.id)) : ordered;
  // Nothing to order in the catch-all: these customers are on no round
  // at all, so "which order are they driven in" has no answer to give.
  // Offering the grip there was the app asking a question it could not
  // act on.
  const canReorder = routed;
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

  // A round the search matched nobody in is not an empty round; it is a
  // round with nothing to say right now.
  if (matching && shown.length === 0) {
    return null;
  }

  return (
    <View style={styles.group}>
      <Disclosure
        open={isExpanded}
        onToggle={() => setExpanded((prev) => !prev)}
        right={<Pill label={matching ? `${shown.length} of ${customers.length}` : String(customers.length)} tone="neutral" />}
      >
        {name}
      </Disclosure>
      {isExpanded && shown.length === 0 ? <Empty>{empty || 'Nothing here.'}</Empty> : null}
      {/* Reordering is something a business does when the round
          changes, not while reading it. One switch, rather than a
          hundred and fifty-six glyphs down the side of the list — see
          Docs/DESIGN.md. The switch is quiet until it is on, and then
          it says what it turned on and how to leave. */}
      {isExpanded && canReorder ? (
        <View style={styles.orderHintRow}>
          <Pressable
            onPress={() => setArranging((prev) => !prev)}
            accessibilityRole="button"
            accessibilityState={{ expanded: arranging }}
            style={({ pressed }) => [styles.arrangeToggle, arranging && styles.arrangeToggleOn, pressed && styles.pressed]}
          >
            <Text style={[styles.arrangeToggleText, arranging && styles.arrangeToggleTextOn]}>
              {arranging ? 'Done arranging' : 'Change the order'}
            </Text>
          </Pressable>
          {arranging ? (
            <>
              {/* Only now, when it is about to be acted on. HTML5
                  drag-and-drop does not exist under a thumb, so telling
                  a phone to drag a row is an instruction that cannot be
                  followed. */}
              <Text style={styles.orderHint}>
                {touchOnly ? 'Tap a number to move somebody, or use the arrows.' : 'Drag a row, or use the arrows.'}
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
            </>
          ) : null}
        </View>
      ) : null}
      <View style={arranging ? null : styles.tiles}>
      {isExpanded
        ? shown.map((customer) => {
            // Where this customer actually is in the round, not where
            // they are in what the search left on screen.
            const index = ordered.indexOf(customer);
            return (
            <SortableRow
              key={customer.id}
              style={arranging || openId === customer.id ? styles.rowFull : styles.rowTile}
              // Dragging needs somewhere to drop. With rows hidden by a
              // search the gaps between what is left are other people,
              // so a drag would mean nothing — the number and the arrows
              // still work, because those name a position rather than
              // pointing at one.
              draggable={canReorder && arranging && !matching && !touchOnly && !busy}
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
              canDelete={canDelete}
              expanded={openId === customer.id}
              onToggle={() => setOpenId((prev) => (prev === customer.id ? null : customer.id))}
              reorder={
                canReorder
                  ? {
                      position: index + 1,
                      total: ordered.length,
                      arranging,
                      showGrip: arranging && !touchOnly && !matching,
                      onUp: index > 0 ? () => moveTo(index, index - 1) : null,
                      onDown: index < ordered.length - 1 ? () => moveTo(index, index + 1) : null,
                      onJump: (to) => moveTo(index, to - 1),
                    }
                  : null
              }
              onChanged={onChanged}
              onError={onError}
            />
            </SortableRow>
            );
          })
        : null}
      </View>
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
function SortableRow({ children, style, draggable, isDragging, isOver, onDragStart, onDragEnter, onDragEnd, onDrop }) {
  if (!draggable) {
    return <View style={[styles.plainRow, style]}>{children}</View>;
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
        width: '100%',
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
function ReorderControls({ position, total, onUp, onDown, onJump, showGrip = true, arranging = true }) {
  // What is in the box while it is being typed. Null means "show the
  // position" — which is every moment except the one where somebody is
  // halfway through replacing 17 with 3 and would not thank us for
  // moving them to position 1 on the way past.
  const [typed, setTyped] = useState(null);
  // The same trick LocationPicker uses on its coordinate boxes: the blur
  // handler closes over state as it was when the input last rendered,
  // which a paste followed straight away by a blur can outrun.
  const typedRef = useRef(null);

  const commit = () => {
    const raw = typedRef.current;
    typedRef.current = null;
    setTyped(null);
    // Nothing typed is not a move to position zero. Without this, both
    // pressing Escape and simply touching the number and clicking away
    // sent the customer to the top of the round — Number(null) is 0, and
    // 0 clamps to 1.
    if (raw === null || String(raw).trim() === '' || !onJump) {
      return;
    }
    const wanted = Number(raw);
    if (!Number.isFinite(wanted)) {
      return;
    }
    // Clamped rather than refused: "put them at 40" in a round of 32
    // means last, and an error message about the length of the list is
    // an argument nobody wants to have with a text box.
    const target = Math.min(Math.max(Math.round(wanted), 1), total || 1);
    if (target !== position) {
      onJump(target);
    }
  };

  // Where somebody is in the round is a fact about them, so the number
  // stays on the card. The handles and arrows are tools, and tools live
  // in the hand you picked them up with — see Docs/DESIGN.md.
  if (!arranging) {
    return (
      <View style={styles.orderControlsQuiet}>
        <Text style={styles.positionQuiet}>{position}</Text>
      </View>
    );
  }

  return (
    <View style={styles.orderControls}>
      {/* The eight dots are the universal "you can pick this up", turned
          the way the strip runs. Decorative — everything it hints at is
          also on the two buttons, which is what keeps this usable
          without a mouse. Gone entirely where picking a row up is not
          possible: a handle that does nothing is worse than no handle,
          because somebody will spend a while trying to use it. */}
      {showGrip ? (
        <Text style={styles.grip} accessibilityElementsHidden importantForAccessibility="no">
          ⠿
        </Text>
      ) : null}
      {/* Typing the number beats pressing an arrow thirty times.
          Somewhere past about the fifth press the arrows stop being a
          way to move a customer and start being a way to lose count, and
          a round of thirty-two doors is well past that. The arrows stay
          for the one-place nudge, which is most of them. */}
      {onJump ? (
        <input
          value={typed === null ? String(position) : typed}
          inputMode="numeric"
          aria-label={`Position ${position} of ${total}. Type a number to move.`}
          onChange={(event) => {
            const next = event.target.value.replace(/[^0-9]/g, '');
            typedRef.current = next;
            setTyped(next);
          }}
          onFocus={(event) => event.target.select()}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              // Committed here rather than by asking the blur to do it.
              // Leaving on the blur made Enter depend on a second event
              // arriving, and commit clears what it consumed, so the
              // blur that follows is a no-op either way.
              commit();
              event.target.blur();
            } else if (event.key === 'Escape') {
              // Cleared before the blur, so the commit that follows has
              // nothing to act on and the row stays where it was.
              typedRef.current = null;
              setTyped(null);
              event.target.blur();
            }
          }}
          style={positionInputStyle}
        />
      ) : (
        <Text style={styles.position}>{position}</Text>
      )}
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
// Delivery order is not a display preference — it is what the driver
// will actually do, so it mirrors the backend exactly: tier first, then
// the admin's own rank, then name for anything still tied.
//
// There used to be an alphabetical mode beside it. Nothing about this
// roster is alphabetical: the number on the card is a position in a
// round, and a list sorted by name showed those numbers out of order
// while turning off the only thing that could fix them. Finding
// somebody is what the search box is for.
function sortCustomers(customers) {
  const list = [...customers];
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

// Pending is what every customer is every morning, so it is not news.
// Fifty-two identical badges cost fifty-two eye stops and spend the
// colour that should have been carrying "failed" — see Docs/DESIGN.md,
// and PriorityBadge, which has always done this for the default tier.
const worthShowing = (status) => !!status && status !== 'pending';

// The same question domain.Customer.AwayOn answers on the server: is this
// date inside the holiday. Kept in step with it deliberately — a roster
// that counts somebody as away while the day still generates their
// delivery is two answers to one question.
function todayLocal() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function isAway(customer, date = todayLocal()) {
  const from = customer.paused_from || '';
  const until = customer.paused_until || '';
  if (!from && !until) {
    return false;
  }
  if (from && date < from) {
    return false;
  }
  if (until && date > until) {
    return false;
  }
  return true;
}

function awayLabel(customer) {
  const say = (iso) => {
    const at = new Date(`${iso}T00:00:00`);
    return Number.isNaN(at.getTime()) ? iso : at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };
  const from = customer.paused_from || '';
  const until = customer.paused_until || '';
  if (from && until) {
    return `${say(from)} – ${say(until)}`;
  }
  return from ? `from ${say(from)}` : `until ${say(until)}`;
}

// Pausing, in the two shapes a dairy actually needs.
//
// "They have gone away until the 28th" is the common one, and it used to
// be a pause somebody had to remember to undo — which meant either an
// alarm in somebody's head or a household quietly getting no milk for a
// month after they came back. Given the dates, coming back needs nobody
// to do anything.
//
// The open-ended pause stays, because "stop, I will say when" is a real
// thing to mean, and it is the honest answer when nobody knows the date.
function AwayControls({ customer, labels, save }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(customer.paused_from || '');
  const [until, setUntil] = useState(customer.paused_until || '');

  if (!customer.active) {
    return (
      <View style={styles.buttonRow}>
        <Button
          title={`Resume ${lower(labels.customer)}`}
          variant="secondary"
          onPress={() => save({ active: true }, { active: false }, `${customer.name}: resumed`)}
          style={styles.flexButton}
        />
      </View>
    );
  }

  if (customer.paused_from || customer.paused_until) {
    return (
      <View style={styles.buttonRow}>
        <Text style={styles.awayNow}>Away {awayLabel(customer)}</Text>
        <Button
          title="Back now"
          variant="secondary"
          onPress={() =>
            save(
              { paused_from: '', paused_until: '' },
              { paused_from: customer.paused_from || '', paused_until: customer.paused_until || '' },
              `${customer.name}: back on the round`,
            )
          }
        />
      </View>
    );
  }

  return (
    <View>
      <View style={styles.buttonRow}>
        {/* Hidden while the dates are being filled in: "Pause" next to a
            half-typed holiday is two different instructions sitting side
            by side, and the one that stops milk indefinitely is the
            wrong one to press by accident. */}
        {open ? null : (
          <Button
            title={`Pause ${lower(labels.customer)}`}
            variant="secondary"
            onPress={() => save({ active: false }, { active: true }, `${customer.name}: paused`)}
            style={styles.flexButton}
          />
        )}
        <Button
          title={open ? 'Cancel' : 'Away for a while'}
          variant="secondary"
          onPress={() => {
            setFrom(customer.paused_from || '');
            setUntil(customer.paused_until || '');
            setOpen((prev) => !prev);
          }}
          style={styles.flexButton}
        />
      </View>
      {open ? (
        <View style={styles.awayForm}>
          {/* Raw date inputs, same reasoning as DateNav's: the browser's
              own picker is one every admin already knows, and it
              validates the format for free. Either end may be left
              empty — "away from Friday, no idea when they are back" is
              a real thing to mean. */}
          <View style={styles.awayFields}>
            <View>
              <Text style={styles.label}>First day away</Text>
              <input
                type="date"
                value={from}
                aria-label="First day away"
                onChange={(event) => setFrom(event.target.value)}
                style={awayDateStyle}
              />
            </View>
            <View>
              <Text style={styles.label}>Last day away</Text>
              <input
                type="date"
                value={until}
                min={from || undefined}
                aria-label="Last day away"
                onChange={(event) => setUntil(event.target.value)}
                style={awayDateStyle}
              />
            </View>
          </View>
          <Button
            title="Save"
            onPress={async () => {
              await save(
                { paused_from: from, paused_until: until },
                { paused_from: customer.paused_from || '', paused_until: customer.paused_until || '' },
                `${customer.name}: away`,
              );
              setOpen(false);
            }}
            disabled={!from && !until}
          />
          <Text style={styles.note}>Deliveries stop on those days and start again on their own.</Text>
        </View>
      ) : null}
    </View>
  );
}

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
  canDelete = false,
  expanded = false,
  onToggle,
  reorder = null,
  onChanged,
  onError,
}) {
  const narrow = useNarrow();
  const [customFields, setCustomFields] = useState(customer.custom_fields || {});
  const [details, setDetails] = useState({
    name: customer.name,
    phone: customer.phone,
    address: customer.address,
    priority: customer.priority || 'normal',
  });
  const [busy, setBusy] = useState(false);
  const [editingContact, setEditingContact] = useState(false);
  const [editingPin, setEditingPin] = useState(false);

  const hasPin = !!(customer.lat || customer.lng);

  // The standing order in one line. Shown under the name while
  // collapsed, and as the order section's own heading once open —
  // once in each state, never twice at the same time.
  // Every day is what almost every standing order is, so saying it is
  // three words that carry nothing — and on a hundred-customer roster it
  // is three hundred. The days show when they are the exception, which
  // is the only time anybody needs to read them. See Docs/DESIGN.md.
  const orderSummary =
    subscriptions.length === 0
      ? 'No standing order yet'
      : subscriptions
          .map((sub) => {
            const days = daysFromMask(sub.weekday_mask);
            const what = `${sub.quantity} × ${productName(products, sub.product_id)}`;
            return days.length === 7 ? what : `${what} · ${describeDays(days)}`;
          })
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

  // A box when shut, the whole row when open or while the round is being
  // arranged.
  //
  // A grid is right for reading a roster and wrong for ordering one: a
  // sequence that runs left to right and wraps is a sequence nobody can
  // follow. So the layout follows the mode — boxes to browse, a single
  // column to arrange, which is the same switch the arrows already live
  // behind. See Docs/DESIGN.md.
  return (
    <Card style={styles.customerTile}>
      <Disclosure
        open={expanded}
        onToggle={onToggle}
        middle={reorder ? <ReorderControls {...reorder} /> : null}
        right={
          <View style={[styles.pills, !narrow && styles.pillsAligned]}>
            <PriorityBadge value={customer.priority} />
            {worthShowing(today?.status) ? (
              <Pill label={today.status} tone={STATUS_TONE[today.status] || 'neutral'} />
            ) : null}
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

          {/* Read, with a pencil — not three boxes and a Save.
              A customer's name, number and address are set once and
              almost never touched, so an always-open form asked every
              visitor of every card to look at editing controls for
              something they came to read. And a "Save contact details"
              button under a form nobody had typed in is a button with
              nothing to do.
              No heading either: this is a card about a person, their
              name is already its title, and "Contact details" over their
              own phone number is a label on the obvious. */}
          <View style={styles.readBlock}>
            <View style={styles.readRow}>
              <View style={styles.readRowText}>
                <Text style={styles.readSub}>
                  {[customer.phone, customer.address].filter(Boolean).join(' · ') || 'No phone or address yet'}
                </Text>
              </View>
              <Pressable
                onPress={() => setEditingContact((prev) => !prev)}
                accessibilityRole="button"
                accessibilityLabel={`Edit ${customer.name}'s name, phone and address`}
                style={styles.pencilTarget}
              >
                <Text style={styles.pencil}>{editingContact ? '×' : '✎'}</Text>
              </Pressable>
            </View>

            {editingContact ? (
              <View style={styles.editBlock}>
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
                <View style={styles.buttonRow}>
                  <Button
                    title="Save"
                    busy={busy}
                    disabled={!details.name.trim()}
                    onPress={async () => {
                      await saveDetails();
                      setEditingContact(false);
                    }}
                    style={styles.flexButton}
                  />
                  <Button
                    title="Cancel"
                    variant="secondary"
                    onPress={() => {
                      setDetails({
                        name: customer.name,
                        phone: customer.phone,
                        address: customer.address,
                        priority: customer.priority || 'normal',
                      });
                      setEditingContact(false);
                    }}
                    style={styles.flexButton}
                  />
                </View>
              </View>
            ) : null}
          </View>
          {/* Two short answers about the same customer, so they share a
              line rather than taking a card's width each. They wrap back
              into a column when the card is too narrow to hold both. */}
          <View style={styles.pickerRow}>
            {/* Not only on the add form: which customers open early is
                something a business learns after they have been signed
                up, and the ones who most need marking are the hundred
                already on the list. Saved with the contact details,
                because it is a fact about the customer rather than about
                today. */}
            <PriorityPicker
              style={styles.pickerCell}
              value={customer.priority || 'normal'}
              onChange={(value) =>
                save({ priority: value }, { priority: customer.priority || 'normal' }, `${customer.name}: priority changed`)
              }
            />
            {/* Which round they are on. "From their pin" is the default
                and stays the answer for almost everybody — this exists
                for the cases geography cannot express, like a house on
                the evening round in the middle of the morning one. Saved
                on its own rather than with the contact details, because
                moving somebody to another round moves today's delivery
                with them and that deserves to be its own deliberate
                act. */}
            {areas.length > 0 ? (
              <View style={[styles.routePicker, styles.pickerCell]}>
                <Text style={styles.pickerLabel}>Which {lower(labels.route)}?</Text>
                <select
                  value={customer.service_area_id || ''}
                  style={cardSelectStyle}
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
                <Text style={styles.routeNote}>
                  {customer.service_area_id
                    ? `On this ${lower(labels.route)} because you put them here, whatever their pin says.`
                    : `Their pin decides, which is right unless two ${lower(labels.route)}s cover the same streets.`}
                </Text>
              </View>
            ) : null}
          </View>
          {/* The map is the tallest thing in this card by a long way,
              and on most visits nobody is moving anybody's door. It
              opens on the pencil, like the business's own location on
              the account screen. */}
          <View style={styles.readBlock}>
            <View style={styles.readRow}>
              <View style={styles.readRowText}>
                <Text style={styles.readLabel}>Where we deliver</Text>
                <Text style={[styles.readValue, !hasPin && styles.readValueMissing]}>
                  {hasPin ? 'Pinned on the map' : 'No pin yet'}
                </Text>
                {!hasPin ? (
                  <Text style={styles.readSub}>Without one they cannot be put in order on a {lower(labels.route)}.</Text>
                ) : null}
              </View>
              <Pressable
                onPress={() => setEditingPin((prev) => !prev)}
                accessibilityRole="button"
                accessibilityLabel={`${hasPin ? 'Move' : 'Set'} ${customer.name}'s pin`}
                style={styles.pencilTarget}
              >
                <Text style={styles.pencil}>{editingPin ? '×' : '✎'}</Text>
              </Pressable>
            </View>

            {editingPin ? (
              <LocationPicker
                label="Where do we deliver?"
                lat={customer.lat}
                lng={customer.lng}
                onChange={savePin}
                home={home}
                areas={areas}
                // Their own round if they are on one, otherwise every
                // round the business runs — so a customer with no pin
                // opens on the town they are delivered in rather than on
                // the depot or the country.
                focusAreas={
                  customer.service_area_id ? areas.filter((a) => a.id === customer.service_area_id) : areas
                }
              />
            ) : null}
          </View>
          <AwayControls customer={customer} labels={labels} save={save} />

          {/* Pausing keeps the customer and stops the deliveries, which
              is what "they've gone away for a month" means. Deleting is
              for a row that should never have existed — and it takes
              their whole history, so the confirmation says how much,
              counted by the server at the moment it is read. */}
          <DeleteButton
            armed={canDelete}
            label={`Delete ${customer.name}`}
            describe={async () => {
              const it = await api.customerDeletePreview(token, customer.id);
              const parts = [];
              if (it.standing_orders > 0) {
                parts.push(`${it.standing_orders} standing order${it.standing_orders === 1 ? '' : 's'}`);
              }
              if (it.deliveries > 0) {
                parts.push(`${it.deliveries} deliver${it.deliveries === 1 ? 'y' : 'ies'}`);
              }
              return parts.length === 0
                ? `Delete ${customer.name}? Nothing else goes with them.`
                : `Deleting ${customer.name} also removes ${parts.join(' and ')}${
                    it.delivered > 0 ? `, ${it.delivered} of which already happened` : ''
                  }. This cannot be undone.`;
            }}
            onDelete={() => api.deleteCustomer(token, customer.id)}
            onDone={onChanged}
            onError={onError}
          />

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
          {/* Under the standing order, because it is the exceptions to
              it: what has been booked on top, and what has actually been
              delivered. Both only make sense once you know what "normal"
              is for this customer, and normal is the line above. */}
          <CustomerTimeline
            token={token}
            customer={customer}
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
  // Each product keeps its own days, which is how they are stored. The
  // form used to ask once and apply the answer to everything, so a
  // customer on milk daily and curd on alternate days showed "every day"
  // for both — and any edit that touched curd's quantity wrote that back,
  // quietly moving them onto seven deliveries a week of something they
  // wanted three of.
  const seedDays = () =>
    Object.fromEntries(Object.entries(existing).map(([productId, sub]) => [productId, daysFromMask(sub.weekday_mask)]));
  const [dayMasks, setDayMasks] = useState(seedDays);
  // Defaults to the business's own today (server-resolved, see
  // domain.Business.Today) rather than the device's — an admin on a
  // laptop in another zone must not silently book tomorrow.
  const [date, setDate] = useState(todayDate || '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Re-seed once a save has landed and the refreshed standing orders come
  // back, so reopening the form shows what the customer now takes rather
  // than the draft that produced it. Only while collapsed — never yank
  // the numbers out from under someone mid-edit.
  useEffect(() => {
    if (!expanded) {
      setQuantities(Object.fromEntries(Object.entries(existing).map(([id, sub]) => [id, sub.quantity])));
      setDayMasks(seedDays());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        days: dayMasks,
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
        <Empty>Add a {lower(labels.product)} under Manage business before placing an order.</Empty>
      </View>
    );
  }

  // Every chosen product needs a day of its own now, so one product left
  // on an empty week blocks the save rather than saving as "never".
  const ready =
    chosen.length > 0 &&
    (kind === 'once' ? !!date : chosen.every((item) => (dayMasks[item.product_id] || EVERY_DAY).length > 0));
  const hasStandingOrder = Object.keys(existing).length > 0;

  return (
    <View style={styles.subForm}>
      {/* Named for what it does. The form has been pre-filled from the
          customer's live standing orders for a while — bumping a product
          they already take replaces that arrangement rather than
          stacking a second one beside it — but the label still said
          "Add an order", so the only way to find out it was an editor
          was to open it and recognise your own numbers. */}
      <Disclosure open={expanded} onToggle={() => setExpanded((prev) => !prev)}>
        {hasStandingOrder ? 'Change what they take' : 'Add an order'}
      </Disclosure>

      {expanded ? (
        <View>
          {hasStandingOrder && kind === 'weekly' ? (
            <Text style={styles.note}>Set one to zero to stop it.</Text>
          ) : null}
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
            days={kind === 'weekly' ? dayMasks : undefined}
            onDaysChange={setDayMasks}
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
              <Text style={styles.note}>That day only — their standing order is untouched.</Text>
            </View>
          ) : null}

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

// The same input the one-off order uses, narrower because two of them sit
// side by side inside a customer's card.
const awayDateStyle = { ...dateInputStyle, width: 150, marginBottom: 0 };

function productName(products, id) {
  return products.find((product) => product.id === id)?.name || 'item';
}

const styles = StyleSheet.create({
  loader: { marginTop: spacing.xl * 2 },
  group: { marginBottom: spacing.md },
  // Boxes to browse, a single column to arrange — a sequence that runs
  // left to right and wraps is a sequence nobody can follow.
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  rowTile: { flexGrow: 1, flexBasis: 280, minWidth: 0 },
  rowFull: { flexBasis: '100%', width: '100%' },
  // Fills its wrapper, so tiles in a row share a bottom edge rather
  // than each ending wherever its own address happens to stop.
  customerTile: { height: '100%' },
  headingActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  importButton: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
  },
  importPressed: { opacity: 0.6 },
  importText: { fontSize: 13, fontWeight: '700', color: colors.link },
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
  toolsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  // The search box takes the slack and the two pickers keep their own
  // width, so on a phone the box is a line of its own and the pickers
  // sit under it as a pair.
  searchBox: {
    flexGrow: 1,
    flexBasis: 220,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.sm,
  },
  searchGlyph: { fontSize: 18, color: colors.hint, marginRight: 2 },
  searchClear: { paddingHorizontal: spacing.xs, paddingVertical: 2 },
  searchClearGlyph: { fontSize: 13, fontWeight: '700', color: colors.subtitle },
  plainRow: { width: '100%' },
  routePicker: { marginBottom: spacing.sm },
  // Priority and route share a line. Each takes half, and 210 is about
  // where "Shop or business" stops fitting — below that they wrap into
  // a column instead of squeezing into two unreadable columns.
  pickerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginBottom: spacing.sm },
  pickerCell: { flex: 1, minWidth: 210 },
  // The lighter of the two hint styles, so the sentence under the route
  // sits on the same line as the one under priority.
  routeNote: { fontSize: 12, color: colors.hint, marginTop: 3, lineHeight: 16 },
  // The shared label style leads with a top margin, which is right when
  // fields are stacked and wrong when two of them start on the same
  // line: it drops this one below its neighbour by exactly that margin.
  pickerLabel: { fontSize: 13, fontWeight: '600', color: colors.label, marginBottom: 3 },
  readBlock: { marginBottom: spacing.md },
  readRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  readRowText: { flex: 1 },
  readLabel: { fontSize: 12, fontWeight: '600', color: colors.hint, textTransform: 'uppercase', letterSpacing: 0.04 },
  readValue: { fontSize: 16, fontWeight: '700', color: colors.text, marginTop: 2 },
  readValueMissing: { color: colors.warning },
  readSub: { fontSize: 14, color: colors.subtitle, lineHeight: 20 },
  pencilTarget: { minWidth: 44, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' },
  pencil: { fontSize: 16, color: colors.link },
  editBlock: { marginTop: spacing.sm },
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
  // Resting state: the position, and nothing else. No border, no
  // background — it is a number on a card, not a control.
  orderControlsQuiet: { alignSelf: 'center', paddingHorizontal: spacing.xs },
  positionQuiet: { fontSize: 13, fontWeight: '700', color: colors.hint, minWidth: 18, textAlign: 'center' },
  pressed: { opacity: 0.6 },
  arrangeToggle: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
  },
  arrangeToggleOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  arrangeToggleText: { fontSize: 13, fontWeight: '700', color: colors.link },
  arrangeToggleTextOn: { color: colors.accentText },
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
  },
  // Only where there is room to spend on tidiness. On a phone those 148
  // pixels are half the row, and they were being taken out of the
  // customer's name.
  pillsAligned: { minWidth: 148 },
  subsHeading: { fontSize: 13, color: colors.label, marginTop: spacing.sm },
  orderSummaryBlock: { marginTop: spacing.lg },
  expanded: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  awayNow: { flex: 1, fontSize: 13, fontWeight: '600', color: colors.subtitle, alignSelf: 'center' },
  awayForm: { marginTop: spacing.sm },
  awayFields: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
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
