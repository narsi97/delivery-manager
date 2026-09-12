// Reading a delivery list out of the PDF a business already has.
//
// This is not a general PDF reader and does not try to be. It reads the
// one shape this product is handed: a table of customers with a number,
// a name, a phone, an address, a quantity and — sometimes — a location.
// That shape arrives as a printed sheet because that is what the office
// already keeps, and asking somebody to retype thirty-nine households
// into a spreadsheet before they can start is most of the reason they
// would not start.
//
// No library. A PDF's text lives in content streams that are Flate
// compressed, sometimes ASCII85 wrapped, and browsers have shipped
// DecompressionStream for years — so the whole extraction is that plus
// pulling the parenthesised strings out of the result. A parser that
// handled every PDF ever made would be a megabyte of dependency to read
// files this product itself defines the shape of.
//
// What it deliberately does not do: fonts, encodings beyond Latin-1,
// positioned text, tables reconstructed from coordinates. If a file does
// not come out as readable lines, the screen says so and the CSV path is
// still there.

const HEADER_WORDS = new Set([
  'delivery list',
  's.n',
  'sno',
  's.no',
  'o',
  'name',
  'phone',
  'phone number',
  'address',
  'qty',
  'quantity',
  'gps location',
  'coordinates / link',
  'coordinates',
]);

// A row number: the "S.No" column, which is what tells one record from
// the next when everything else can wrap onto two lines.
const ROW_NUMBER = /^\d{1,3}$/;
const PHONE = /^\d[\d ]{8,13}$/;
const QUANTITY = /^\d+(?:\.\d+)?\s*(?:ml|l|lit|ltr|litre|liter|lits)$/i;
const LOCATION = /^\d{1,3}\s*[°º]|^https?:\/\/|^-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+$/i;

async function inflate(bytes) {
  // "deflate" is zlib-wrapped, which is what FlateDecode means; a few
  // writers emit it raw, so both are tried.
  for (const format of ['deflate', 'deflate-raw']) {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (err) {
      // Try the other framing.
    }
  }
  return null;
}

// ASCII85, as PDF spells it: <~ optional, ~> terminates, z is four zero
// bytes.
function ascii85(text) {
  const body = String(text).replace(/^<~/, '').replace(/~>[\s\S]*$/, '').replace(/\s+/g, '');
  const out = [];
  let group = [];
  for (const ch of body) {
    if (ch === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const code = ch.charCodeAt(0) - 33;
    if (code < 0 || code > 84) {
      continue;
    }
    group.push(code);
    if (group.length === 5) {
      let value = 0;
      for (const digit of group) {
        value = value * 85 + digit;
      }
      out.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
      group = [];
    }
  }
  if (group.length > 1) {
    const short = group.length;
    while (group.length < 5) {
      group.push(84);
    }
    let value = 0;
    for (const digit of group) {
      value = value * 85 + digit;
    }
    const bytes = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
    out.push(...bytes.slice(0, short - 1));
  }
  return new Uint8Array(out);
}

// The text of every content stream, in file order.
async function extractText(buffer) {
  const bytes = new Uint8Array(buffer);
  // Latin-1 so byte offsets and string offsets stay the same: a PDF is
  // binary, and any multi-byte decoding would slide the stream markers.
  const raw = new TextDecoder('latin1').decode(bytes);
  const chunks = [];
  const marker = /stream\r?\n/g;
  let found;
  while ((found = marker.exec(raw)) !== null) {
    const start = found.index + found[0].length;
    const end = raw.indexOf('endstream', start);
    if (end === -1) {
      break;
    }
    const slice = bytes.subarray(start, end);
    let inflated = await inflate(slice);
    if (!inflated) {
      // ASCII85 first, then Flate — the usual pairing.
      const decoded = ascii85(raw.slice(start, end));
      inflated = decoded.length > 0 ? await inflate(decoded) : null;
    }
    if (inflated) {
      chunks.push(new TextDecoder('latin1').decode(inflated));
    }
  }
  return chunks.join('\n');
}

// The strings a content stream draws, in order. PDF escapes \( \) and
// \\ inside them, and writes a degree sign as \260 in this encoding.
function drawnStrings(content) {
  const out = [];
  const literal = /\((?:[^()\\]|\\.)*\)/g;
  let found;
  while ((found = literal.exec(content)) !== null) {
    const text = found[0]
      .slice(1, -1)
      .replace(/\\(\d{1,3})/g, (_, code) => String.fromCharCode(parseInt(code, 8)))
      .replace(/\\([()\\])/g, '$1');
    out.push(text);
  }
  return out;
}

// Groups the lines into records, one per S.No.
//
// Every field except the number can wrap onto a second line, so nothing
// is read by position. The number starts a record; inside it the phone
// is found by shape, the quantity by shape, the location by shape, and
// whatever is left in between is the address. A name is whatever sits
// before the phone.
export function toRows(lines) {
  const starts = [];
  lines.forEach((line, index) => {
    if (ROW_NUMBER.test(line)) {
      starts.push(index);
    }
  });

  const rows = [];
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i] + 1;
    const to = i + 1 < starts.length ? starts[i + 1] : lines.length;
    const body = lines.slice(from, to);
    const phoneAt = body.findIndex((line) => PHONE.test(line));
    if (phoneAt === -1) {
      continue; // not a customer row — a stray number in a heading
    }
    const after = body.slice(phoneAt + 1);
    // A PDF draws what it draws. One list put a whole coordinate in a
    // single string; the next drew "17°03'03.3\"N" and "79°15'22.7\"E"
    // as two, and reading only the first meant every pin in the file was
    // half a location — a latitude with nothing to pair it with, and a
    // longitude thrown away with the address. So the halves are put back
    // together: a fragment ending N or S followed by one ending E or W
    // is one location that happened to be drawn twice.
    const found = after.filter((line) => LOCATION.test(line));
    let location = found[0] || '';
    if (/[NS]$/i.test(location) && found[1] && /[EW]$/i.test(found[1])) {
      location = `${location}, ${found[1]}`;
    }
    const rest = after.filter((line) => !LOCATION.test(line));
    const qtyAt = rest.findIndex((line) => QUANTITY.test(line));
    rows.push({
      line: Number(lines[starts[i]]),
      name: body.slice(0, phoneAt).join(' ').trim(),
      phone: body[phoneAt].replace(/\s+/g, ''),
      address: (qtyAt === -1 ? rest : rest.slice(0, qtyAt)).join(' ').trim(),
      itemsText: qtyAt === -1 ? '' : rest[qtyAt].trim(),
      pinText: location.trim(),
      daysText: '',
      notes: '',
    });
  }
  return rows;
}

export function looksLikePdf(file) {
  return !!file && (/\.pdf$/i.test(file.name || '') || file.type === 'application/pdf');
}

// Reads the file and returns the same row shape parseCsv produces, so
// everything downstream — the preview, the pin resolving, the import —
// is identical whichever kind of file arrived.
export async function parsePdfList(buffer) {
  const content = await extractText(buffer);
  if (!content) {
    return { rows: [], reason: 'nothing-readable' };
  }
  const lines = drawnStrings(content)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && !HEADER_WORDS.has(line.toLowerCase()));
  const rows = toRows(lines);
  return { rows, reason: rows.length === 0 ? 'no-rows' : '' };
}
