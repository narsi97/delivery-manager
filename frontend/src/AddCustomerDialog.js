import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import * as api from './api';
import { Button, DeclaredFields, Dialog, Field, FieldRow } from './components';
import { lower } from './labels';
import LocationPicker from './LocationPicker';
import PriorityPicker from './PriorityPicker';
import ProductQuantities, { chosenProducts } from './ProductQuantities';
import { placeOrders } from './orders';
import { colors, radius, spacing } from './theme';

const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

// Adding a customer, from wherever you happened to think of it.
//
// This was an inline form under the roster's heading, which was right
// while the roster was the only place you could be standing when the
// thought occurred. It isn't: looking at a service route with nobody on
// it is exactly when you want to put somebody on it, and sending the
// owner to another tab to do it — where they would then have to find the
// route again and assign by hand — is the app making them do the
// bookkeeping.
//
// So it is a dialog, and the same one answers both. Opened from a route,
// it says so and pins the new customer there; opened from the roster,
// their pin decides as it always did.
export default function AddCustomerDialog({
  open,
  onClose,
  token,
  labels,
  fieldSpecs,
  home,
  areas,
  products,
  // The service route this was opened from, if any. The customer is
  // pinned to it rather than left to geography, because opening the
  // dialog from a route is a statement about which one they are on.
  serviceArea = null,
  onCreated,
  onError,
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={serviceArea ? `Add a ${lower(labels.customer)} to ${serviceArea.name}` : `Add a ${lower(labels.customer)}`}
    >
      {serviceArea ? (
        <Text style={styles.pinnedNote}>
          They&apos;ll go on {serviceArea.name} whatever their pin says. Move them later from their own card.
        </Text>
      ) : null}
      <CustomerForm
        token={token}
        labels={labels}
        fieldSpecs={fieldSpecs}
        home={home}
        areas={areas}
        products={products}
        serviceAreaId={serviceArea?.id}
        onCreated={onCreated}
        onError={onError}
      />
    </Dialog>
  );
}

function CustomerForm({ token, labels, fieldSpecs, home, areas, products, serviceAreaId, onCreated, onError }) {
  const [form, setForm] = useState({ name: '', phone: '', address: '', lat: '', lng: '', notes: '', priority: 'normal' });
  const [customFields, setCustomFields] = useState({});
  const [quantities, setQuantities] = useState({});
  const [weekdays, setWeekdays] = useState([1, 2, 3, 4, 5, 6, 0]);
  const [busy, setBusy] = useState(false);

  const set = (key) => (value) => setForm((prev) => ({ ...prev, [key]: value }));
  const toggleDay = (day) =>
    setWeekdays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));
  const chosen = chosenProducts(quantities);

  const submit = async () => {
    setBusy(true);
    try {
      const customer = await api.createCustomer(token, {
        name: form.name,
        phone: form.phone,
        address: form.address,
        notes: form.notes,
        lat: Number(form.lat) || 0,
        lng: Number(form.lng) || 0,
        priority: form.priority,
        // Pinned to the route this was opened from, when it was
        // opened from one — see domain.Customer.ServiceAreaID.
        service_area_id: serviceAreaId || undefined,
        custom_fields: customFields,
      });
      // The standing order is optional — skipping it just means nothing
      // here runs, and the customer can be given one later from their own
      // card. Doing it in the same submit rather than as a second step
      // keeps "signed up a new customer for 2L a day" a single action,
      // which is how it actually happens at the door.
      if (chosen.length > 0) {
        await placeOrders({ token, customerId: customer.id, kind: 'weekly', chosen, weekdays });
      }
      const created = form.name;
      setForm({ name: '', phone: '', address: '', lat: '', lng: '', notes: '', priority: 'normal' });
      setCustomFields({});
      setQuantities({});
      await onCreated(created);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <FieldRow>
        <Field label="Name" size="md" value={form.name} onChangeText={set('name')} placeholder="Anita Sharma" />
        <Field
          label="Phone"
          size="sm"
          value={form.phone}
          onChangeText={set('phone')}
          keyboardType="phone-pad"
          placeholder="98765 43210"
        />
      </FieldRow>
      {/* Where comes before what it's called. The pin is what routes
          the delivery; the written address is a note for a human who is
          already standing there, so it reads better as a caption under
          the map than as a question asked before it. */}
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
        label="Address"
        size="md"
        value={form.address}
        onChangeText={set('address')}
        placeholder="12, 3rd Cross, Jayanagar"
      />
      <PriorityPicker value={form.priority} onChange={set('priority')} />
      <Field
        label={`Notes for the ${lower(labels.driver)}`}
        value={form.notes}
        onChangeText={set('notes')}
        placeholder="Gate code 1234, leave at door"
        multiline
      />
      <DeclaredFields specs={fieldSpecs} values={customFields} onChange={setCustomFields} />

      {products.length > 0 ? (
        <View style={styles.orderSection}>
          <Text style={styles.label}>What will they take? (optional)</Text>
          <ProductQuantities
            products={products}
            quantities={quantities}
            onChange={setQuantities}
            unitLabel="Leave everything at zero to skip — you can set this up later from their card."
          />

          {chosen.length > 0 ? (
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
          ) : null}
        </View>
      ) : null}

      <Button
        title={chosen.length > 0 ? `Add ${lower(labels.customer)} and their order` : `Add ${lower(labels.customer)}`}
        onPress={submit}
        busy={busy}
        disabled={!form.name.trim() || (chosen.length > 0 && weekdays.length === 0)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  pinnedNote: { fontSize: 13, color: colors.subtitle, lineHeight: 19, marginBottom: spacing.md },
  label: { fontSize: 13, fontWeight: '600', color: colors.label, marginBottom: spacing.xs, marginTop: spacing.sm },
  orderSection: {
    marginTop: spacing.sm,
    marginBottom: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
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
