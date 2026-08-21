// Terminology comes from the business's config (see domain.Terminology).
// A school operator manages students on runs, not customers on delivery
// routes, and reading the wrong noun all day is what makes a generic
// product feel like it wasn't built for you.
//
// The backend fills in every field before sending it, but the fallbacks
// below matter anyway: this also runs against a session restored from
// localStorage, which may have been stored by an older build that didn't
// have a given field yet. A blank label is a broken-looking screen.
const FALLBACKS = {
  customer: 'Customer',
  customer_plural: 'Customers',
  delivery: 'Delivery',
  delivery_plural: 'Deliveries',
  product: 'Product',
  product_plural: 'Products',
  quantity: 'Quantity',
  route: 'Route',
  driver: 'Driver',
};

export function labelsFor(business) {
  const terminology = business?.config?.terminology || {};
  const labels = {};
  for (const [key, fallback] of Object.entries(FALLBACKS)) {
    labels[key] = terminology[key] || fallback;
  }
  return labels;
}

// Custom fields are declared per record type. Filtering here rather than
// at each call site keeps the `applies_to` contract in one place.
export function customFieldsFor(business, target) {
  const declared = business?.config?.custom_fields || [];
  return declared.filter((spec) => spec.applies_to === target);
}

// lower() is for mid-sentence use ("add a customer"). Terminology is
// stored capitalized because most uses are headings; naively lowercasing
// would mangle a proper noun, so only the first character is touched —
// "Student" becomes "student", "PTA Member" stays "pTA Member" rather
// than "pta member", which is the less wrong of the two failure modes for
// a label a user typed themselves.
export function lower(label) {
  if (!label) {
    return '';
  }
  return label.charAt(0).toLowerCase() + label.slice(1);
}
