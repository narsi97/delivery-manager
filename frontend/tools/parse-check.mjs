// Does the reader still read a real list?
//
// Two real files have arrived with every pin silently dropped — one
// because its column was headed "GPS Location", one because the PDF drew
// each coordinate as two separate strings. Both times the data was there,
// the preview said it was not, and nothing failed loudly.
//
// So these are the shapes that have actually broken, kept as cases. No
// fixture holds a real customer: names, numbers and addresses here are
// invented, and the regressions are reproduced by shape alone.
//
//   node tools/parse-check.mjs        (from frontend/)
//
// The app's modules are ESM while this package is commonjs, so they are
// copied to .mjs in a temp directory to be imported. Changing the
// package type would be a change Metro has to live with; a copy is not.
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODULES = ['pdfList', 'csv', 'mapLinks', 'plusCodes'];
const dir = mkdtempSync(join(tmpdir(), 'parse-check-'));
for (const name of MODULES) {
  const src = readFileSync(join('src', `${name}.js`), 'utf8')
    .replace(/from '\.\/([A-Za-z0-9_]+)'/g, "from './$1.mjs'");
  writeFileSync(join(dir, `${name}.mjs`), src);
}
const { toRows } = await import(join(dir, 'pdfList.mjs'));
const { parseMapLink } = await import(join(dir, 'mapLinks.mjs'));
const { parseCsv } = await import(join(dir, 'csv.mjs'));
rmSync(dir, { recursive: true, force: true });

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures += 1;
    console.log(`  FAIL  ${what}\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`);
  } else {
    console.log(`  ok    ${what}`);
  }
}
const near = (value, want) => (typeof value === 'number' ? Number(value.toFixed(4)) : value) === want;

console.log('coordinates, however the file writes them');
for (const [text, lat, lng] of [
  ["17°03'03.3\"N 79°15'22.7\"E", 17.0509, 79.2563],   // spaced
  ["17°03'03.3\"N, 79°15'22.7\"E", 17.0509, 79.2563],  // comma
  ["17°03'03.3\"N79°15'22.7\"E", 17.0509, 79.2563],    // run together
  ['17.0509, 79.2563', 17.0509, 79.2563],              // decimal pair
]) {
  const pin = parseMapLink(text);
  check(text, pin && near(pin.lat, lat) && near(pin.lng, lng), true);
}

console.log('a PDF that draws one coordinate as two strings');
const rows = toRows([
  '1', 'B . Ramu', '9959895510', 'DVK road pickup point', '1 Lit',
  "17°03'03.3\"N", "79°15'22.7\"E",
  '2', 'G Pavani', '7989457364', 'H No : 5-2-5 near clocktower', '750 ML',
  "17°03'24.3\"N", "79°16'05.4\"E",
]);
check('both rows read', rows.length, 2);
check('row 1 keeps its longitude', rows[0]?.pinText, "17°03'03.3\"N, 79°15'22.7\"E");
check('row 1 address is not eaten', rows[0]?.address, 'DVK road pickup point');
check('row 2 keeps its longitude', rows[1]?.pinText, "17°03'24.3\"N, 79°16'05.4\"E");
const single = toRows(['1', 'Solo', '9959895510', 'A street', '1 Lit', '17.0509, 79.2563']);
check('a coordinate drawn as one string still works', single[0]?.pinText, '17.0509, 79.2563');

console.log('a column whose heading nobody predicted');
for (const heading of ['GPS Location', 'Coordinates / Link', 'Where they live']) {
  const csv = `Name,Phone,${heading}\nAnita,9959895510,"17.0509, 79.2563"\nBhavani,9959895511,"17.0600, 79.2600"\n`;
  const parsed = parseCsv(csv);
  check(`"${heading}" still yields pins`, parsed.rows.map((r) => r.pinText), ['17.0509, 79.2563', '17.0600, 79.2600']);
}

console.log(failures === 0 ? '\nall good' : `\n${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
