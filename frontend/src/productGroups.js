// What a business sells, and the sizes it sells it in.
//
// A dairy names its products "Milk 500ml", "Milk 750ml", "Milk 1L". That
// is one product in five sizes, but the app read it as five products and
// drew five cards, each with its own unit, price and stock — so finding
// out what milk costs meant scrolling through five identical forms and
// holding the numbers in your head.
//
// The names already carry the answer: the size is on the end, and what
// is left in front of it is the thing being sold. No new field, no
// migration, and a business that never adopts the convention simply gets
// one row per product, which is what it had before.

// A size at the end of a name: a number, then a unit of volume or
// weight. "1.5L", "500 ml", "500g", "1 Lit" all count.
const TRAILING_SIZE = /\s+(\d+(?:[.,]\d+)?)\s*(ml|l|lt|ltr|lit|lits|litre|litres|liter|liters|g|gm|gms|kg|kgs)\s*$/i;

// Tidied for display: "500 ml", "1 L", "1.5 L". The business's own
// spelling is what is stored and what the driver's list shows; this is
// only how the size reads in a column next to its siblings.
function tidySize(amount, unit) {
  const value = amount.replace(',', '.');
  const short = { lt: 'L', ltr: 'L', lit: 'L', lits: 'L', litre: 'L', litres: 'L', liter: 'L', liters: 'L', l: 'L' };
  const normalized = short[unit.toLowerCase()] || unit.toLowerCase();
  return `${value} ${normalized}`;
}

export function splitSize(name) {
  const match = String(name || '').match(TRAILING_SIZE);
  if (!match) {
    return { product: String(name || '').trim(), size: '' };
  }
  return {
    product: name.slice(0, match.index).trim(),
    size: tidySize(match[1], match[2]),
  };
}

// Groups products by what they are, keeping the order they arrived in —
// which is the order the business created them, and usually the order it
// thinks of them in.
//
// A group of one is still a group, but the screen draws it as a plain
// row: a heading above a single size is a heading about nothing.
export function groupProducts(products) {
  const groups = [];
  const byName = new Map();
  for (const product of products || []) {
    const { product: stem, size } = splitSize(product.name);
    const key = stem.toLowerCase();
    let group = byName.get(key);
    if (!group) {
      group = { key, name: stem, items: [] };
      byName.set(key, group);
      groups.push(group);
    }
    group.items.push({ ...product, size });
  }
  // Smallest first down the column, so a price list reads the way a
  // price list reads. Sizes are compared as real quantities, not as
  // strings, or "1 L" would sort before "500 ml".
  for (const group of groups) {
    group.items.sort((a, b) => millilitresOf(a.size) - millilitresOf(b.size));
  }
  return groups;
}

// A size as a number, for ordering only. Litres and kilos are scaled up
// so they sort against millilitres and grams; anything unrecognised
// sorts last, where it cannot push a real size out of place.
function millilitresOf(size) {
  const match = String(size || '').match(/^(\d+(?:\.\d+)?)\s*(\w+)$/);
  if (!match) {
    return Number.MAX_SAFE_INTEGER;
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'l' || unit === 'kg') {
    return amount * 1000;
  }
  return amount;
}

// Quantities are whole numbers almost always (12 packets, not 12.0), but
// half a can is a real thing — so show decimals only when there are some,
// and two of them: a quarter litre rounded to one place is a quantity
// nobody ordered.
export function formatQuantity(value) {
  const n = Number(value) || 0;
  return String(Number(n.toFixed(2)));
}
