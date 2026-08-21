import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from '../api';
import { Banner, Button, Card, DeclaredFields, Empty, Field, Pill, SectionTitle } from '../components';
import { customFieldsFor, labelsFor, lower } from '../labels';
import { currentPosition } from '../navigation';
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [customerResponse, productResponse, subscriptionResponse] = await Promise.all([
        api.listCustomers(token),
        api.listProducts(token),
        api.listRecurringOrders(token),
      ]);
      setCustomers(customerResponse.customers || []);
      setProducts(productResponse.products || []);
      setSubscriptions(subscriptionResponse.recurring_orders || []);
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

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Banner message={error} />
      <Banner message={notice} tone="success" />

      <NewCustomerCard
        token={token}
        labels={labels}
        fieldSpecs={fieldSpecs}
        onCreated={async (name) => {
          setNotice(`Added ${name}.`);
          await refresh();
        }}
        onError={setError}
      />

      <SectionTitle>
        {labels.customer_plural} ({customers.length})
      </SectionTitle>
      {customers.length === 0 ? (
        <Card>
          <Empty>No {lower(labels.customer_plural)} yet. Add the first one above.</Empty>
        </Card>
      ) : (
        customers.map((customer) => (
          <CustomerCard
            key={customer.id}
            customer={customer}
            products={products}
            subscriptions={subscriptions.filter((sub) => sub.customer_id === customer.id)}
            token={token}
            labels={labels}
            fieldSpecs={fieldSpecs}
            onChanged={refresh}
            onError={setError}
          />
        ))
      )}
    </ScrollView>
  );
}

function NewCustomerCard({ token, labels, fieldSpecs, onCreated, onError }) {
  const [form, setForm] = useState({ name: '', phone: '', address: '', lat: '', lng: '', notes: '' });
  const [customFields, setCustomFields] = useState({});
  const [busy, setBusy] = useState(false);

  const set = (key) => (value) => setForm((prev) => ({ ...prev, [key]: value }));

  const pinHere = async () => {
    const position = await currentPosition();
    if (!position) {
      onError('Could not read your location. Type the coordinates instead, or pin it later from the door.');
      return;
    }
    setForm((prev) => ({ ...prev, lat: position.lat.toFixed(6), lng: position.lng.toFixed(6) }));
  };

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
      await onCreated(created);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <SectionTitle>Add a {lower(labels.customer)}</SectionTitle>
      <Field label="Name" value={form.name} onChangeText={set('name')} placeholder="Anita Sharma" />
      <Field label="Phone" value={form.phone} onChangeText={set('phone')} keyboardType="phone-pad" placeholder="98765 43210" />
      <Field label="Address" value={form.address} onChangeText={set('address')} placeholder="12, 3rd Cross, Jayanagar" />
      <View style={styles.row}>
        <Field label="Latitude" value={form.lat} onChangeText={set('lat')} placeholder="12.9716" style={styles.half} />
        <Field label="Longitude" value={form.lng} onChangeText={set('lng')} placeholder="77.5946" style={styles.half} />
      </View>
      <Button title="Pin my current location" variant="secondary" onPress={pinHere} />
      <Text style={styles.note}>
        The pin — not the address — is what orders the route. You can leave it blank now and drop it later while
        standing at the door.
      </Text>
      <Field
        label={`Notes for the ${lower(labels.driver)}`}
        value={form.notes}
        onChangeText={set('notes')}
        placeholder="Gate code 1234, leave at door"
        multiline
      />
      <DeclaredFields specs={fieldSpecs} values={customFields} onChange={setCustomFields} />
      <Button title={`Add ${lower(labels.customer)}`} onPress={submit} busy={busy} disabled={!form.name.trim()} />
    </Card>
  );
}

function CustomerCard({ customer, products, subscriptions, token, labels, fieldSpecs, onChanged, onError }) {
  const [expanded, setExpanded] = useState(false);
  const [customFields, setCustomFields] = useState(customer.custom_fields || {});
  const [busy, setBusy] = useState(false);

  const pinHere = async () => {
    const position = await currentPosition();
    if (!position) {
      onError('Could not read your location.');
      return;
    }
    setBusy(true);
    try {
      // Only the pin is sent — PATCH is partial, so the name, address and
      // notes already saved are left untouched.
      await api.updateCustomer(token, customer.id, { lat: position.lat, lng: position.lng });
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Pressable onPress={() => setExpanded((prev) => !prev)}>
        <View style={styles.customerHeader}>
          <View style={styles.customerHeaderText}>
            <Text style={styles.customerName}>{customer.name}</Text>
            {customer.address ? <Text style={styles.customerMeta}>{customer.address}</Text> : null}
            {customer.phone ? <Text style={styles.customerMeta}>{customer.phone}</Text> : null}
          </View>
          <View style={styles.pills}>
            {customer.lat || customer.lng ? <Pill label="pinned" tone="success" /> : <Pill label="no pin" tone="warning" />}
            {!customer.active ? <Pill label="paused" tone="neutral" /> : null}
          </View>
        </View>
      </Pressable>

      <Text style={styles.subsHeading}>
        {subscriptions.length === 0
          ? 'No standing order yet'
          : subscriptions
              .map((sub) => `${sub.quantity} × ${productName(products, sub.product_id)} on ${weekdayLabel(sub.weekday_mask)}`)
              .join('  ·  ')}
      </Text>

      {expanded ? (
        <View style={styles.expanded}>
          <View style={styles.buttonRow}>
            <Button title="Pin at my location" variant="secondary" onPress={pinHere} busy={busy} style={styles.flexButton} />
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

          <NewSubscriptionForm
            token={token}
            customer={customer}
            products={products}
            labels={labels}
            onChanged={onChanged}
            onError={onError}
          />
        </View>
      ) : null}
    </Card>
  );
}

function NewSubscriptionForm({ token, customer, products, labels, onChanged, onError }) {
  const [productId, setProductId] = useState(products[0]?.id || '');
  const [quantity, setQuantity] = useState('1');
  const [weekdays, setWeekdays] = useState([1, 2, 3, 4, 5, 6, 0]);
  const [busy, setBusy] = useState(false);

  const toggleDay = (day) =>
    setWeekdays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));

  const submit = async () => {
    setBusy(true);
    try {
      await api.createRecurringOrder(token, {
        customer_id: customer.id,
        product_id: productId,
        quantity: Number(quantity),
        weekdays,
      });
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (products.length === 0) {
    return <Empty>Add a {lower(labels.product)} before setting up a standing order.</Empty>;
  }

  return (
    <View style={styles.subForm}>
      <Text style={styles.label}>Standing order</Text>
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

      <Field label={labels.quantity} value={quantity} onChangeText={setQuantity} keyboardType="numeric" />

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

      <Button
        title="Save standing order"
        onPress={submit}
        busy={busy}
        disabled={!productId || weekdays.length === 0}
      />
    </View>
  );
}

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
  row: { flexDirection: 'row', gap: spacing.md },
  half: { minWidth: 120 },
  note: { fontSize: 12, color: colors.hint, marginTop: spacing.sm, marginBottom: spacing.md, lineHeight: 17 },
  customerHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  customerHeaderText: { flex: 1, paddingRight: spacing.sm },
  customerName: { fontSize: 16, fontWeight: '700', color: colors.text },
  customerMeta: { fontSize: 13, color: colors.subtitle, marginTop: 2 },
  pills: { gap: spacing.xs, alignItems: 'flex-end' },
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
