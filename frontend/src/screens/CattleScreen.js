import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from '../api';
import {
  AddButton,
  Banner,
  Button,
  Card,
  Empty,
  Field,
  FieldRow,
  SectionTitle,
  SummaryRow,
  SummaryTile,
} from '../components';
import DateNav from '../DateNav';
import DeleteButton from '../DeleteButton';
import { useDeleteMode } from '../deleteMode';
import { useNarrow, usePageStyle } from '../layout';
import { NumberCell, tableStyles } from '../tableCells';
import { colors, radius, spacing } from '../theme';

// The herd, on the day it is being milked.
//
// A dairy's other book. The delivery side of this app answers "what goes
// out"; this answers "what comes in, and from which animal". They meet
// at the number on the yellow ear tag, which is what a farmer says out
// loud when something is wrong with a buffalo — so the tag is the first
// column and the identity, here and in the database.
//
// Built as the day board's table is built, because it is read the same
// way: a row per animal, the two milkings typed straight into their
// cells, and a total line at the bottom. The rest of an animal's
// life — where it came from, what it has been crossed with, when it is
// due — is behind its own row, because that is read once a month and the
// milk is read twice a day.
export default function CattleScreen({ token, user }) {
  const pageStyle = usePageStyle(860);
  const { open: canDelete } = useDeleteMode(user);
  const narrow = useNarrow();
  const [day, setDay] = useState(null);
  const [selectedDate, setSelectedDate] = useState('');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [busyCell, setBusyCell] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    try {
      setDay(await api.getHerdDay(token, selectedDate || undefined));
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token, selectedDate]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading) {
    return <ActivityIndicator style={styles.loader} color={colors.accent} />;
  }

  const animals = day?.animals || [];
  const yields = day?.yields || {};
  const due = day?.due || {};
  const date = day?.date;

  const query = search.trim().toLowerCase();
  const shown = query
    ? animals.filter((a) => `${a.tag} ${a.name} ${a.breed}`.toLowerCase().includes(query))
    : animals;

  const onFarm = animals.filter((a) => a.active && a.stage !== 'sold' && a.stage !== 'died');
  const milking = onFarm.filter((a) => a.stage === 'milking');
  const dry = onFarm.filter((a) => a.stage === 'dry');
  // Due inside a month. A date further out is not something anybody does
  // anything about today, and a tile counting it every day is a tile
  // nobody reads on the day it matters.
  const soon = Object.entries(due).filter(([, when]) => withinDays(when, date, 30)).length;

  const totalMilk = animals.reduce((sum, a) => {
    const y = yields[a.id];
    return sum + (y ? (Number(y.morning) || 0) + (Number(y.evening) || 0) : 0);
  }, 0);

  const setSession = async (animal, session, raw) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      return;
    }
    setBusyCell(`${animal.id}:${session}`);
    setError('');
    try {
      await api.setMilkYield(token, animal.id, date, { [session]: value });
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyCell('');
    }
  };

  return (
    <ScrollView contentContainerStyle={pageStyle}>
      <Banner message={error} />
      <Banner message={notice} tone="success" />

      <SummaryRow>
        <SummaryTile label="On the farm" value={String(onFarm.length)} />
        <SummaryTile label="Milking" value={String(milking.length)} note={dry.length > 0 ? `${dry.length} dry` : ''} />
        {soon > 0 ? <SummaryTile label="Due within a month" value={String(soon)} tone="warning" /> : null}
        {totalMilk > 0 ? <SummaryTile label="Milk today" value={round1(totalMilk)} /> : null}
      </SummaryRow>

      <Card>
        <SectionTitle
          right={
            <AddButton
              open={adding}
              onPress={() => setAdding((prev) => !prev)}
              label={adding ? 'Close add an animal' : 'Add an animal'}
            />
          }
        >
          Cattle ({shown.length}
          {shown.length !== animals.length ? ` of ${animals.length}` : ''})
        </SectionTitle>
        <View style={styles.headingDivider} />

        <DateNav date={date} selectedDate={selectedDate} onSelect={setSelectedDate} />

        {adding ? (
          <NewAnimalForm
            token={token}
            onCreated={async (tag) => {
              setNotice(`Tag ${tag} is on the register.`);
              setAdding(false);
              await refresh();
            }}
            onError={setError}
          />
        ) : null}

        {animals.length === 0 ? (
          <Empty>No animals yet.</Empty>
        ) : (
          <>
            <View style={styles.toolsRow}>
              <View style={styles.searchBox}>
                <Text style={styles.searchGlyph}>⌕</Text>
                <input
                  value={search}
                  aria-label="Search the herd"
                  placeholder="Tag, name, or breed"
                  onChange={(event) => setSearch(event.target.value)}
                  style={searchInputStyle}
                />
                {search ? (
                  <Pressable
                    onPress={() => setSearch('')}
                    accessibilityRole="button"
                    accessibilityLabel="Clear the search"
                    style={({ pressed }) => [styles.searchClear, pressed && styles.pressed]}
                  >
                    <Text style={styles.searchClearGlyph}>✕</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>

            {shown.length === 0 ? (
              <Empty>Nothing matches that.</Empty>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.scroller}>
                <View>
                  <View style={[tableStyles.row, tableStyles.head, tableStyles.rule]}>
                    <Text style={[tableStyles.headCell, styles.tagColumn]}>Tag</Text>
                    <Text style={[tableStyles.headCell, styles.nameColumn, narrow && styles.nameColumnNarrow]}>
                      Name
                    </Text>
                    <Text style={[tableStyles.headCell, styles.stageColumn]}>Stage</Text>
                    <Text style={[tableStyles.headCell, tableStyles.figure, styles.milkColumn]}>Morning</Text>
                    <Text style={[tableStyles.headCell, tableStyles.figure, styles.milkColumn]}>Evening</Text>
                    <Text style={[tableStyles.headCell, tableStyles.figure, styles.milkColumn]}>Total</Text>
                    <View style={styles.menuColumn} />
                  </View>

                  {shown.map((animal) => {
                    const open = openId === animal.id;
                    const yield_ = yields[animal.id];
                    const morning = yield_ ? Number(yield_.morning) || 0 : null;
                    const evening = yield_ ? Number(yield_.evening) || 0 : null;
                    const total = (morning || 0) + (evening || 0);
                    const dueOn = due[animal.id];
                    const milks = animal.stage === 'milking';
                    return (
                      <View key={animal.id}>
                        <View style={[tableStyles.row, tableStyles.rule, open && styles.rowOpen]}>
                          <Text style={[styles.tagColumn, styles.tagText]} numberOfLines={1}>
                            {animal.tag}
                          </Text>
                          <View style={[styles.nameColumn, narrow && styles.nameColumnNarrow]}>
                            <Text style={styles.nameText} numberOfLines={1}>
                              {animal.name || '—'}
                            </Text>
                            {/* Breed and species earn their line only
                                where there is room; on a phone the
                                numbers matter more. */}
                            {!narrow && (animal.breed || animal.species) ? (
                              <Text style={styles.breedText} numberOfLines={1}>
                                {[animal.breed, animal.species].filter(Boolean).join(' · ')}
                              </Text>
                            ) : null}
                          </View>
                          <View style={styles.stageColumn}>
                            <Text style={styles.stageText}>{animal.stage}</Text>
                            {/* Only when it is close enough to act on. */}
                            {dueOn && withinDays(dueOn, date, 30) ? (
                              <Text style={styles.dueText}>due {shortDate(dueOn)}</Text>
                            ) : null}
                          </View>

                          {/* Only a milking animal gets boxes. A calf
                              with two empty cells beside it every day is
                              two invitations to type a mistake. */}
                          {milks ? (
                            <>
                              <View style={styles.milkColumn}>
                                <NumberCell
                                  value={morning === null ? '' : String(morning)}
                                  empty="—"
                                  width={68}
                                  busy={busyCell === `${animal.id}:morning`}
                                  ariaLabel={`Morning milk from ${animal.tag}`}
                                  onCommit={(raw) => setSession(animal, 'morning', raw)}
                                />
                              </View>
                              <View style={styles.milkColumn}>
                                <NumberCell
                                  value={evening === null ? '' : String(evening)}
                                  empty="—"
                                  width={68}
                                  busy={busyCell === `${animal.id}:evening`}
                                  ariaLabel={`Evening milk from ${animal.tag}`}
                                  onCommit={(raw) => setSession(animal, 'evening', raw)}
                                />
                              </View>
                            </>
                          ) : (
                            <>
                              <View style={styles.milkColumn} />
                              <View style={styles.milkColumn} />
                            </>
                          )}
                          <Text style={[tableStyles.cell, tableStyles.figure, styles.milkColumn, styles.totalCell]}>
                            {total > 0 ? round1(total) : '—'}
                          </Text>

                          <Pressable
                            onPress={() => setOpenId(open ? null : animal.id)}
                            accessibilityRole="button"
                            accessibilityState={{ expanded: open }}
                            accessibilityLabel={`${open ? 'Close' : 'Open'} ${animal.tag}`}
                            style={({ pressed }) => [styles.menuColumn, styles.menuButton, pressed && styles.pressed]}
                          >
                            <Text style={styles.menuGlyph}>{open ? '▾' : '⋯'}</Text>
                          </Pressable>
                        </View>

                        {open ? (
                          <View style={styles.expanded}>
                            <AnimalCard
                              animal={animal}
                              token={token}
                              canDelete={canDelete}
                              onChanged={refresh}
                              onError={setError}
                              onNotice={setNotice}
                              onGone={() => setOpenId(null)}
                            />
                          </View>
                        ) : null}
                      </View>
                    );
                  })}

                  {totalMilk > 0 ? (
                    <View style={[tableStyles.row, styles.totalsRow]}>
                      <Text style={[styles.tagColumn, styles.totalsLabel]}>{milking.length} milking</Text>
                      <View style={[styles.nameColumn, narrow && styles.nameColumnNarrow]} />
                      <View style={styles.stageColumn} />
                      <Text style={[tableStyles.cell, tableStyles.figure, styles.milkColumn, styles.totalsFigure]}>
                        {round1(sumSession(animals, yields, 'morning'))}
                      </Text>
                      <Text style={[tableStyles.cell, tableStyles.figure, styles.milkColumn, styles.totalsFigure]}>
                        {round1(sumSession(animals, yields, 'evening'))}
                      </Text>
                      <Text style={[tableStyles.cell, tableStyles.figure, styles.milkColumn, styles.totalsFigure]}>
                        {round1(totalMilk)}
                      </Text>
                      <View style={styles.menuColumn} />
                    </View>
                  ) : null}
                </View>
              </ScrollView>
            )}
          </>
        )}
      </Card>
    </ScrollView>
  );
}

function sumSession(animals, yields, session) {
  return animals.reduce((sum, a) => sum + (Number(yields[a.id]?.[session]) || 0), 0);
}

function round1(value) {
  const n = Number(value) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function shortDate(iso) {
  const at = new Date(`${iso}T00:00:00`);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// Whether a date falls within so many days of another. Used for "due
// soon", which is the only form a due date is worth showing in a table.
function withinDays(iso, from, days) {
  if (!iso) {
    return false;
  }
  const when = new Date(`${iso}T00:00:00`).getTime();
  const start = new Date(`${from || new Date().toISOString().slice(0, 10)}T00:00:00`).getTime();
  if (Number.isNaN(when) || Number.isNaN(start)) {
    return false;
  }
  return when >= start && when - start <= days * 24 * 60 * 60 * 1000;
}

const SPECIES = ['buffalo', 'cow'];
const STAGES = ['calf', 'heifer', 'milking', 'dry', 'bull', 'sold', 'died'];

// A new animal. Only the tag is required, and it is first, because on a
// farm entering thirty of them the tag is the only thing anybody has for
// certain — the rest arrives as somebody remembers it.
function NewAnimalForm({ token, onCreated, onError }) {
  const [form, setForm] = useState({ tag: '', name: '', species: 'buffalo', sex: 'female', stage: 'milking' });
  const [busy, setBusy] = useState(false);
  const set = (key) => (value) => setForm((prev) => ({ ...prev, [key]: value }));

  const submit = async () => {
    setBusy(true);
    try {
      await api.createAnimal(token, form);
      const tag = form.tag;
      setForm({ tag: '', name: '', species: form.species, sex: 'female', stage: 'milking' });
      await onCreated(tag);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.inlineForm}>
      <FieldRow>
        <Field label="Tag" size="sm" value={form.tag} onChangeText={set('tag')} placeholder="A-12" />
        <Field label="Name" size="md" value={form.name} onChangeText={set('name')} placeholder="optional" />
      </FieldRow>
      <View style={styles.pickerRow}>
        <Picker label="Species" value={form.species} options={SPECIES} onChange={set('species')} />
        <Picker label="Sex" value={form.sex} options={['female', 'male']} onChange={set('sex')} />
        <Picker label="Stage" value={form.stage} options={STAGES} onChange={set('stage')} />
      </View>
      <Button title="Add to the register" onPress={submit} busy={busy} disabled={!form.tag.trim()} />
    </View>
  );
}

function Picker({ label, value, options, onChange }) {
  return (
    <View style={styles.picker}>
      <Text style={styles.pickerLabel}>{label}</Text>
      <select value={value} aria-label={label} style={pickerStyle} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </View>
  );
}

// One animal's own record: where it came from, and every crossing.
//
// Opened from its row and closed again — this is read when something
// changes, which is monthly, while the milk beside it is read twice a
// day. Docs/DESIGN.md, rule 3.
function AnimalCard({ animal, token, canDelete, onChanged, onError, onNotice, onGone }) {
  const [form, setForm] = useState({
    tag: animal.tag,
    name: animal.name || '',
    species: animal.species,
    sex: animal.sex,
    stage: animal.stage,
    breed: animal.breed || '',
    born_on: animal.born_on || '',
    arrived_on: animal.arrived_on || '',
    source: animal.source || '',
    notes: animal.notes || '',
  });
  const [busy, setBusy] = useState(false);
  const set = (key) => (value) => setForm((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    setBusy(true);
    try {
      await api.updateAnimal(token, animal.id, form);
      onNotice(`Saved ${form.tag}.`);
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={styles.animalCard}>
      <FieldRow>
        <Field label="Tag" size="sm" value={form.tag} onChangeText={set('tag')} />
        <Field label="Name" size="md" value={form.name} onChangeText={set('name')} />
      </FieldRow>
      <View style={styles.pickerRow}>
        <Picker label="Species" value={form.species} options={SPECIES} onChange={set('species')} />
        <Picker label="Sex" value={form.sex} options={['female', 'male']} onChange={set('sex')} />
        <Picker label="Stage" value={form.stage} options={STAGES} onChange={set('stage')} />
      </View>
      <FieldRow>
        <Field label="Breed" size="md" value={form.breed} onChangeText={set('breed')} placeholder="Murrah" />
        <Field label="Born on" size="sm" value={form.born_on} onChangeText={set('born_on')} placeholder="YYYY-MM-DD" />
      </FieldRow>
      <FieldRow>
        {/* Empty means born here, which is a fact rather than a gap —
            see domain.Animal. */}
        <Field
          label="Brought to the farm"
          size="sm"
          value={form.arrived_on}
          onChangeText={set('arrived_on')}
          placeholder="born here"
        />
        <Field label="Bought from" size="md" value={form.source} onChangeText={set('source')} />
      </FieldRow>
      <Field label="Notes" size="md" value={form.notes} onChangeText={set('notes')} />
      <Button title="Save" onPress={save} busy={busy} disabled={!form.tag.trim()} />

      <Crossings animal={animal} token={token} canDelete={canDelete} onError={onError} onChanged={onChanged} />

      <DeleteButton
        armed={canDelete}
        label="Delete this animal"
        describe={async () =>
          `Deleting tag ${animal.tag} takes its crossings and every day of milk recorded against it. Selling or losing an animal is a change of stage instead.`
        }
        onDelete={() => api.deleteAnimal(token, animal.id)}
        onDone={async () => {
          onGone();
          await onChanged();
        }}
        onError={onError}
      />
    </Card>
  );
}

const RESULTS = ['pending', 'pregnant', 'empty', 'aborted', 'calved'];

// Every crossing, newest first, and what came of each.
//
// The log is the point: an animal is served many times over its life,
// and last year's service is how anybody works out whether this one is
// late.
function Crossings({ animal, token, canDelete, onError, onChanged }) {
  const [list, setList] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ crossed_on: today(), method: 'ai', sire: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const body = await api.listBreedings(token, animal.id);
      setList(body.breedings || []);
    } catch (err) {
      onError(err.message);
    }
  }, [token, animal.id, onError]);

  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    setBusy(true);
    try {
      await api.createBreeding(token, animal.id, form);
      setForm({ crossed_on: today(), method: 'ai', sire: '' });
      setAdding(false);
      await load();
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const setResult = async (breeding, changes) => {
    try {
      await api.updateBreeding(token, breeding.id, changes);
      await load();
      await onChanged();
    } catch (err) {
      onError(err.message);
    }
  };

  return (
    <View style={styles.crossings}>
      <View style={styles.crossingsHead}>
        <Text style={styles.crossingsTitle}>Crossings</Text>
        <AddButton
          open={adding}
          onPress={() => setAdding((prev) => !prev)}
          label={adding ? 'Close record a crossing' : 'Record a crossing'}
        />
      </View>

      {adding ? (
        <View style={styles.inlineForm}>
          <FieldRow>
            <Field
              label="Crossed on"
              size="sm"
              value={form.crossed_on}
              onChangeText={(v) => setForm((p) => ({ ...p, crossed_on: v }))}
              placeholder="YYYY-MM-DD"
            />
            <Field
              label="Bull or straw"
              size="md"
              value={form.sire}
              onChangeText={(v) => setForm((p) => ({ ...p, sire: v }))}
              placeholder="Murrah 44"
            />
          </FieldRow>
          <View style={styles.pickerRow}>
            <Picker
              label="How"
              value={form.method}
              options={['ai', 'natural']}
              onChange={(v) => setForm((p) => ({ ...p, method: v }))}
            />
          </View>
          <Button title="Record it" onPress={add} busy={busy} disabled={!form.crossed_on.trim()} />
        </View>
      ) : null}

      {list === null ? null : list.length === 0 ? (
        <Text style={styles.crossingsEmpty}>Nothing recorded yet.</Text>
      ) : (
        list.map((breeding) => (
          <View key={breeding.id} style={styles.crossing}>
            <View style={styles.crossingHead}>
              <Text style={styles.crossingDate}>{shortDate(breeding.crossed_on)}</Text>
              <Text style={styles.crossingMeta} numberOfLines={1}>
                {[breeding.method === 'ai' ? 'AI' : 'natural', breeding.sire].filter(Boolean).join(' · ')}
              </Text>
              {/* The result is the whole point of the row, so it is a
                  picker rather than something to open a form for. */}
              <select
                value={breeding.result}
                aria-label={`Result of the crossing on ${breeding.crossed_on}`}
                style={resultStyle}
                onChange={(event) => setResult(breeding, { result: event.target.value })}
              >
                {RESULTS.map((result) => (
                  <option key={result} value={result}>
                    {result}
                  </option>
                ))}
              </select>
            </View>
            {breeding.due_on ? (
              <Text style={styles.crossingDue}>Due {shortDate(breeding.due_on)}</Text>
            ) : breeding.calved_on ? (
              <Text style={styles.crossingDue}>Calved {shortDate(breeding.calved_on)}</Text>
            ) : null}
            {breeding.result === 'pregnant' || breeding.result === 'pending' ? (
              <Pressable
                onPress={() => setResult(breeding, { calved_on: today() })}
                accessibilityRole="button"
                style={({ pressed }) => [styles.calvedButton, pressed && styles.pressed]}
              >
                <Text style={styles.calvedText}>Calved today</Text>
              </Pressable>
            ) : null}
            {canDelete ? (
              <DeleteButton
                armed
                compact
                label={`Delete the crossing on ${breeding.crossed_on}`}
                describe={async () => 'This removes the record of that crossing.'}
                onDelete={() => api.deleteBreeding(token, breeding.id)}
                onDone={load}
                onError={onError}
              />
            ) : null}
          </View>
        ))
      )}
    </View>
  );
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

const searchInputStyle = {
  flex: 1,
  minWidth: 0,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  paddingTop: spacing.sm,
  paddingBottom: spacing.sm,
  fontSize: 15,
  color: colors.text,
  fontFamily: 'inherit',
};

const pickerStyle = {
  width: '100%',
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: radius.md,
  paddingTop: spacing.sm,
  paddingBottom: spacing.sm,
  paddingLeft: spacing.sm,
  paddingRight: spacing.sm,
  fontSize: 14,
  color: colors.text,
  backgroundColor: colors.surface,
  fontFamily: 'inherit',
};

const resultStyle = {
  ...pickerStyle,
  width: 'auto',
  minWidth: 96,
  paddingTop: 4,
  paddingBottom: 4,
  fontSize: 13,
};

const styles = StyleSheet.create({
  loader: { marginTop: spacing.xl * 2 },
  headingDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginTop: -spacing.sm,
    marginBottom: spacing.md,
  },
  toolsRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  searchBox: {
    flexGrow: 1,
    flexBasis: 220,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.sm,
  },
  searchGlyph: { fontSize: 18, color: colors.hint, marginRight: 2 },
  searchClear: { paddingHorizontal: spacing.xs, paddingVertical: 2 },
  searchClearGlyph: { fontSize: 13, fontWeight: '700', color: colors.subtitle },

  scroller: { flexGrow: 1 },
  tagColumn: { width: 78, paddingHorizontal: spacing.xs },
  tagText: { fontSize: 15, fontWeight: '800', color: colors.text, fontVariant: ['tabular-nums'] },
  nameColumn: { width: 150, paddingHorizontal: spacing.xs, minWidth: 0 },
  nameColumnNarrow: { width: 100 },
  nameText: { fontSize: 14, fontWeight: '600', color: colors.text },
  breedText: { fontSize: 11, color: colors.subtitle, marginTop: 1 },
  stageColumn: { width: 92, paddingHorizontal: spacing.xs },
  stageText: { fontSize: 12, color: colors.subtitle },
  dueText: { fontSize: 11, fontWeight: '700', color: colors.warning, marginTop: 1 },
  milkColumn: { width: 84, alignItems: 'flex-end', paddingHorizontal: spacing.xs, justifyContent: 'center' },
  totalCell: { fontWeight: '700', color: colors.text },
  menuColumn: { width: 40 },
  menuButton: { alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
  menuGlyph: { fontSize: 18, lineHeight: 20, color: colors.link, fontWeight: '700' },
  pressed: { opacity: 0.6 },
  rowOpen: { backgroundColor: colors.surfaceAlt },
  expanded: { width: '100%', maxWidth: 620, paddingVertical: spacing.xs },
  totalsRow: {
    borderTopWidth: 2,
    borderTopColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    paddingVertical: spacing.xs,
  },
  totalsLabel: { fontSize: 12, fontWeight: '700', color: colors.subtitle },
  totalsFigure: { fontSize: 14, fontWeight: '800', color: colors.text },

  inlineForm: { marginBottom: spacing.md },
  pickerRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md, flexWrap: 'wrap' },
  picker: { flexGrow: 1, flexBasis: 120, minWidth: 0 },
  pickerLabel: { fontSize: 13, fontWeight: '600', color: colors.label, marginBottom: spacing.xs },

  animalCard: { marginBottom: 0 },
  crossings: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md },
  crossingsHead: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  crossingsTitle: { flex: 1, fontSize: 15, fontWeight: '700', color: colors.text },
  crossingsEmpty: { fontSize: 13, color: colors.hint },
  crossing: { borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: spacing.sm },
  crossingHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  crossingDate: { fontSize: 14, fontWeight: '700', color: colors.text },
  crossingMeta: { flex: 1, minWidth: 80, fontSize: 12, color: colors.subtitle },
  crossingDue: { fontSize: 12, fontWeight: '600', color: colors.warning, marginTop: 2 },
  calvedButton: { alignSelf: 'flex-start', paddingVertical: 5, marginTop: spacing.xs },
  calvedText: { fontSize: 13, fontWeight: '700', color: colors.link },
});
