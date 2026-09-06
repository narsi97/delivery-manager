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
  pin: [
    'coordinates',
    'coordinateslink',
    'coordinate',
    'coords',
    'pin',
    'maplink',
    'maplocation',
    'link',
    'latlng',
    'latitudelongitude',
    'geo',
    'gps',
    'gpslocation',
    'gpscoordinates',
    'gpslink',
    'pluscode',
  ],
  items: ['quantity', 'qty', 'order', 'orders', 'items', 'item', 'product', 'products', 'size'],
  days: ['days', 'deliverydays', 'weekdays', 'frequency', 'when'],
  notes: ['notes', 'note', 'remarks', 'comment', 'instructions'],
};

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// What a location looks like, roughly, without parsing it properly.
//
// Used to find the column when its heading is something nobody thought
// of. The real reading is mapLinks.js's job; this only has to be sure
// enough to tell a coordinate from a house number.
const LOOKS_LIKE_LOCATION = new RegExp(
  [
    String.raw`^-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+$`, // 17.0575, 79.2671
    String.raw`^\d{1,3}\s*[°º]`, // 17°03'24.3"N …
    String.raw`^https?://`, // a shared link
    String.raw`^[23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{0,7}$`, // X429+VC
  ].join('|'),
  'i',
);

// The column whose *contents* are locations, for a file whose heading
// for them is something this has never seen.
//
// Worth having because the heading is the least reliable part of a real
// file: one list called it "Coordinates / Link" and the next called it
// "GPS Location", and a list of thirty-eight households arrived with
// every pin dropped on the floor because of it. The values underneath
// are unmistakable in a way the words above them are not.
function sniffLocationColumn(rows, taken) {
  const width = Math.max(...rows.map((cells) => cells.length), 0);
  for (let index = 0; index < width; index += 1) {
    if (taken.includes(index)) {
      continue;
    }
    let filled = 0;
    let looks = 0;
    for (const cells of rows) {
      const value = String(cells[index] || '').trim();
      if (!value) {
        continue;
      }
      filled += 1;
      if (LOOKS_LIKE_LOCATION.test(value)) {
        looks += 1;
      }
    }
    // Most of what is there, rather than all of it: a real list has
    // households whose pin was never recorded.
    if (filled > 0 && looks * 2 > filled) {
      return index;
    }
  }
  return undefined;
}

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

  if (headers.pin === undefined) {
    const found = sniffLocationColumn(body, Object.values(headers));
    if (found !== undefined) {
      headers.pin = found;
    }
  }

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
