import * as api from './api';
import { EVERY_DAY, daysFromMask, sameDays } from './frequency';

// Places one order per chosen product. Shared by the "add an order" form
// on an existing customer and the optional first order on the new-customer
// form, so the two can't drift into meaning different things.
//
// `days` is per product ({productId: [weekday numbers]}), because that is
// how the backend has always stored it — one RecurringOrder row per
// product, each with its own mask. Passing one array for the whole order
// is what used to flatten a customer taking milk daily and curd on
// alternate days back onto a single rhythm.
export async function placeOrders({ token, customerId, kind, chosen, days, date, note, replacing = null }) {
  const daysFor = (productId) => (days && days[productId]) || EVERY_DAY;
  // Whether this product's standing order is already exactly right. Days
  // count as much as the number does: changing curd from Mon/Wed/Fri to
  // every day is a real change even though the quantity never moved, and
  // treating it as a no-op was how the old form quietly did nothing.
  const settled = (item) => {
    const sub = replacing && replacing[item.product_id];
    return !!sub && sub.quantity === item.quantity && sameDays(daysFromMask(sub.weekday_mask), daysFor(item.product_id));
  };

  // Stand down what is being replaced first, so a product whose quantity
  // changed ends up with one standing order at the new number rather than
  // two that both run. Deactivating rather than deleting keeps the old
  // arrangement on the record — same convention as customers and drivers.
  if (replacing) {
    const wanted = new Map(chosen.map((item) => [item.product_id, item]));
    for (const [productId, sub] of Object.entries(replacing)) {
      const item = wanted.get(productId);
      if (!item || !settled(item)) {
        await api.setRecurringActive(token, sub.id, false);
      }
    }
  }

  for (const item of chosen) {
    // Already on exactly this, on exactly these days — nothing to do.
    if (replacing && settled(item)) {
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
        weekdays: daysFor(item.product_id),
      });
    }
  }
}
