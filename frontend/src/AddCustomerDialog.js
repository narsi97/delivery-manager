import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import * as api from './api';
import { Button, DeclaredFields, Dialog, Field, FieldRow } from './components';
import { lower } from './labels';
import { nearestAreaFor } from './serviceAreas';
import LocationPicker from './LocationPicker';
import { EVERY_DAY } from './frequency';
import PriorityPicker from './PriorityPicker';
import ProductQuantities, { chosenProducts } from './ProductQuantities';
import { placeOrders } from './orders';
import { colors, radius, spacing } from './theme';

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
  // Seeded from the route this was opened from, and changeable either
  // way — geography cannot tell a morning round from an evening one
  // over the same streets, so this is the only thing that can.
  const [routeId, setRouteId] = useState(serviceAreaId || '');
  const [form, setForm] = useState({ name: '', phone: '', address: '', lat: '', lng: '', notes: '', priority: 'normal' });
  const [customFields, setCustomFields] = useState({});
  const [quantities, setQuantities] = useState({});
  // Per product, like the customer's own card. A new customer usually
  // takes everything every day, so every row starts there and only the
  // ones that differ need touching.
  const [dayMasks, setDayMasks] = useState({});
  const [busy, setBusy] = useState(false);

  const set = (key) => (value) => setForm((prev) => ({ ...prev, [key]: value }));
  const chosen = chosenProducts(quantities);
  // Recomputed as the pin moves, so the default option names the route
  // it would actually land on rather than a guess made when it opened.
  const byPin = nearestAreaFor(Number(form.lat) || 0, Number(form.lng) || 0, areas);
  const byPinName = byPin ? byPin.name : '';

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
        service_area_id: routeId || '',
        custom_fields: customFields,
      });
      // The standing order is optional — skipping it just means nothing
      // here runs, and the customer can be given one later from their own
      // card. Doing it in the same submit rather than as a second step
      // keeps "signed up a new customer for 2L a day" a single action,
      // which is how it actually happens at the door.
      if (chosen.length > 0) {
        await placeOrders({ token, customerId: customer.id, kind: 'weekly', chosen, days: dayMasks });
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
        // A customer being added has no pin yet, so the map opens on the
        // round they are being put on — or on all of them, until one is
        // chosen. Anything else opens on the farm, which for a dairy is
        // often the one place none of the customers are.
        focusAreas={routeId ? areas.filter((a) => a.id === routeId) : areas}
      />
      <Field
        label="Address"
        size="md"
        value={form.address}
        onChangeText={set('address')}
        placeholder="12, 3rd Cross, Jayanagar"
      />
      {/* Two short answers, side by side, like the same pair on the
          customer's own card. They wrap into a column on a narrow
          dialog. */}
      <View style={styles.pickerRow}>
        <PriorityPicker style={styles.pickerCell} value={form.priority} onChange={set('priority')} />

        {/* Which round they go on. Two service routes can cover exactly
            the same streets — a morning one and an evening one — so a
            pin cannot answer this and the default has to be askable. */}
        {areas.length > 0 ? (
          <View style={[styles.routePicker, styles.pickerCell]}>
            <Text style={styles.pickerLabel}>Which {lower(labels.route)}?</Text>
            <select value={routeId} style={routeSelectStyle} onChange={(event) => setRouteId(event.target.value)}>
              <option value="">From their pin{byPinName ? ` (${byPinName})` : ''}</option>
              {areas
                .filter((area) => area.active)
                .map((area) => (
                  <option key={area.id} value={area.id}>
                    {area.name}
                  </option>
                ))}
            </select>
            <Text style={styles.hint}>
              {routeId
                ? `They'll go on this ${lower(labels.route)} whatever their pin says.`
                : byPinName
                  ? `Their pin puts them on ${byPinName}.`
                  : `Their pin is not inside any ${lower(labels.route)} yet.`}
            </Text>
          </View>
        ) : null}
      </View>
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
            days={dayMasks}
            onDaysChange={setDayMasks}
          />

        </View>
      ) : null}

      <Button
        title={chosen.length > 0 ? `Add ${lower(labels.customer)} and their order` : `Add ${lower(labels.customer)}`}
        onPress={submit}
        busy={busy}
        disabled={!form.name.trim() || chosen.some((item) => (dayMasks[item.product_id] || EVERY_DAY).length === 0)}
      />
    </View>
  );
}

// A raw select, like every other picker in this app. It fills the cell
// it shares with the priority picker, so the two read as one pair of
// questions rather than two fields of different lengths.
const routeSelectStyle = {
  width: '100%',
  minWidth: 0,
  maxWidth: '100%',
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

const styles = StyleSheet.create({
  routePicker: { marginBottom: spacing.sm },
  pickerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  pickerCell: { flex: 1, minWidth: 210 },
  // Same label without the stacked-field top margin, so both pickers in
  // the row start on the same line.
  pickerLabel: { fontSize: 13, fontWeight: '600', color: colors.label, marginBottom: 3 },
  hint: { fontSize: 12, color: colors.hint, marginTop: 3, lineHeight: 16 },
  label: { fontSize: 13, fontWeight: '600', color: colors.label, marginBottom: spacing.xs, marginTop: spacing.sm },
  orderSection: {
    marginTop: spacing.sm,
    marginBottom: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
});
