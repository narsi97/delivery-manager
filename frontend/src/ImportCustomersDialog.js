import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from './api';
import { Banner, Button, Dialog } from './components';
import { parseCsv, parseDays, parseItems } from './csv';
import { lower } from './labels';
import { parseMapLink } from './mapLinks';
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
export default function ImportCustomersDialog({ open, onClose, token, labels, home, onImported }) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);

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
  const build = (raw) => {
    const { rows: parsed } = parseCsv(raw);
    return parsed.map((row) => {
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
  };

  const look = async (raw) => {
    setError('');
    setDone(null);
    const built = build(raw);
    if (built.length === 0) {
      setError('There are no rows in that. Paste the list, or pick a .csv file.');
      setPreview(null);
      return;
    }
    setRows(built);
    setBusy(true);
    try {
      setPreview(await api.importCustomers(token, built.map(forServer), true));
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
      const result = await api.importCustomers(token, rows.map(forServer), false);
      setDone(result);
      setPreview(result);
      await onImported();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const pickFile = (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result || '');
      setText(raw);
      look(raw);
    };
    reader.readAsText(file);
  };

  const byVerdict = (verdict) => (preview?.results || []).filter((r) => r.verdict === verdict);
  // Only the rows actually going in. Warning about a missing pin on a
  // customer who is already here — and already has one — is a warning
  // about nothing, which is how people learn to ignore them.
  const unpinned = byVerdict('new').filter((r) => rows[r.row - 1] && !rows[r.row - 1].pinned);

  return (
    <Dialog open={open} onClose={close} title={`Import ${lower(labels.customer_plural)}`}>
      <Banner message={error} />

      {!preview ? (
        <View>
          <Text style={styles.note}>
            A spreadsheet saved as CSV, or the columns pasted straight in. Commas or tabs, with or without a header
            row.
          </Text>
          <Text style={styles.columns}>
            name · phone · address · what they take · where they live{'\n'}
            <Text style={styles.columnsHint}>
              plus optional delivery days and notes. The location can be a Google link, a plus code, or coordinates in
              degrees — whatever the list already holds.
            </Text>
          </Text>

          <input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" onChange={pickFile} style={fileInputStyle} />

          <Text style={styles.or}>or paste it here</Text>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={'Name,Phone,Address,Quantity,Coordinates\nG Pavani,7989457364,Near clocktower nalgonda,750 ML,"17°03\'24.3\\"N 79°16\'05.4\\"E"'}
            rows={7}
            style={textAreaStyle}
          />
          <Button title="Show me what this will do" onPress={() => look(text)} busy={busy} disabled={!text.trim()} />
        </View>
      ) : (
        <View>
          {/* The counts first, because that is the decision. The table
              below is for the rows that need a person. */}
          <View style={styles.tallies}>
            <Tally n={preview.new} label={done ? 'added' : 'will be added'} tone="good" />
            {preview.skipped > 0 ? <Tally n={preview.skipped} label="already here" tone="quiet" /> : null}
            {preview.failed > 0 ? <Tally n={preview.failed} label={done ? 'failed' : "can't be added"} tone="bad" /> : null}
          </View>

          {!done && unpinned.length > 0 ? (
            <Text style={styles.warn}>
              {unpinned.length === 1 ? '1 row has' : `${unpinned.length} rows have`} no location this can read. They
              will be added without a pin, and cannot go on a {lower(labels.route)} until someone drops one.
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

          {byVerdict('duplicate').length > 0 ? (
            <View style={styles.block}>
              <Text style={styles.heading}>Already on the list</Text>
              <Text style={styles.note}>
                Skipped, not doubled — so running the same file again finishes it rather than repeating it.
              </Text>
              <Text style={styles.names}>{byVerdict('duplicate').map((r) => r.name).join(', ')}</Text>
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
                  title={preview.new === 0 ? 'Nothing to add' : `Add ${preview.new === 1 ? 'this one' : `these ${preview.new}`}`}
                  onPress={commit}
                  busy={busy}
                  disabled={preview.new === 0}
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
