import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from '../api';
import { Banner, Button, Card, Disclosure, Empty, Field, FieldRow, Pill, SectionTitle } from '../components';
import MapPicker from '../MapPicker';
import { currentPosition } from '../navigation';
import { colors, spacing } from '../theme';

// The business's own settings: its name, where it's based, and the
// localities it delivers to. Every map elsewhere in the app (Customers,
// Today's route start point) scopes its default view to what's set up
// here, instead of opening on an India-wide view — see MapPicker.web.js's
// home/areas props.
export default function BusinessScreen({ token, business, onBusinessUpdated }) {
  const [areas, setAreas] = useState([]);
  const [products, setProducts] = useState([]);
  const [demand, setDemand] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [areaResponse, productResponse, demandResponse] = await Promise.all([
        api.listServiceAreas(token),
        api.listProducts(token),
        api.getProductDemand(token),
      ]);
      setAreas(areaResponse.service_areas || []);
      setProducts(productResponse.products || []);
      setDemand(demandResponse.needed || {});
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

  const home = business.home_lat || business.home_lng ? { lat: business.home_lat, lng: business.home_lng } : null;

  if (loading) {
    return <ActivityIndicator style={styles.loader} color={colors.accent} />;
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Banner message={error} />
      <Banner message={notice} tone="success" />

      <BusinessDetailsCard
        token={token}
        business={business}
        onSaved={(updated) => {
          setNotice('Business details saved.');
          onBusinessUpdated(updated);
        }}
        onError={setError}
      />

      <HomeLocationCard
        token={token}
        business={business}
        onSaved={(updated) => {
          setNotice('Home location saved.');
          onBusinessUpdated(updated);
        }}
        onError={setError}
      />

      <Card>
        <SectionTitle>Service areas ({areas.length})</SectionTitle>
        {areas.length === 0 ? (
          <Empty>No service areas yet. Routes are prepared per area, so add the localities you deliver to.</Empty>
        ) : (
          areas.map((area) => (
            <ServiceAreaRow key={area.id} area={area} home={home} token={token} onChanged={refresh} onError={setError} />
          ))
        )}

        <View style={styles.cardSection}>
          <NewServiceAreaForm
            token={token}
            home={home}
            areas={areas}
            onCreated={async (name) => {
              setNotice(`Added ${name}.`);
              await refresh();
            }}
            onError={setError}
          />
        </View>
      </Card>

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
    </ScrollView>
  );
}

// Read-only by default (name + a pencil) — an admin sets this once and
// almost never touches it again, so an always-open Field+Save fights for
// attention every single visit for no reason. Same "collapsed until
// asked for" idea as NewCustomerCard's "+ Add", just applied to editing
// an existing value instead of creating a new one.
function BusinessDetailsCard({ token, business, onSaved, onError }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(business.name);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const updated = await api.updateBusiness(token, { name });
      onSaved(updated);
      setEditing(false);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      {editing ? (
        <View>
          <SectionTitle>Business details</SectionTitle>
          <Field label="Business name" size="md" value={name} onChangeText={setName} placeholder="Anita's Dairy" />
          <View style={styles.buttonRow}>
            <Button title="Save" onPress={save} busy={busy} disabled={!name.trim()} style={styles.flexButton} />
            <Button
              title="Cancel"
              variant="secondary"
              onPress={() => {
                setName(business.name);
                setEditing(false);
              }}
              style={styles.flexButton}
            />
          </View>
        </View>
      ) : (
        <Pressable onPress={() => setEditing(true)} accessibilityRole="button">
          <View style={styles.readRow}>
            <View style={styles.readRowText}>
              <Text style={styles.readLabel}>Business name</Text>
              <Text style={styles.readValue}>{business.name}</Text>
            </View>
            <Text style={styles.pencil}>✎</Text>
          </View>
        </Pressable>
      )}
    </Card>
  );
}

function HomeLocationCard({ token, business, onSaved, onError }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const hasHome = business.home_lat || business.home_lng;

  // Autosaves per click/drag — the business record already exists, so
  // there's nothing to buffer-and-submit, same as CustomerCard's pin
  // editor for an existing customer.
  const savePin = async (lat, lng) => {
    setBusy(true);
    try {
      const updated = await api.updateBusiness(token, { home_lat: lat, home_lng: lng });
      onSaved(updated);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const pinHere = async () => {
    const position = await currentPosition();
    if (!position) {
      onError('Could not read your location. Drop the pin on the map instead.');
      return;
    }
    await savePin(position.lat, position.lng);
  };

  return (
    <Card>
      {editing ? (
        <View>
          <View style={styles.editHeader}>
            <SectionTitle>Home location</SectionTitle>
            <Pressable onPress={() => setEditing(false)} accessibilityRole="button">
              <Text style={styles.doneLink}>Done</Text>
            </Pressable>
          </View>
          <Text style={styles.note}>
            Where the business itself is based — the depot, the shop, the dairy. Used to pre-fill where a round
            starts, and to scope every map in the app to the area you actually operate in.
          </Text>
          <MapPicker lat={business.home_lat} lng={business.home_lng} onChange={savePin} />
          <Button title="Pin my current location" variant="secondary" onPress={pinHere} busy={busy} />
        </View>
      ) : (
        <Pressable onPress={() => setEditing(true)} accessibilityRole="button">
          <View style={styles.readRow}>
            <View style={styles.readRowText}>
              <Text style={styles.readLabel}>Home location</Text>
              <Text style={styles.readValue}>
                {hasHome ? `${business.home_lat.toFixed(4)}, ${business.home_lng.toFixed(4)}` : 'Not set yet'}
              </Text>
            </View>
            <Text style={styles.pencil}>✎</Text>
          </View>
        </Pressable>
      )}
    </Card>
  );
}

// Collapsed by default, same expand-on-tap shape as NewCustomerCard's
// "Add a customer" — this is a create-a-new-record flow (unlike the two
// cards above, which edit the one business record that already exists),
// so buffer-then-submit is the right pattern here, not autosave.
function NewServiceAreaForm({ token, home, areas, onCreated, onError }) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [radiusKm, setRadiusKm] = useState('3');
  const [busy, setBusy] = useState(false);

  const setPin = (newLat, newLng) => {
    setLat(newLat.toFixed(6));
    setLng(newLng.toFixed(6));
  };

  const pinHere = async () => {
    const position = await currentPosition();
    if (!position) {
      onError('Could not read your location. Drop the pin on the map instead.');
      return;
    }
    setPin(position.lat, position.lng);
  };

  const submit = async () => {
    setBusy(true);
    try {
      await api.createServiceArea(token, {
        name,
        lat: Number(lat) || 0,
        lng: Number(lng) || 0,
        radius_meters: (Number(radiusKm) || 0) * 1000,
      });
      const created = name;
      setName('');
      setLat('');
      setLng('');
      setRadiusKm('3');
      setExpanded(false);
      await onCreated(created);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <Disclosure open={expanded} onToggle={() => setExpanded((prev) => !prev)}>
        Add a service area
      </Disclosure>

      {expanded ? (
        <View>
          <Field label="Name" size="md" value={name} onChangeText={setName} placeholder="Jayanagar" />
          <FieldRow>
            <Field label="Latitude" size="sm" value={lat} onChangeText={setLat} placeholder="12.9716" />
            <Field label="Longitude" size="sm" value={lng} onChangeText={setLng} placeholder="77.5946" />
          </FieldRow>
          <MapPicker
            lat={Number(lat) || 0}
            lng={Number(lng) || 0}
            onChange={setPin}
            home={home}
            areas={areas}
            previewRadiusMeters={(Number(radiusKm) || 0) * 1000 || null}
          />
          <Button title="Pin my current location" variant="secondary" onPress={pinHere} />
          <Field
            label="Radius (km)"
            value={radiusKm}
            onChangeText={setRadiusKm}
            keyboardType="numeric"
            hint="How far this zone reaches from the pin — shown live on the map above."
          />
          <Button title="Add service area" onPress={submit} busy={busy} disabled={!name.trim() || !lat || !lng} />
        </View>
      ) : null}
    </View>
  );
}

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
      <SectionTitle>Products ({products.length})</SectionTitle>
      {products.length === 0 ? (
        <Empty>Nothing yet — add your first product below.</Empty>
      ) : (
        products.map((product) => (
          <ProductRow
            key={product.id}
            product={product}
            neededToday={demand[product.id] || 0}
            token={token}
            onChanged={onChanged}
            onError={onError}
          />
        ))
      )}

      <View style={styles.newProductToggle}>
        <Disclosure open={expanded} onToggle={() => setExpanded((prev) => !prev)}>
          Add a product
        </Disclosure>
      </View>

      {expanded ? (
        <View>
          <Field label="Name" size="md" value={name} onChangeText={setName} placeholder="Paneer 200g" />
          <FieldRow>
            <Field label="Unit" size="sm" value={unit} onChangeText={setUnit} placeholder="packet / can / trip" />
            <Field label="Price ₹" size="xs" value={price} onChangeText={setPrice} keyboardType="numeric" placeholder="60" />
          </FieldRow>
          <Button title="Add product" onPress={submit} busy={busy} disabled={!name.trim()} />
        </View>
      ) : null}
    </Card>
  );
}

// One product, with the two things a business actually keeps changing:
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
function ProductRow({ product, neededToday, token, onChanged, onError }) {
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
      <Pressable onPress={() => setExpanded((prev) => !prev)} accessibilityRole="button" style={styles.productRow}>
        <View style={styles.productRowText}>
          <Text style={styles.productName}>{product.name}</Text>
          <Text style={styles.productMeta}>
            {product.unit || 'no unit'}
            {product.price_cents > 0 ? ` · ₹${(product.price_cents / 100).toFixed(2)}` : ' · no price set'}
          </Text>
        </View>
        <View style={styles.productRight}>
          <Pill
            label={`${formatQuantity(product.stock_quantity)} in stock`}
            tone={short() ? 'warning' : 'neutral'}
          />
          <Text style={styles.productChevron}>{expanded ? '▾' : '▸'}</Text>
        </View>
      </Pressable>

      {neededToday > 0 ? (
        <Text style={[styles.productNeeded, short() && styles.productShort]}>
          {formatQuantity(neededToday)} needed for today&apos;s deliveries
          {short() ? ` — ${formatQuantity(neededToday - (Number(product.stock_quantity) || 0))} short` : ''}
        </Text>
      ) : null}

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

function ServiceAreaRow({ area, home, token, onChanged, onError }) {
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

  return (
    <View>
      <Disclosure
        open={expanded}
        onToggle={() => setExpanded((prev) => !prev)}
        right={area.active ? <Pill label="active" tone="success" /> : <Pill label="paused" tone="neutral" />}
      >
        {area.name} · {(area.radius_meters / 1000).toFixed(1)} km
      </Disclosure>

      {expanded ? (
        <View style={styles.expanded}>
          <Field label="Name" size="md" value={name} onChangeText={setName} />
          <MapPicker
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
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, maxWidth: 720, width: '100%', alignSelf: 'center' },
  loader: { marginTop: spacing.xl * 2 },
  note: { fontSize: 12, color: colors.hint, marginBottom: spacing.sm, lineHeight: 17 },
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
  productBlock: { borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: spacing.xs },
  productRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
  },
  productRowText: { flex: 1 },
  productRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  productChevron: { fontSize: 16, color: colors.link, fontWeight: '700', width: 16, textAlign: 'center' },
  productNeeded: { fontSize: 12, color: colors.hint, marginBottom: spacing.xs },
  productShort: { color: colors.warning, fontWeight: '700' },
  productEditor: { marginBottom: spacing.sm },
  productName: { fontSize: 15, fontWeight: '600', color: colors.text },
  productMeta: { fontSize: 13, color: colors.subtitle },
  cardSection: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.xs },
  newProductToggle: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md },
});
