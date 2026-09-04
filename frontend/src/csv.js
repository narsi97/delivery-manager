// Reading a delivery list out of a file.
//
// The file is whatever the business already has: a spreadsheet saved as
// CSV, a column pasted out of one, a table copied from a PDF. So this
// takes commas or tabs, quoted fields with commas and newlines inside
// them, and headers spelled however the person who made the file spelled
// them.
//
// Deliberately hand-written rather than a CSV library. The format is
// four rules, the file is small enough to hold in memory twice over, and
// a dependency here would be a megabyte of parser to save forty lines.

// Splits one delimited line, respecting quotes. RFC 4180's escape is a
// doubled quote inside a quoted field, which is what every spreadsheet
// produces.
function splitRows(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      // \r\n is one line ending, not two.
      if (ch === '\r' && text[i + 1] === '\n') {
        i += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);
  // A file ending in a newline leaves one empty row behind it.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

// Whichever separator appears more often outside quotes. A spreadsheet
// pasted straight out of Excel arrives tab-separated, and telling
// somebody their file is the wrong kind when it is perfectly readable is
// the app being difficult.
function sniffDelimiter(text) {
  const head = text.split('\n').slice(0, 5).join('\n');
  const commas = (head.match(/,/g) || []).length;
  const tabs = (head.match(/\t/g) || []).length;
  return tabs > commas ? '\t' : ',';
}

// Header spellings this understands, per field. Matched after stripping
// everything that isn't a letter or digit, so "Phone Number", "phone_no"
// and "PHONE" are one header.
const HEADERS = {
  name: ['name', 'customer', 'customername', 'household'],
  phone: ['phone', 'phonenumber', 'phoneno', 'mobile', 'contact', 'number'],
  address: ['address', 'addr', 'street', 'location', 'place'],
  pin: ['coordinates', 'coordinateslink', 'coordinate', 'pin', 'maplink', 'link', 'latlng', 'geo', 'gps', 'pluscode'],
  items: ['quantity', 'qty', 'order', 'orders', 'items', 'item', 'product', 'products', 'size'],
  days: ['days', 'deliverydays', 'weekdays', 'frequency', 'when'],
  notes: ['notes', 'note', 'remarks', 'comment', 'instructions'],
};

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function mapHeaders(cells) {
  const found = {};
  cells.forEach((cell, index) => {
    const key = squash(cell);
    for (const [field, spellings] of Object.entries(HEADERS)) {
      if (found[field] === undefined && spellings.includes(key)) {
        found[field] = index;
        return;
      }
    }
  });
  return found;
}

// Does this row look like headers rather than a customer? A header row
// names at least a couple of the fields and holds no digits worth
// speaking of.
function looksLikeHeaders(cells) {
  const mapped = mapHeaders(cells);
  return Object.keys(mapped).length >= 2;
}

export const WEEKDAY_NAMES = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

// "Mon, Wed, Fri", "weekdays", "every day", or nothing at all.
export function parseDays(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value || /every ?day|daily|all/.test(value)) {
    return [];
  }
  if (/^week ?days?$/.test(value)) {
    return [1, 2, 3, 4, 5];
  }
  if (/^week ?ends?$/.test(value)) {
    return [6, 0];
  }
  const days = [];
  for (const part of value.split(/[,;/|]+|\s+/)) {
    const day = WEEKDAY_NAMES[squash(part)];
    if (day !== undefined && !days.includes(day)) {
      days.push(day);
    }
  }
  return days;
}

// One cell of ordered things into products and counts.
//
//   "750 ML"              -> one of Milk 750ml
//   "500 ML, 500 ML"      -> two of Milk 500ml, because the list wrote it
//                            twice rather than writing 2
//   "2 x Milk 1L; Curd"   -> what a tidier file looks like
//
// The product text is not resolved here. Which products exist is the
// server's business, and it answers in the preview.
export function parseItems(text) {
  const value = String(text || '').trim();
  if (!value) {
    return [];
  }
  const items = [];
  for (const raw of value.split(/[,;]+/)) {
    const part = raw.trim();
    if (!part) {
      continue;
    }
    // "2 x Milk 1L" or "2 Milk 1L" — a leading count, but only when
    // something follows it that is not itself a size. "500 ML" must not
    // read as five hundred of "ML".
    const counted = part.match(/^(\d+(?:\.\d+)?)\s*(?:x|×|\*)\s*(.+)$/i);
    const product = counted ? counted[2].trim() : part;
    const quantity = counted ? Number(counted[1]) : 1;
    const existing = items.find((item) => squash(item.product) === squash(product));
    if (existing) {
      existing.quantity += quantity;
    } else {
      items.push({ product, quantity });
    }
  }
  return items;
}

// parseCsv returns { rows, headers, delimiter, headerRow }.
//
// Rows come back as plain objects of raw text. Nothing is validated and
// nothing is resolved — the caller turns the pin text into a pin and the
// server turns the product text into a product, and both report back.
export function parseCsv(text) {
  const delimiter = sniffDelimiter(text);
  const table = splitRows(String(text || ''), delimiter);
  if (table.length === 0) {
    return { rows: [], headers: {}, delimiter, headerRow: false };
  }

  const headerRow = looksLikeHeaders(table[0]);
  // Without headers, fall back to the order the columns almost always
  // come in. Better than refusing: somebody pasting three columns should
  // not have to learn a schema first.
  const headers = headerRow ? mapHeaders(table[0]) : { name: 0, phone: 1, address: 2, items: 3, pin: 4 };
  const body = headerRow ? table.slice(1) : table;

  const at = (cells, field) => {
    const index = headers[field];
    return index === undefined ? '' : String(cells[index] || '').trim();
  };

  const rows = body.map((cells, index) => ({
    line: index + (headerRow ? 2 : 1),
    name: at(cells, 'name'),
    phone: at(cells, 'phone'),
    address: at(cells, 'address'),
    pinText: at(cells, 'pin'),
    itemsText: at(cells, 'items'),
    daysText: at(cells, 'days'),
    notes: at(cells, 'notes'),
  }));

  return { rows, headers, delimiter, headerRow };
}
