import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from './api';
import { Banner, Button, Dialog } from './components';
import { parseCsv, parseDays, parseItems } from './csv';
import { lower } from './labels';
import { parseMapLink } from './mapLinks';
import { looksLikePdf, parsePdfList } from './pdfList';
import { colors, radius, spacing } from './theme';

// Bringing an existing customer list in.
//
// Nobody starts a delivery business the day they install this. They
// arrive with a list — a spreadsheet, a notebook someone typed up, a PDF
// a previous system printed — and the first hour with a new product is
// otherwise spent retyping it. The first real business onboarded here had
// thirty-four households; the next will have more.
//
// The preview is the point, not a nicety. Two of those thirty-four rows
// needed a human: one had no pin at all and one had a shortened map link
// that cannot be resolved. A file that silently imported thirty-two and
// said nothing would leave two customers who never get delivered to, and
// nobody would find out until somebody rang up.
//
// So: paste or pick a file, see exactly what each row will become, then
// commit. The server does the deciding — it knows which products exist
// and who is already on the list — and answers the same way for the
// preview as for the real thing, because it is the same call with a flag.
export default function ImportCustomersDialog({
  open,
  onClose,
  token,
  labels,
  home,
  areas = [],
  // Opened from a service route's own card, which is the common case:
  // a file is somebody's morning list, so it belongs to that round.
  serviceAreaId = '',
  onImported,
}) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const [routeId, setRouteId] = useState(serviceAreaId);

  // The dialog outlives any one opening of it, so the round it was
  // opened from has to be re-read each time rather than captured once.
  // Only on the way open: changing it mid-import would move the file
  // out from under the preview.
  useEffect(() => {
    if (open) {
      setRouteId(serviceAreaId);
    }
  }, [open, serviceAreaId]);

  const reset = () => {
    setText('');
    setPreview(null);
    setRows([]);
    setError('');
    setDone(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  // Turns the file's text into the rows the server takes. The pin is
  // resolved here rather than server-side because this is where the one
  // parser lives that understands a Google link, a plus code and
  // 17°03'24.3"N — see mapLinks.js.
  const build = (parsed) =>
    parsed.map((row) => {
      const pin = row.pinText ? parseMapLink(row.pinText, home) : null;
      return {
        line: row.line,
        name: row.name,
        phone: row.phone,
        address: row.address,
        notes: row.notes,
        lat: pin ? pin.lat : 0,
        lng: pin ? pin.lng : 0,
        items: parseItems(row.itemsText),
        weekdays: parseDays(row.daysText),
        // Kept for the preview only: a row whose pin text did not parse
        // is worth flagging even though the import will accept it.
        pinText: row.pinText,
        pinned: !!pin,
      };
    });

  const look = async (parsed) => {
    setError('');
    setDone(null);
    const built = build(parsed);
    if (built.length === 0) {
      setError('No rows in that. Paste the list, or pick a CSV or PDF.');
      setPreview(null);
      return;
    }
    setRows(built);
    setBusy(true);
    try {
      setPreview(await api.importCustomers(token, built.map(forServer), true, routeId));
    } catch (err) {
      setError(err.message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.importCustomers(token, rows.map(forServer), false, routeId);
      setDone(result);
      setPreview(result);
      await onImported();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // A PDF is read as bytes and a spreadsheet as text, and both come out
  // as the same rows — see pdfList.js. The office keeps its list as a
  // printed sheet far more often than as a .csv, and asking somebody to
  // retype thirty-nine households into a spreadsheet before they can
  // start is most of the reason they would not start.
  const pickFile = (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) {
      return;
    }
    const reader = new FileReader();
    if (looksLikePdf(file)) {
      reader.onload = async () => {
        setBusy(true);
        setError('');
        try {
          const { rows: found, reason } = await parsePdfList(reader.result);
          if (reason) {
            setError(
              reason === 'nothing-readable'
                ? 'Nothing readable in that PDF. If it is a scan, the text is a picture — save the list as a CSV instead.'
                : 'No delivery rows found. Each row needs a number, a name, a phone and a quantity.',
            );
            setPreview(null);
            return;
          }
          setText('');
          await look(found);
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      };
      reader.readAsArrayBuffer(file);
      return;
    }
    reader.onload = () => {
      const raw = String(reader.result || '');
      setText(raw);
      look(parseCsv(raw).rows);
    };
    reader.readAsText(file);
  };

  const byVerdict = (verdict) => (preview?.results || []).filter((r) => r.verdict === verdict);
  // Two different facts, one verdict. A row skipped because the file
  // lists the household twice is not a row skipped because the household
  // is already a customer — and against an empty roster, only one of
  // those two sentences can be true. See customerimport.go.
  // Three things wear the "duplicate" verdict now, and they ask
  // different things of the reader: somebody already here with nothing
  // to add, somebody already here whose missing pin this file carries,
  // and a household the file lists twice.
  const fillingPins = byVerdict('duplicate').filter((r) => r.fills_pin);
  const alreadyOnList = byVerdict('duplicate').filter((r) => !r.in_file && !r.fills_pin);
  const repeatedInFile = byVerdict('duplicate').filter((r) => r.in_file);
  // Only the rows actually going in. Warning about a missing pin on a
  // customer who is already here — and already has one — is a warning
  // about nothing, which is how people learn to ignore them.
  const unpinned = byVerdict('new').filter((r) => rows[r.row - 1] && !rows[r.row - 1].pinned);

  // Filling in a pin is work, so the button has to offer it. A file of
  // people who are all already customers — the same list re-imported now
  // that their coordinates can be read — adds nobody and still has 49
  // pins to give out, and the button read "Nothing to add" and refused
  // to press. It was describing one half of what it does.
  const commitLabel = (() => {
    const adding = preview?.new || 0;
    const pins = fillingPins.length;
    const pinPhrase = pins === 1 ? 'the missing pin' : `${pins} missing pins`;
    if (adding > 0 && pins > 0) {
      return `Add ${adding} and fill in ${pinPhrase}`;
    }
    if (adding > 0) {
      return `Add ${adding === 1 ? 'this one' : `these ${adding}`}`;
    }
    if (pins > 0) {
      return `Fill in ${pinPhrase}`;
    }
    return 'Nothing to do';
  })();

  return (
    <Dialog open={open} onClose={close} title={`Import ${lower(labels.customer_plural)}`}>
      <Banner message={error} />

      {!preview ? (
        <View>
          {/* Short, because the next screen does the teaching. This
              dialog has a preview: whatever the file turns out to be,
              it says so row by row before anything is written — so an
              essay about accepted formats up front is explaining a
              thing the reader is about to be shown. See
              Docs/DESIGN.md. */}
          <Text style={styles.note}>Your delivery list, as a PDF or a CSV — or paste the columns in.</Text>
          <Text style={styles.columns}>
            name · phone · address · what they take · where they live{'\n'}
            <Text style={styles.columnsHint}>days and notes optional</Text>
          </Text>

          {/* Which round the file is. Almost every list is one — the
              morning round, written down — and saying so here is what
              puts a customer whose pin is missing on a round at all,
              rather than in "we don't know where they live". */}
          {areas.length > 0 ? (
            <View style={styles.routeBlock}>
              <Text style={styles.routeLabel}>Put them all on</Text>
              <select value={routeId} style={routeSelectStyle} onChange={(event) => setRouteId(event.target.value)}>
                <option value="">Let each pin decide</option>
                {areas
                  .filter((area) => area.active !== false)
                  .map((area) => (
                    <option key={area.id} value={area.id}>
                      {area.name}
                    </option>
                  ))}
              </select>
              <Text style={styles.routeHint}>
                {routeId
                  ? `Everyone joins it, pin or no pin — the ${lower(labels.driver)} pins the rest at the door.`
                  : `Only rows with a location will land on a ${lower(labels.route)}.`}
              </Text>
            </View>
          ) : null}

          <input
            type="file"
            accept=".csv,.tsv,.txt,.pdf,text/csv,text/plain,application/pdf"
            onChange={pickFile}
            style={fileInputStyle}
          />

          <Text style={styles.or}>or paste</Text>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={'Name,Phone,Address,Quantity,Coordinates\nG Pavani,7989457364,Near clocktower nalgonda,750 ML,"17°03\'24.3\\"N 79°16\'05.4\\"E"'}
            rows={7}
            style={textAreaStyle}
          />
          <Button
            title="Show me what this will do"
            onPress={() => look(parseCsv(text).rows)}
            busy={busy}
            disabled={!text.trim()}
          />
        </View>
      ) : (
        <View>
          {/* The counts first, because that is the decision. The table
              below is for the rows that need a person. */}
          <View style={styles.tallies}>
            <Tally n={preview.new} label={done ? 'added' : 'will be added'} tone="good" />
            {fillingPins.length > 0 ? (
              <Tally n={fillingPins.length} label={done ? 'given a pin' : 'will get a pin'} tone="good" />
            ) : null}
            {alreadyOnList.length > 0 ? (
              <Tally n={alreadyOnList.length} label="already here" tone="quiet" />
            ) : null}
            {repeatedInFile.length > 0 ? (
              <Tally n={repeatedInFile.length} label="twice in the file" tone="quiet" />
            ) : null}
            {preview.failed > 0 ? <Tally n={preview.failed} label={done ? 'failed' : "can't be added"} tone="bad" /> : null}
          </View>

          {/* What happens to the ones with no location depends entirely
              on whether a round was chosen, so the warning has to say
              which. Told they "cannot go on a route" while they are in
              fact going on one is worse than saying nothing. */}
          {!done && unpinned.length > 0 ? (
            <Text style={styles.warn}>
              {unpinned.length === 1 ? '1 row has' : `${unpinned.length} rows have`} no location this can read.{' '}
              {routeId
                ? `They still join the ${lower(labels.route)} — at the end of it, until somebody drops a pin at the door.`
                : `They will be added without a pin, and cannot go on a ${lower(labels.route)} until someone drops one.`}
            </Text>
          ) : null}

          {byVerdict('error').length > 0 ? (
            <View style={styles.block}>
              <Text style={styles.heading}>{done ? 'These did not go in' : 'These cannot go in yet'}</Text>
              <ScrollView style={styles.list}>
                {byVerdict('error').map((r) => (
                  <View key={r.row} style={styles.row}>
                    <Text style={styles.rowNum}>{r.row}</Text>
                    <View style={styles.rowText}>
                      <Text style={styles.rowName}>{r.name || '(no name)'}</Text>
                      <Text style={styles.rowProblem}>{r.problem}</Text>
                    </View>
                  </View>
                ))}
              </ScrollView>
            </View>
          ) : null}

          {fillingPins.length > 0 ? (
            <View style={styles.block}>
              <Text style={styles.heading}>
                {done ? 'Given the pin they were missing' : 'Getting the pin they were missing'}
              </Text>
              <Text style={styles.note}>
                Already on the list, with no location on record. This file has one, so it fills the blank — a pin
                somebody placed by hand is never overwritten.
              </Text>
              <Text style={styles.names}>{fillingPins.map((r) => r.name).join(', ')}</Text>
            </View>
          ) : null}

          {alreadyOnList.length > 0 ? (
            <View style={styles.block}>
              <Text style={styles.heading}>Already on the list</Text>
              <Text style={styles.note}>
                Skipped, not doubled — so running the same file again finishes it rather than repeating it.
              </Text>
              <Text style={styles.names}>{alreadyOnList.map((r) => r.name).join(', ')}</Text>
            </View>
          ) : null}

          {repeatedInFile.length > 0 ? (
            <View style={styles.block}>
              <Text style={styles.heading}>Listed twice in this file</Text>
              <Text style={styles.note}>
                The same name and number appear more than once, so they go in once. Nothing to fix unless they are
                genuinely two different people — then give them different numbers.
              </Text>
              <Text style={styles.names}>{repeatedInFile.map((r) => r.name).join(', ')}</Text>
            </View>
          ) : null}

          {!done && byVerdict('new').length > 0 ? (
            <View style={styles.block}>
              <Text style={styles.heading}>Ready to add</Text>
              <ScrollView style={styles.list}>
                {byVerdict('new').map((r) => {
                  // The server answers per row in the order it was sent,
                  // so row N of the result is row N of what we built —
                  // which is where the pin status lives.
                  const row = rows[r.row - 1];
                  return (
                    <View key={r.row} style={styles.row}>
                      <Text style={styles.rowNum}>{r.row}</Text>
                      <View style={styles.rowText}>
                        <Text style={styles.rowName}>{r.name}</Text>
                        <Text style={styles.rowMeta}>
                          {(r.matched || []).join(' · ') || 'nothing ordered yet'}
                          {row && !row.pinned ? ' · no pin' : ''}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
            </View>
          ) : null}

          <View style={styles.actions}>
            {done ? (
              <Button title="Done" onPress={close} />
            ) : (
              <>
                <Button
                  title={commitLabel}
                  onPress={commit}
                  busy={busy}
                  disabled={preview.new === 0 && fillingPins.length === 0}
                  style={styles.flexButton}
                />
                <Button title="Back" variant="secondary" onPress={() => setPreview(null)} style={styles.flexButton} />
              </>
            )}
          </View>
        </View>
      )}
    </Dialog>
  );
}

function Tally({ n, label, tone }) {
  return (
    <View style={[styles.tally, tone === 'good' && styles.tallyGood, tone === 'bad' && styles.tallyBad]}>
      <Text style={[styles.tallyNum, tone === 'good' && styles.tallyNumGood, tone === 'bad' && styles.tallyNumBad]}>
        {n}
      </Text>
      <Text style={styles.tallyLabel}>{label}</Text>
    </View>
  );
}

// Only what the server needs; the preview's own flags stay here.
function forServer(row) {
  return {
    name: row.name,
    phone: row.phone,
    address: row.address,
    notes: row.notes,
    lat: row.lat,
    lng: row.lng,
    items: row.items,
    weekdays: row.weekdays,
  };
}

const routeSelectStyle = {
  width: '100%',
  boxSizing: 'border-box',
  borderWidth: 1,
  borderStyle: 'solid',
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

const fileInputStyle = {
  display: 'block',
  width: '100%',
  marginBottom: spacing.sm,
  fontFamily: 'inherit',
  fontSize: 13,
  color: colors.text,
};

const textAreaStyle = {
  width: '100%',
  boxSizing: 'border-box',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: colors.border,
  borderRadius: radius.md,
  padding: spacing.sm,
  fontSize: 13,
  fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
  color: colors.text,
  backgroundColor: colors.surface,
  marginBottom: spacing.sm,
  resize: 'vertical',
};

const styles = StyleSheet.create({
  note: { fontSize: 13, color: colors.subtitle, lineHeight: 18, marginBottom: spacing.sm },
  routeBlock: { marginBottom: spacing.md },
  routeLabel: { fontSize: 13, fontWeight: '600', color: colors.label, marginBottom: 3 },
  routeHint: { fontSize: 12, color: colors.hint, marginTop: 3, lineHeight: 16 },
  columns: { fontSize: 13, fontWeight: '700', color: colors.text, marginBottom: spacing.md, lineHeight: 19 },
  columnsHint: { fontSize: 12, fontWeight: '400', color: colors.hint, lineHeight: 17 },
  or: { fontSize: 12, color: colors.hint, marginBottom: spacing.xs },
  tallies: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md, flexWrap: 'wrap' },
  tally: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    minWidth: 96,
  },
  tallyGood: { backgroundColor: colors.surfaceAlt },
  tallyBad: { backgroundColor: colors.warningBg },
  tallyNum: { fontSize: 22, fontWeight: '800', color: colors.text },
  tallyNumGood: { color: colors.accent },
  tallyNumBad: { color: colors.warning },
  tallyLabel: { fontSize: 12, color: colors.subtitle },
  warn: { fontSize: 13, color: colors.warning, lineHeight: 18, marginBottom: spacing.md },
  block: { marginBottom: spacing.md },
  heading: { fontSize: 13, fontWeight: '700', color: colors.label, marginBottom: spacing.xs },
  names: { fontSize: 13, color: colors.subtitle, lineHeight: 18 },
  list: { maxHeight: 220 },
  row: { flexDirection: 'row', gap: spacing.sm, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowNum: { fontSize: 12, color: colors.hint, minWidth: 24 },
  rowText: { flex: 1 },
  rowName: { fontSize: 13, fontWeight: '600', color: colors.text },
  rowMeta: { fontSize: 12, color: colors.subtitle },
  rowProblem: { fontSize: 12, color: colors.warning },
  actions: { flexDirection: 'row', gap: spacing.sm },
  flexButton: { flex: 1 },
});
