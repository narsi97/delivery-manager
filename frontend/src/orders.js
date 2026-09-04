import * as api from './api';

// Places one order per chosen product. Shared by the "add an order" form
// on an existing customer and the optional first order on the new-customer
// form, so the two can't drift into meaning different things.
export async function placeOrders({ token, customerId, kind, chosen, weekdays, date, note, replacing = null }) {
  // Stand down what is being replaced first, so a product whose quantity
  // changed ends up with one standing order at the new number rather than
  // two that both run. Deactivating rather than deleting keeps the old
  // arrangement on the record — same convention as customers and drivers.
  if (replacing) {
    const keeping = new Set(chosen.map((item) => item.product_id));
    for (const [productId, sub] of Object.entries(replacing)) {
      const unchanged =
        keeping.has(productId) && sub.quantity === chosen.find((i) => i.product_id === productId).quantity;
      if (!unchanged) {
        await api.setRecurringActive(token, sub.id, false);
      }
    }
  }

  for (const item of chosen) {
    // Already on exactly this, at this quantity — nothing to do.
    if (replacing && replacing[item.product_id] && replacing[item.product_id].quantity === item.quantity) {
      continue;
    }
    if (kind === 'once') {
      await api.createAdHocOrder(token, {
        customer_id: customerId,
        product_id: item.product_id,
        quantity: item.quantity,
        date,
        note,
      });
    } else {
      await api.createRecurringOrder(token, {
        customer_id: customerId,
        product_id: item.product_id,
        quantity: item.quantity,
        weekdays,
      });
    }
  }
}
