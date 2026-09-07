import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from '../api';
import { AddButton, Banner, Button, Card, Disclosure, Empty, Field, FieldRow, Pill, SectionTitle } from '../components';
import LocationPicker, { InlineLocationEditor } from '../LocationPicker';
import AddCustomerDialog from '../AddCustomerDialog';
import DeleteButton from '../DeleteButton';
import DriversSection from './DriversSection';
import ImportCustomersDialog from '../ImportCustomersDialog';
import { customFieldsFor, labelsFor, lower } from '../labels';
import { groupProducts } from '../productGroups';
import { serviceRouteFor } from '../serviceAreas';
import { useDeleteMode } from '../deleteMode';
import { usePageStyle } from '../layout';
import { colors, radius, spacing } from '../theme';

// The business's own settings: its name, where it's based, and the
// localities it delivers to. Every map elsewhere in the app (Customers,
// Today's route start point) scopes its default view to what's set up
// here, instead of opening on an India-wide view — see MapPicker.web.js's
// home/areas props.
export default function BusinessScreen({ token, business, user, currentUserId, onBusinessUpdated }) {
  const pageStyle = usePageStyle(720);
  const { open: canDelete } = useDeleteMode(user);
  // "Service route" borrows the business's own word for a round, so a
  // school reads "Service runs" — see labels.js. The daily thing a
  // driver drives is a route; a service route is the standing list that
  // produces one every day.
  const labels = labelsFor(business);
  const [areas, setAreas] = useState([]);
  const [products, setProducts] = useState([]);
  const [demand, setDemand] = useState({});
  const [drivers, setDrivers] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Owned here rather than inside the form itself, so the "+" sits at the
  // heading — next to the count it's adding to — instead of repeating the
  // section's own title as a second row underneath.
  const [addingArea, setAddingArea] = useState(false);
  // Customers a newly created route passed over, waiting on a yes/no.
  const [kept, setKept] = useState(null);
  // The service route the add-a-customer dialog was opened from, or
  // null when it isn't open. See AddCustomerDialog.
  const [addingTo, setAddingTo] = useState(null);
  // The service route the import dialog was opened from, so the file
  // lands on that round rather than being sorted by pin.
  const [importingTo, setImportingTo] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [prefill, setPrefill] = useState(null);

  const refresh = useCallback(async () => {
    try {
      // Drivers and customers are loaded here purely so the maps on this
      // screen can show every location the business has in one picture —
      // see MapPicker's drivers/customers props.
      const [areaResponse, productResponse, demandResponse, driverResponse, customerResponse] = await Promise.all([
        api.listServiceAreas(token),
        api.listProducts(token),
        api.getProductDemand(token),
        api.listDrivers(token),
        api.listCustomers(token),
      ]);
      setAreas(areaResponse.service_areas || []);
      setProducts(productResponse.products || []);
      setDemand(demandResponse.needed || {});
      setDrivers(driverResponse.drivers || []);
      setCustomers(customerResponse.customers || []);
      setError('');
      // Best-effort: a business that can't be offered a suggestion is
      // not a business that should see an error on its settings page.
      try {
        const suggested = await api.suggestServiceAreas(token);
        setSuggestions(suggested.suggestions || []);
      } catch {
        setSuggestions([]);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const home = business.home_lat || business.home_lng ? { lat: business.home_lat, lng: business.home_lng } : null;

  if (loading) {
    return <ActivityIndicator style={styles.loader} color={colors.accent} />;
  }

  // The three things an owner comes here to check. Not a dashboard —
  // Today owns the day — but "is anything short" is the one setup
  // question with a deadline on it, and it was previously only findable
  // by opening each product in turn.
  const groups = groupProducts(products);
  const shortToday = products.reduce((total, product) => {
    const needed = demand[product.id] || 0;
    const have = Number(product.stock_quantity) || 0;
    return total + Math.max(0, needed - have);
  }, 0);

  return (
    <ScrollView contentContainerStyle={pageStyle}>
      <Banner message={error} />
      <Banner message={notice} tone="success" />

      <View style={styles.summary}>
        <SummaryTile
          label="Sells"
          value={String(groups.length)}
          note={products.length > groups.length ? `in ${products.length} sizes` : ''}
        />
        <SummaryTile label={labels.customer_plural} value={String(customers.length)} />
        {/* Only when there is a shortfall. Zero short is the ordinary
            morning, and a tile reading 0 every day is a tile nobody
            reads on the day it says 40. */}
        {shortToday > 0 ? <SummaryTile label="Short today" value={formatQuantity(shortToday)} tone="warning" /> : null}
      </View>

      <ProductCatalogCard
        token={token}
        products={products}
        demand={demand}
        onChanged={refresh}
        onCreated={async (name) => {
          setNotice(`Added ${name} to your products.`);
          await refresh();
        }}
        onError={setError}
      />

      <AddCustomerDialog
        open={!!addingTo}
        onClose={() => setAddingTo(null)}
        token={token}
        labels={labels}
        fieldSpecs={customFieldsFor(business, 'customer')}
        home={home}
        areas={areas}
        products={products}
        serviceArea={addingTo}
        onCreated={async (name) => {
          setNotice(`Added ${name} to ${addingTo.name}.`);
          setAddingTo(null);
          await refresh();
        }}
        onError={setError}
      />

      <ImportCustomersDialog
        open={!!importingTo}
        onClose={() => setImportingTo(null)}
        token={token}
        labels={labels}
        home={home}
        areas={areas}
        serviceAreaId={importingTo?.id || ''}
        onImported={async () => {
          await refresh();
        }}
      />

      <Card>
        <SectionTitle
          after={
            <AddButton
              open={addingArea}
              onPress={() => {
                setPrefill(null);
                setAddingArea((prev) => !prev);
              }}
              label={addingArea ? 'Close add a service route' : 'Add a service route'}
            />
          }
        >
          Service {lower(labels.route)}s ({areas.length})
        </SectionTitle>
        <View style={styles.headingDivider} />

        {!addingArea && suggestions.length > 0 ? (
          <SuggestedAreas
            suggestions={suggestions}
            onAccept={(suggestion) => {
              setPrefill(suggestion);
              setAddingArea(true);
            }}
          />
        ) : null}

        {addingArea ? (
          <NewServiceAreaForm
            token={token}
            home={home}
            areas={areas}
            drivers={drivers}
            customers={customers}
            initial={prefill}
            labels={labels}
            key={prefill ? `${prefill.lat},${prefill.lng}` : 'blank'}
            onCreated={async (name, area) => {
              setNotice(`Added ${name}.`);
              setAddingArea(false);
              setPrefill(null);
              // Who the new route deliberately did not take. Offered
              // rather than done, because "I drew a circle" is not the
              // same as "move these people" — see
              // keepCustomersWhereTheyAre.
              setKept(area?.kept?.length ? { area, customers: area.kept } : null);
              await refresh();
            }}
            onError={setError}
          />
        ) : null}

        {kept ? (
          <KeptCustomersNotice
            token={token}
            kept={kept}
            labels={labels}
            onDismiss={() => setKept(null)}
            onMoved={async (count) => {
              setNotice(
                `Moved ${count} ${count === 1 ? lower(labels.customer) : lower(labels.customer_plural)} to ${kept.area.name}.`,
              );
              setKept(null);
              await refresh();
            }}
            onError={setError}
          />
        ) : null}

        {areas.length === 0 ? (
          <Empty>
            Nothing set up yet. A route is prepared for each place you deliver to, so this is the one thing worth
            setting up first.
          </Empty>
        ) : (
          <View style={styles.tiles}>
          {areas.map((area) => (
            <ServiceAreaRow
              key={area.id}
              area={area}
              home={home}
              token={token}
              labels={labels}
              customerCount={customers.filter((c) => serviceRouteFor(c, areas)?.id === area.id).length}
              onAddCustomer={setAddingTo}
              onImportInto={setImportingTo}
              canDelete={canDelete}
              onChanged={refresh}
              onError={setError}
            />
          ))}
          </View>
        )}
      </Card>

      {/* Who drives it, after what there is to drive. This was its own
          tab; a dairy opens Today and Customers every morning and comes
          here to set things up, so setup is one page. See
          Docs/DESIGN.md. */}
      <DriversSection
        token={token}
        business={business}
        user={user}
        currentUserId={currentUserId}
      />

    </ScrollView>
  );
}

// What tapping a customer or driver on the business's own map opens. This
// is the one map in the app where every kind of pin is manageable, so
// unlike the muted, read-only markers everywhere else, this one edits the
// actual record — same InlineLocationEditor the route map uses for a
// stop's pin, wired to whichever entity was tapped.
function SelectedEntityEditor({ token, selected, home, onClose, onChanged, onError }) {
  const { kind, data } = selected;

  const save = async (lat, lng) => {
    try {
      if (kind === 'customer') {
        await api.updateCustomer(token, data.id, { lat, lng });
      } else {
        await api.setDriverHome(token, data.id, lat, lng);
      }
      await onChanged();
    } catch (err) {
      onError(err.message);
    }
  };

  return (
    <View style={styles.cardSection}>
      <View style={styles.editHeader}>
        <Text style={styles.readLabel}>{kind === 'customer' ? data.name : `${data.name} finishes at`}</Text>
        <Pressable onPress={onClose} accessibilityRole="button">
          <Text style={styles.doneLink}>Done</Text>
        </Pressable>
      </View>
      {kind === 'customer' ? (
        <Text style={styles.note}>{[data.address, data.phone].filter(Boolean).join(' · ') || 'No contact details yet'}</Text>
      ) : (
        <Text style={styles.note}>{data.phone || 'No phone on file'}</Text>
      )}
      <InlineLocationEditor
        lat={kind === 'customer' ? data.lat : data.home_lat}
        lng={kind === 'customer' ? data.lng : data.home_lng}
        onSave={save}
        home={home}
      />
    </View>
  );
}

// Collapsed by default, same expand-on-tap shape as NewCustomerCard's
// "Add a customer" — this is a create-a-new-record flow (unlike the two
// cards above, which edit the one business record that already exists),
// so buffer-then-submit is the right pattern here, not autosave.
// Controlled from the parent's "+" at the heading (see BusinessScreen)
// rather than owning its own expand toggle — the trigger lives next to
// the count it's adding to, not as a second title repeated underneath.
// What a new service route did *not* do, and the offer to do it.
//
// Routes claim customers by pin, and a second circle over a town you
// already deliver to would otherwise take whichever ones sit closer to
// the new middle — off a round the owner had already settled. That is
// never what drawing a circle meant, so it does not happen; this says so
// and offers the other answer in one tap.
//
// Named, not counted: "3 customers stayed on Nalgonda" is a number to go
// and verify, while the names are the answer itself.
function KeptCustomersNotice({ token, kept, labels, onDismiss, onMoved, onError }) {
  const [busy, setBusy] = useState(false);
  const names = kept.customers.map((entry) => entry.customer_name);
  const from = kept.customers[0]?.route_name;
  const sameRoute = kept.customers.every((entry) => entry.route_name === from);

  const move = async () => {
    setBusy(true);
    try {
      await api.addCustomersToServiceArea(
        token,
        kept.area.id,
        kept.customers.map((entry) => entry.customer_id),
      );
      await onMoved(kept.customers.length);
    } catch (err) {
      onError(err.message);
      setBusy(false);
    }
  };

  return (
    <View style={styles.keptBox}>
      <Text style={styles.keptTitle}>
        {names.length} {names.length === 1 ? lower(labels.customer) : lower(labels.customer_plural)} stayed
        {sameRoute && from ? ` on ${from}` : ' where they were'}
      </Text>
      <Text style={styles.keptBody}>
        {names.join(', ')} {names.length === 1 ? 'sits' : 'sit'} inside {kept.area.name} too. They were left on the{' '}
        {lower(labels.route)} they were already on, so nothing you had settled has changed.
      </Text>
      <View style={styles.keptButtons}>
        <Button
          title={`Move ${names.length === 1 ? 'them' : 'them all'} to ${kept.area.name}`}
          variant="secondary"
          busy={busy}
          onPress={move}
          style={styles.keptButton}
        />
        <Button title="Leave them" variant="secondary" onPress={onDismiss} style={styles.keptButton} />
      </View>
    </View>
  );
}

function NewServiceAreaForm({ token, home, areas, drivers, customers, initial, labels, onCreated, onError }) {
  const [name, setName] = useState(initial?.name || '');
  const [lat, setLat] = useState(initial ? String(initial.lat) : '');
  const [lng, setLng] = useState(initial ? String(initial.lng) : '');
  const [radiusMeters, setRadiusMeters] = useState(initial?.radius_meters || 3000);
  const [busy, setBusy] = useState(false);

  const setPin = (newLat, newLng) => {
    setLat(newLat.toFixed(6));
    setLng(newLng.toFixed(6));
  };

  // How many of this business's own customers the circle currently takes
  // in. This is the number that replaces "radius in km" as the thing an
  // admin steers by — "covers 42 of your 47" is a sentence a dairy owner
  // can act on; 3.4 km is not. Mirrors coveredCount in the backend.
  const pinned = (customers || []).filter((customer) => customer.lat || customer.lng);
  const inCircle =
    Number(lat) && Number(lng)
      ? pinned.filter((customer) => metersBetween(Number(lat), Number(lng), customer.lat, customer.lng) <= radiusMeters)
      : [];
  // Inside the circle is not the same as "this route will take them".
  // Anyone already on a route stays on it — see keepCustomersWhereTheyAre
  // — so the headline counts the ones this route would actually pick up
  // and the rest are named as staying put. Promising 42 and delivering 8
  // is the kind of surprise this whole change exists to stop.
  const settled = inCircle.filter((customer) => serviceRouteFor(customer, areas));
  const covered = inCircle.length - settled.length;

  const submit = async () => {
    setBusy(true);
    try {
      const area = await api.createServiceArea(token, {
        name,
        lat: Number(lat) || 0,
        lng: Number(lng) || 0,
        radius_meters: radiusMeters,
      });
      const created = name;
      setName('');
      setLat('');
      setLng('');
      setRadiusMeters(3000);
      await onCreated(created, area);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.inlineForm}>
      <Field label="Name" size="md" value={name} onChangeText={setName} placeholder="Jayanagar" />
      <LocationPicker
        label="Centre of the area"
        lat={Number(lat) || 0}
        lng={Number(lng) || 0}
        onChange={setPin}
        home={home}
        areas={areas}
        drivers={drivers}
        customers={customers}
        previewRadiusMeters={radiusMeters}
        height={320}
      />

      {/* A slider, not a kilometre field. Nobody knows their delivery
          radius in kilometres, but everybody knows whether a circle has
          their customers in it — so the readout is people, not distance,
          and the number of kilometres is shown only as a footnote. */}
      <Text style={styles.label}>How far out do you go?</Text>
      <input
        type="range"
        min={500}
        max={25000}
        step={500}
        value={radiusMeters}
        onChange={(event) => setRadiusMeters(Number(event.target.value))}
        style={radiusSliderStyle}
        aria-label="How far this area reaches"
      />
      <Text style={styles.coverage}>
        {Number(lat) && Number(lng)
          ? `Takes ${covered} of your ${pinned.length} pinned ${pinned.length === 1 ? 'customer' : 'customers'}`
          : 'Drop the pin above to see who this covers'}
      </Text>
      <Text style={styles.note}>
        {(radiusMeters / 1000).toFixed(1)} km across the map.
        {settled.length > 0
          ? ` ${settled.length} more ${settled.length === 1 ? 'sits' : 'sit'} inside it but ${
              settled.length === 1 ? 'is' : 'are'
            } already on another ${lower(labels.route)} — they stay there, and you can move them afterwards.`
          : ''}
      </Text>

      <Button title="Add service route" onPress={submit} busy={busy} disabled={!name.trim() || !lat || !lng} />
    </View>
  );
}

// Haversine, same as the backend's route.DistanceMeters — the coverage
// count shown while dragging the slider has to agree with the one the
// server will compute, or the circle an admin accepted covers a different
// set of people than the one they were shown.
function metersBetween(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Matches Field's input styling — a raw <input> can't take
// StyleSheet.create output. Full width because a slider is a distance
// control and needs the travel.
const radiusSliderStyle = {
  width: '100%',
  marginTop: 4,
  marginBottom: 4,
  accentColor: colors.accent,
};

// What the business sells — moved here from the Drivers screen, which
// was never really the right home for it. A dairy that only sells milk
// today can see at a glance what it would take to also sell paneer,
// curd, ghee later: this is that list. "Products" (not "What you
// deliver" — that read like a delivery-logistics label when it's really
// just the catalog) with the add form collapsed behind "+ Add", same as
// every other creation form in this app: a new product is a real
// business decision (new pricing, new packaging, maybe a new supplier),
// not something added on a whim mid-visit, so it shouldn't be sitting
// open by default competing with the list above it.
//
// Add-only for now: Store only has CreateProduct/ListProducts (see
// storage/store.go), no update or deactivate path yet — that's a
// backend addition to make when editing an existing product is actually
// needed, not something to fake client-side.
function ProductCatalogCard({ token, products, demand, onChanged, onCreated, onError }) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState('');
  const [unit, setUnit] = useState('');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const priceRupees = Number(price);
      await api.createProduct(token, {
        name,
        unit,
        price_cents: Number.isFinite(priceRupees) && priceRupees > 0 ? Math.round(priceRupees * 100) : 0,
      });
      const created = name;
      setName('');
      setUnit('');
      setPrice('');
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
      <SectionTitle
        after={
          <AddButton
            open={expanded}
            onPress={() => setExpanded((prev) => !prev)}
            label={expanded ? 'Close add a product' : 'Add a product'}
          />
        }
      >
        Products ({products.length})
      </SectionTitle>
      <View style={styles.headingDivider} />

      {expanded ? (
        <View style={styles.inlineForm}>
          <Field label="Name" size="md" value={name} onChangeText={setName} placeholder="Paneer 200g" />
          <FieldRow>
            <Field label="Unit" size="sm" value={unit} onChangeText={setUnit} placeholder="packet / can / trip" />
            <Field label="Price ₹" size="xs" value={price} onChangeText={setPrice} keyboardType="numeric" placeholder="60" />
          </FieldRow>
          <Button title="Add product" onPress={submit} busy={busy} disabled={!name.trim()} />
        </View>
      ) : null}

      {products.length === 0 ? (
        <Empty>Nothing yet — add your first product above.</Empty>
      ) : (
        groupProducts(products).map((group) => (
          <ProductGroup
            key={group.key}
            group={group}
            demand={demand}
            token={token}
            onChanged={onChanged}
            onError={onError}
          />
        ))
      )}
    </Card>
  );
}

// One number that is worth seeing without opening anything.
function SummaryTile({ label, value, note, tone }) {
  return (
    <View style={[styles.summaryTile, tone === 'warning' && styles.summaryTileWarn]}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <View style={styles.summaryValueRow}>
        <Text style={[styles.summaryValue, tone === 'warning' && styles.summaryValueWarn]}>{value}</Text>
        {note ? <Text style={styles.summaryNote}>{note}</Text> : null}
      </View>
    </View>
  );
}

// One thing the business sells, and the sizes it sells it in.
//
// A dairy's five milk products are one product in five sizes, and the
// names already say so — see productGroups.js. Drawn as a heading and a
// column, prices and stock line up under each other, which is what makes
// ₹30 against ₹60 a glance rather than two scrolls.
//
// A product with one size gets no heading. A heading above a single row
// is a heading about nothing.
function ProductGroup({ group, demand, token, onChanged, onError }) {
  // One size is not a group. A heading, a count of "1 size" and four
  // column labels over a single row is more chrome than content — it
  // reads as its own name, the way it always did.
  const lone = group.items.length === 1;
  return (
    <View style={styles.productGroup}>
      {lone ? null : (
        <View>
          <View style={styles.productGroupHead}>
            <Text style={styles.productGroupName}>{group.name}</Text>
            <Text style={styles.productGroupCount}>
              {group.items.length} {group.items.length === 1 ? 'size' : 'sizes'}
            </Text>
          </View>
          {/* Three bare numbers in a row need saying once what they are.
              Once, at the top of the group — not on every line, which is
              what a list of cards was doing. */}
          <View style={styles.productRow}>
            <Text style={[styles.productSize, styles.productHeadCell]}>Size</Text>
            <Text style={[styles.productCell, styles.productHeadCell]}>Price</Text>
            <Text style={[styles.productCell, styles.productHeadCell]}>Stock</Text>
            <Text style={[styles.productCell, styles.productHeadCell]}>Today</Text>
            <Text style={styles.productChevron} />
          </View>
        </View>
      )}
      {group.items.map((product) => (
        <ProductRow
          key={product.id}
          product={product}
          label={lone ? product.name : product.size || product.name}
          neededToday={demand[product.id] || 0}
          token={token}
          onChanged={onChanged}
          onError={onError}
        />
      ))}
    </View>
  );
}

// One size, with the two things a business actually keeps changing:
// what it charges, and how much of it there is this morning.
//
// Price was previously write-once — set at creation or never, which is
// backwards, since a dairy usually names its products before it has
// settled on prices. Stock is a number the admin sets rather than one
// the app decrements per delivery: a tally that drifts the first time
// something is spilled or given away is worse than no tally at all.
//
// "Needed today" is what makes the stock number mean anything. It is the
// day's still-pending quantity for this product, so an admin loading the
// van can see 118 needed against 120 in stock and know they are fine.
function ProductRow({ product, label, neededToday, token, onChanged, onError }) {
  const [expanded, setExpanded] = useState(false);
  const [price, setPrice] = useState(product.price_cents > 0 ? String(product.price_cents / 100) : '');
  const [stock, setStock] = useState(String(product.stock_quantity || 0));
  const [unit, setUnit] = useState(product.unit || '');
  const [busy, setBusy] = useState(false);

  const short = () => {
    const have = Number(product.stock_quantity) || 0;
    return neededToday > 0 && have < neededToday;
  };

  const save = async () => {
    setBusy(true);
    try {
      const rupees = Number(price);
      await api.updateProduct(token, product.id, {
        unit: unit.trim() || undefined,
        price_cents: Number.isFinite(rupees) && rupees > 0 ? Math.round(rupees * 100) : 0,
        stock_quantity: Number(stock) || 0,
      });
      setExpanded(false);
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.productBlock}>
      {/* Four columns, so a price list reads like a price list: which
          size, what it costs, what there is, what today wants. The
          numbers are tabular, which is what lets the eye run down them.
          See Docs/DESIGN.md. */}
      <Pressable onPress={() => setExpanded((prev) => !prev)} accessibilityRole="button" style={styles.productRow}>
        <Text style={styles.productSize}>{label}</Text>
        <Text style={[styles.productCell, !product.price_cents && styles.productCellUnset]}>
          {product.price_cents > 0 ? `₹${(product.price_cents / 100).toFixed(0)}` : '—'}
        </Text>
        <Text style={[styles.productCell, short() && styles.productCellShort]}>
          {formatQuantity(product.stock_quantity)}
        </Text>
        <Text style={[styles.productCell, short() && styles.productCellShort]}>
          {neededToday > 0 ? formatQuantity(neededToday) : '—'}
        </Text>
        <Text style={styles.productChevron}>{expanded ? '▾' : '▸'}</Text>
      </Pressable>

      {expanded ? (
        <View style={styles.productEditor}>
          <FieldRow>
            <Field label="Unit" size="sm" value={unit} onChangeText={setUnit} placeholder="packet / can / trip" />
            <Field label="Price ₹" size="xs" value={price} onChangeText={setPrice} keyboardType="numeric" placeholder="60" />
            <Field label="In stock" size="xs" value={stock} onChangeText={setStock} keyboardType="numeric" />
          </FieldRow>
          <View style={styles.buttonRow}>
            <Button title="Save" onPress={save} busy={busy} style={styles.flexButton} />
            <Button
              title="Cancel"
              variant="secondary"
              onPress={() => {
                setPrice(product.price_cents > 0 ? String(product.price_cents / 100) : '');
                setStock(String(product.stock_quantity || 0));
                setUnit(product.unit || '');
                setExpanded(false);
              }}
              style={styles.flexButton}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

// Quantities are whole numbers almost always (12 packets, not 12.0), but
// half a can is a real thing — so show a decimal only when there is one.
function formatQuantity(value) {
  const n = Number(value) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// The "+" that sits at a section's own heading rather than on a repeated
// title row underneath it ("Add a service area" directly below "Service
// areas (1)" was saying the same thing twice). One small circular button,
// same 44px-adjacent touch sizing as the rest of this app's icon buttons,
// that flips to an "×" once open so it's also how you close the form.
// What the business already told us, without meaning to.
//
// Service areas are the hinge the product turns on — no area means no
// route, and every delivery falls through as a stray — and "radius in
// kilometres" is the one abstraction a dairy farmer has no word for. But
// their customers already have pins, and where those pins cluster *is*
// where they deliver. So the setup step is offered as something to accept
// rather than something to invent, and the form it opens arrives already
// filled in.
//
// Only ever shown for places no existing area covers (see
// handleSuggestServiceAreas), so it goes quiet once a business is set up
// rather than nagging forever.
function SuggestedAreas({ suggestions, onAccept }) {
  return (
    <View style={styles.suggestBox}>
      <Text style={styles.suggestLead}>
        {suggestions.length === 1
          ? 'It looks like you already deliver here:'
          : 'It looks like you already deliver to these places:'}
      </Text>
      {suggestions.map((suggestion) => (
        <View key={`${suggestion.lat},${suggestion.lng}`} style={styles.suggestRow}>
          <View style={styles.suggestText}>
            <Text style={styles.suggestName}>{suggestion.name || 'This area'}</Text>
            <Text style={styles.suggestMeta}>
              {suggestion.customer_count} {suggestion.customer_count === 1 ? 'customer' : 'customers'} ·{' '}
              {(suggestion.radius_meters / 1000).toFixed(1)} km across
            </Text>
          </View>
          <Button title="Set this up" onPress={() => onAccept(suggestion)} style={styles.suggestButton} />
        </View>
      ))}

    </View>
  );
}

function ServiceAreaRow({ area, home, token, labels, customerCount, canDelete, onAddCustomer, onImportInto, onChanged, onError }) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState(area.name);
  const [lat, setLat] = useState(area.lat);
  const [lng, setLng] = useState(area.lng);
  const [radiusKm, setRadiusKm] = useState(String(area.radius_meters / 1000));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.updateServiceArea(token, area.id, {
        name,
        lat: Number(lat) || 0,
        lng: Number(lng) || 0,
        radius_meters: (Number(radiusKm) || 0) * 1000,
      });
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async () => {
    setBusy(true);
    try {
      await api.updateServiceArea(token, area.id, { active: !area.active });
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // A tile while it is shut, the full width of the row once it is open —
  // an editor with a map in it cannot live in a third of a phone. See
  // Docs/DESIGN.md.
  const empty = customerCount === 0;
  return (
    <View style={[styles.tile, expanded && styles.tileOpen, !expanded && empty && styles.tileWanting]}>
      <Pressable
        onPress={() => setExpanded((prev) => !prev)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        style={({ pressed }) => [styles.tileHead, pressed && styles.pressed]}
      >
        <View style={styles.tileHeadText}>
          <Text style={styles.tileName}>{area.name}</Text>
          {/* An empty route is the one worth noticing, so it says so
              rather than showing a zero next to a distance. */}
          <Text style={[styles.tileMeta, !expanded && empty && styles.tileMetaWanting]}>
            {empty
              ? 'Nobody on it yet'
              : `${customerCount} ${customerCount === 1 ? lower(labels.customer) : lower(labels.customer_plural)} · ${(
                  area.radius_meters / 1000
                ).toFixed(1)} km`}
          </Text>
        </View>
        {area.active ? null : <Pill label="paused" tone="neutral" />}
        <Text style={styles.tileChevron}>{expanded ? '▾' : '▸'}</Text>
      </Pressable>

      {expanded ? (
        <View style={styles.expanded}>
          {/* The obvious thing to do while looking at a route with
              nobody on it. Sending the owner to the Customers tab and
              making them find the route again afterwards is the app
              handing them its own bookkeeping. */}
          {/* One at a time, or the whole list at once. A file is
              almost always exactly this: somebody's round, written
              down — so importing it from the round's own card is both
              where you would look for it and what says which round the
              file is. */}
          <View style={styles.buttonRow}>
            <Button
              title={`+ Add a ${lower(labels.customer)} here`}
              variant="secondary"
              onPress={() => onAddCustomer(area)}
              style={styles.flexButton}
            />
            <Button
              title="Import a list"
              variant="secondary"
              onPress={() => onImportInto(area)}
              style={styles.flexButton}
            />
          </View>
          <Text style={styles.note}>
            {customerCount === 0
              ? `Nobody on this ${lower(labels.route)} yet.`
              : `${customerCount} ${customerCount === 1 ? lower(labels.customer) : lower(labels.customer_plural)} on this ${lower(labels.route)}.`}
          </Text>

          <Field label="Name" size="md" value={name} onChangeText={setName} />
          <LocationPicker
            label="Centre of the area"
            lat={Number(lat) || 0}
            lng={Number(lng) || 0}
            onChange={(newLat, newLng) => {
              setLat(newLat);
              setLng(newLng);
            }}
            home={home}
            previewRadiusMeters={(Number(radiusKm) || 0) * 1000 || null}
          />
          <Field label="Radius (km)" size="xs" value={radiusKm} onChangeText={setRadiusKm} keyboardType="numeric" />
          <View style={styles.buttonRow}>
            <Button title="Save" onPress={save} busy={busy} style={styles.flexButton} />
            <Button
              title={area.active ? 'Pause' : 'Resume'}
              variant="secondary"
              onPress={toggleActive}
              busy={busy}
              style={styles.flexButton}
            />
          </View>
          {/* Pausing is the everyday answer and stays first. Deleting is
              for a route somebody drew by mistake, and only appears
              while the window is open — see deleteMode.js. */}
          <DeleteButton
            armed={canDelete}
            label={`Delete this ${lower(labels.route)}`}
            describe={async () =>
              `Deleting "${area.name}" also removes the ${lower(
                labels.route,
              )}s built for it today. ${customerCount} ${
                customerCount === 1 ? lower(labels.customer) : lower(labels.customer_plural)
              } go back to being placed by their pin.`
            }
            onDelete={() => api.deleteServiceArea(token, area.id)}
            onDone={onChanged}
            onError={onError}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  loader: { marginTop: spacing.xl * 2 },
  note: { fontSize: 12, color: colors.hint, marginBottom: spacing.sm, lineHeight: 17 },
  rowPills: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  expanded: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', marginTop: spacing.sm },
  flexButton: { flex: 1, minWidth: 110 },
  readRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  readRowText: { flex: 1, paddingRight: spacing.sm },
  readLabel: { fontSize: 12, fontWeight: '600', color: colors.hint, textTransform: 'uppercase', letterSpacing: 0.04 },
  readValue: { fontSize: 16, fontWeight: '700', color: colors.text, marginTop: 2 },
  pencil: { fontSize: 16, color: colors.link },
  editHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  doneLink: { fontSize: 14, fontWeight: '700', color: colors.link },
  // Boxes. Two across a phone, four across a laptop — the row fills
  // whatever width there is rather than running one item down the
  // middle of it.
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tile: {
    flexGrow: 1,
    flexBasis: 160,
    minWidth: 0,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.sm,
  },
  // Open, it stops being a tile: it is a form, and a form needs the row.
  tileOpen: { flexBasis: '100%' },
  tileWanting: { borderColor: colors.warning, backgroundColor: colors.warningBg },
  tileHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 40 },
  tileHeadText: { flex: 1, minWidth: 0 },
  tileName: { fontSize: 15, fontWeight: '700', color: colors.text },
  tileMeta: { fontSize: 12, color: colors.subtitle, marginTop: 1 },
  tileMetaWanting: { color: colors.warning, fontWeight: '600' },
  tileChevron: { fontSize: 14, color: colors.link, fontWeight: '700', width: 14, textAlign: 'center' },
  pressed: { opacity: 0.6 },
  summary: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  summaryTile: {
    flexGrow: 1,
    flexBasis: 120,
    minWidth: 0,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
  },
  summaryTileWarn: { backgroundColor: colors.warningBg },
  summaryLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.hint,
  },
  summaryValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.xs, flexWrap: 'wrap' },
  summaryValue: { fontSize: 24, fontWeight: '800', color: colors.text, fontVariant: ['tabular-nums'] },
  summaryValueWarn: { color: colors.warning },
  summaryNote: { fontSize: 12, color: colors.subtitle },
  productGroup: { marginBottom: spacing.md },
  productGroupHead: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, marginBottom: 2 },
  productGroupName: { fontSize: 16, fontWeight: '700', color: colors.text },
  productGroupCount: { fontSize: 12, color: colors.hint },
  productBlock: { borderTopWidth: 1, borderTopColor: colors.border },
  productRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 40,
  },
  // The size is the row's name and takes the slack; the three numbers
  // hold a fixed column each so they stack under one another down the
  // group. Tabular figures, or a 1 and a 4 shift the column.
  productSize: { flex: 1, fontSize: 14, fontWeight: '700', color: colors.text, minWidth: 0 },
  productCell: {
    width: 58,
    textAlign: 'right',
    fontSize: 14,
    color: colors.label,
    fontVariant: ['tabular-nums'],
  },
  productHeadCell: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.hint,
  },
  productCellUnset: { color: colors.hint },
  productCellShort: { color: colors.warning, fontWeight: '700' },
  productChevron: { fontSize: 14, color: colors.link, fontWeight: '700', width: 16, textAlign: 'center' },
  productEditor: { marginBottom: spacing.sm },
  cardSection: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.xs },
  headingDivider: { borderBottomWidth: 1, borderBottomColor: colors.border, marginTop: -spacing.sm, marginBottom: spacing.md },
  keptBox: {
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  keptTitle: { fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: 3 },
  keptBody: { fontSize: 13, color: colors.subtitle, lineHeight: 19, marginBottom: spacing.sm },
  keptButtons: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  keptButton: { flex: 1, minWidth: 150 },
  inlineForm: { marginBottom: spacing.md },
  coverage: { fontSize: 14, fontWeight: '700', color: colors.accent, marginTop: spacing.xs },
  suggestBox: {
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  suggestLead: { fontSize: 14, fontWeight: '600', color: colors.text, marginBottom: spacing.sm },
  suggestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    flexWrap: 'wrap',
    paddingVertical: spacing.xs,
  },
  suggestText: { flexShrink: 1, minWidth: 140 },
  suggestName: { fontSize: 15, fontWeight: '700', color: colors.text },
  suggestMeta: { fontSize: 13, color: colors.subtitle, marginTop: 1 },
  suggestButton: { flexShrink: 0 },
  newProductToggle: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md },
});
