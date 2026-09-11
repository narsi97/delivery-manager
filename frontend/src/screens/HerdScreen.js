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
  ViewToggle,
} from '../components';
import DeleteButton from '../DeleteButton';
import { useDeleteMode } from '../deleteMode';
import {
  addDays,
  COMMON_VACCINES,
  dueSoonCount,
  HEALTH_KINDS,
  Picker,
  RESULTS,
  resultStyle,
  round1,
  SearchBox,
  SEXES,
  shortDate,
  SPECIES,
  stageForSex,
  stagesFor,
  today,
  WITHDRAWAL_DAYS,
  withinDays,
} from '../herd';
import { usePageStyle } from '../layout';
import { colors, spacing } from '../theme';

// The herd register: who is on the farm, and what came of each crossing.
//
// The other half of the livestock book, and the half that is *not* about
// a date. An animal's breed, where it was bought and what it was served
// with are facts about the animal — they used to sit behind a row
// expander on the milking sheet, under a header reading "8 September",
// which both misfiled them and hid them. This screen has no date at all.
//
// Read when something changes rather than every morning, which is why it
// is a list of cards to open rather than a table to type into.
export default function HerdScreen({ token, user, onScroll }) {
  const pageStyle = usePageStyle(760);
  const { open: canDelete } = useDeleteMode(user);
  const [day, setDay] = useState(null);
  const [health, setHealth] = useState(null);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // herd/day carries the animals and their due dates in one request.
  // The yields alongside them go unread here — one request that fetches
  // a little extra beats a second endpoint returning a subset.
  const refresh = useCallback(async () => {
    try {
      const [nextDay, nextHealth] = await Promise.all([api.getHerdDay(token), api.getHealthDue(token)]);
      setDay(nextDay);
      setHealth(nextHealth);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading) {
    return <ActivityIndicator style={styles.loader} color={colors.accent} />;
  }

  const animals = day?.animals || [];
  const due = day?.due || {};
  const date = day?.date;

  const query = search.trim().toLowerCase();
  const shown = query
    ? animals.filter((a) => `${a.tag} ${a.name} ${a.breed}`.toLowerCase().includes(query))
    : animals;

  const onFarm = animals.filter((a) => a.active && a.stage !== 'sold' && a.stage !== 'died');
  const milking = onFarm.filter((a) => a.stage === 'milking');
  const dry = onFarm.filter((a) => a.stage === 'dry');
  const soon = dueSoonCount(due, date);
  const healthDue = health?.due || [];
  const overdue = healthDue.filter((item) => item.overdue).length;

  return (
    <ScrollView contentContainerStyle={pageStyle} onScroll={onScroll} scrollEventThrottle={16}>
      <Banner message={error} />
      <Banner message={notice} tone="success" />

      {/* What the herd owes. Derived from the health book rather than
          stored, so giving the next dose is what clears it — there is no
          notice to dismiss and nothing that can disagree with the
          record. */}
      {healthDue.length > 0 ? (
        <Banner
          tone="info"
          message={overdue > 0 ? `${overdue} overdue` : 'Coming up'}
          count={healthDue.length}
        >
          <View style={styles.dueList}>
            {healthDue.map((item) => (
              <View key={`${item.animal_id}-${item.name}`} style={styles.dueRow}>
                <Text style={styles.dueTag}>{item.animal_tag}</Text>
                <Text style={styles.dueWhat} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={item.overdue ? styles.dueOverdue : styles.dueWhen}>
                  {item.overdue ? 'overdue ' : ''}
                  {shortDate(item.due_on)}
                </Text>
              </View>
            ))}
          </View>
        </Banner>
      ) : null}

      <SummaryRow>
        <SummaryTile label="On the farm" value={String(onFarm.length)} />
        <SummaryTile label="Milking" value={String(milking.length)} note={dry.length > 0 ? `${dry.length} dry` : ''} />
        {soon > 0 ? <SummaryTile label="Due within a month" value={String(soon)} tone="warning" /> : null}
      </SummaryRow>

      <VaccinationRound token={token} onError={setError} onNotice={setNotice} onChanged={refresh} />

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
          Herd ({shown.length}
          {shown.length !== animals.length ? ` of ${animals.length}` : ''})
        </SectionTitle>
        <View style={styles.headingDivider} />

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
              <SearchBox
                value={search}
                onChange={setSearch}
                label="Search the herd"
                placeholder="Tag, name, or breed"
              />
            </View>

            {shown.length === 0 ? (
              <Empty>Nothing matches that.</Empty>
            ) : (
              shown.map((animal) => {
                const open = openId === animal.id;
                const dueOn = due[animal.id];
                return (
                  <View key={animal.id}>
                    <Pressable
                      onPress={() => setOpenId(open ? null : animal.id)}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: open }}
                      accessibilityLabel={`${open ? 'Close' : 'Open'} ${animal.tag}`}
                      style={({ pressed }) => [styles.row, open && styles.rowOpen, pressed && styles.pressed]}
                    >
                      <Text style={styles.tagText} numberOfLines={1}>
                        {animal.tag}
                      </Text>
                      <View style={styles.rowMiddle}>
                        <Text style={styles.nameText} numberOfLines={1}>
                          {animal.name || '—'}
                        </Text>
                        {animal.breed || animal.species ? (
                          <Text style={styles.breedText} numberOfLines={1}>
                            {[animal.breed, animal.species].filter(Boolean).join(' · ')}
                          </Text>
                        ) : null}
                      </View>
                      <View style={styles.rowEnd}>
                        <Text style={styles.stageText}>{animal.stage}</Text>
                        {dueOn && withinDays(dueOn, date, 30) ? (
                          <Text style={styles.dueText}>due {shortDate(dueOn)}</Text>
                        ) : null}
                      </View>
                      <Text style={styles.menuGlyph}>{open ? '▾' : '⋯'}</Text>
                    </Pressable>

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
              })
            )}
          </>
        )}
      </Card>

      <Production token={token} onError={setError} />
    </ScrollView>
  );
}

// A new animal. Only the tag is required, and it is first, because on a
// farm entering thirty of them the tag is the only thing anybody has for
// certain — the rest arrives as somebody remembers it.
function NewAnimalForm({ token, onCreated, onError }) {
  const [form, setForm] = useState({ tag: '', name: '', species: 'buffalo', sex: 'female', stage: 'milking' });
  const [busy, setBusy] = useState(false);
  const set = (key) => (value) => setForm((prev) => ({ ...prev, [key]: value }));
  // Changing the sex takes the stage with it: there is no such thing as
  // a milking male, and leaving the old value would post a combination
  // the server refuses.
  const setSex = (sex) => setForm((prev) => ({ ...prev, sex, stage: stageForSex(prev.stage, sex) }));

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
        <Picker label="Sex" value={form.sex} options={SEXES} onChange={setSex} />
        <Picker label="Stage" value={form.stage} options={stagesFor(form.sex)} onChange={set('stage')} />
      </View>
      <Button title="Add to the register" onPress={submit} busy={busy} disabled={!form.tag.trim()} />
    </View>
  );
}

// One animal's own record: where it came from, and every crossing.
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
  const setSex = (sex) => setForm((prev) => ({ ...prev, sex, stage: stageForSex(prev.stage, sex) }));

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
        <Picker label="Sex" value={form.sex} options={SEXES} onChange={setSex} />
        <Picker label="Stage" value={form.stage} options={stagesFor(form.sex)} onChange={set('stage')} />
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

      {/* A crossing is recorded against the dam; a bull's part is his
          tag in the sire field of hers. So a male animal has no
          crossings of his own to show. */}
      {form.sex === 'male' ? null : (
        <Crossings animal={animal} token={token} canDelete={canDelete} onError={onError} onChanged={onChanged} />
      )}

      {/* Health applies to every animal — a bull needs his jabs too. */}
      <HealthBook animal={animal} token={token} canDelete={canDelete} onError={onError} onChanged={onChanged} />

      <FlagForAttention animal={animal} token={token} onError={onError} onNotice={onNotice} onChanged={onChanged} />

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

// Every jab, drench, treatment and vet visit for one animal.
//
// Same shape as the crossings above it, for the same reason: these are
// things that happened on days, and last year's is how anybody works out
// whether this year's is late. Recording a vaccination schedules the
// next one from its name (FMD every six months, HS and BQ annually), so
// nobody does that arithmetic standing in a shed.
function HealthBook({ animal, token, canDelete, onError, onChanged }) {
  const [list, setList] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ kind: 'vaccination', name: 'FMD', date: today(), vet: '', batch: '', notes: '' });
  const [withdrawal, setWithdrawal] = useState(0);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const body = await api.listHealthEvents(token, animal.id);
      setList(body.events || []);
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
      await api.createHealthEvent(token, animal.id, {
        ...form,
        // Only a treatment holds milk back, and only when somebody said
        // how long. The label on the bottle is the authority; this just
        // saves counting days on a calendar.
        milk_withheld_until:
          form.kind === 'treatment' && withdrawal > 0 ? addDays(form.date, withdrawal) : '',
      });
      setForm({ kind: form.kind, name: '', date: today(), vet: '', batch: '', notes: '' });
      setWithdrawal(0);
      setAdding(false);
      await load();
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.crossings}>
      <View style={styles.crossingsHead}>
        <Text style={styles.crossingsTitle}>Health</Text>
        <AddButton
          open={adding}
          onPress={() => setAdding((prev) => !prev)}
          label={adding ? 'Close record a health event' : 'Record a health event'}
        />
      </View>

      {adding ? (
        <View style={styles.inlineForm}>
          <View style={styles.pickerRow}>
            <Picker
              label="What"
              value={form.kind}
              options={HEALTH_KINDS}
              onChange={(v) => setForm((p) => ({ ...p, kind: v, name: v === 'vaccination' ? 'FMD' : '' }))}
            />
            {/* The common jabs are a list because they are the ones that
                schedule their own next dose. Anything else is typed. */}
            {form.kind === 'vaccination' ? (
              <Picker
                label="Vaccine"
                value={COMMON_VACCINES.includes(form.name) ? form.name : COMMON_VACCINES[0]}
                options={COMMON_VACCINES}
                onChange={(v) => setForm((p) => ({ ...p, name: v }))}
              />
            ) : null}
          </View>
          {form.kind === 'vaccination' ? null : (
            <Field
              label={form.kind === 'treatment' ? 'What was treated' : 'What was done'}
              size="md"
              value={form.name}
              onChangeText={(v) => setForm((p) => ({ ...p, name: v }))}
              placeholder={form.kind === 'treatment' ? 'mastitis' : 'Ivermectin'}
            />
          )}
          <FieldRow>
            <Field
              label="On"
              size="sm"
              value={form.date}
              onChangeText={(v) => setForm((p) => ({ ...p, date: v }))}
              placeholder="YYYY-MM-DD"
            />
            <Field
              label="Vet"
              size="md"
              value={form.vet}
              onChangeText={(v) => setForm((p) => ({ ...p, vet: v }))}
              placeholder="optional"
            />
          </FieldRow>
          {form.kind === 'vaccination' ? (
            <Field
              label="Batch"
              size="md"
              value={form.batch}
              onChangeText={(v) => setForm((p) => ({ ...p, batch: v }))}
              placeholder="on the vial — worth keeping"
            />
          ) : null}
          {/* Milk withdrawal is the one field here that can hurt
              somebody. Only a treatment gets it. */}
          {form.kind === 'treatment' ? (
            <View style={styles.pickerRow}>
              <Picker
                label="Hold her milk for"
                value={String(withdrawal)}
                options={WITHDRAWAL_DAYS.map((w) => String(w.days))}
                onChange={(v) => setWithdrawal(Number(v))}
              />
              <View style={styles.withdrawalNote}>
                <Text style={styles.withdrawalText}>
                  {withdrawal > 0
                    ? `Her milk is marked unusable through ${addDays(form.date, withdrawal)}.`
                    : 'Her milk keeps going in the churn.'}
                </Text>
              </View>
            </View>
          ) : null}
          <Field
            label="Notes"
            size="md"
            value={form.notes}
            onChangeText={(v) => setForm((p) => ({ ...p, notes: v }))}
          />
          <Button title="Record it" onPress={add} busy={busy} disabled={!form.name.trim() || !form.date.trim()} />
        </View>
      ) : null}

      {list === null ? null : list.length === 0 ? (
        <Text style={styles.crossingsEmpty}>Nothing recorded yet.</Text>
      ) : (
        list.map((event) => (
          <View key={event.id} style={styles.crossing}>
            <View style={styles.crossingHead}>
              <Text style={styles.crossingDate}>{shortDate(event.date)}</Text>
              <Text style={styles.crossingMeta} numberOfLines={1}>
                {[event.kind, event.name, event.vet].filter(Boolean).join(' \u00b7 ')}
              </Text>
            </View>
            {event.next_due_on ? (
              <Text style={styles.crossingDue}>Next due {shortDate(event.next_due_on)}</Text>
            ) : null}
            {event.milk_withheld_until ? (
              <Text style={styles.holdText}>Milk held back to {shortDate(event.milk_withheld_until)}</Text>
            ) : null}
            {event.notes ? <Text style={styles.eventNotes}>{event.notes}</Text> : null}
            {canDelete ? (
              <DeleteButton
                armed
                compact
                label={`Delete the record from ${event.date}`}
                describe={async () => 'This removes that health record.'}
                onDelete={() => api.deleteHealthEvent(token, event.id)}
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

// Raising an alert by hand.
//
// The milk detector only knows what went in the can, and it needs five
// days of history before it will say anything at all. Somebody standing
// in the shed can see a limp, a swollen udder or an animal off her feed
// today — this is where that goes, and it lands in the same list on the
// milking sheet as an automatic one, to be answered the same way.
function FlagForAttention({ animal, token, onError, onNotice, onChanged }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const raise = async () => {
    setBusy(true);
    try {
      await api.createHerdAlert(token, animal.id, note);
      setNote('');
      onNotice(`Flagged ${animal.tag} — it is on the milking sheet now.`);
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.crossings}>
      <Text style={styles.crossingsTitle}>Flag for attention</Text>
      <Field
        label="What did you notice?"
        size="full"
        value={note}
        onChangeText={setNote}
        placeholder="limping on the near hind"
      />
      <Button title="Flag her" variant="secondary" onPress={raise} busy={busy} disabled={!note.trim()} />
    </View>
  );
}

// A vaccination round: one jab, the whole farm, one action.
//
// This is a herd event, not an animal event — the vet comes on a Tuesday
// and does everything on the farm. Recording it animal by animal was
// twenty passes through a form on a phone in a shed, which is how a herd
// book stops being kept by the second month.
//
// Folded away by default. It happens twice a year, and a control that
// rare is not furniture (Docs/DESIGN.md, rule 3).
function VaccinationRound({ token, onError, onNotice, onChanged }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: COMMON_VACCINES[0], date: today(), vet: '', batch: '' });
  const [busy, setBusy] = useState(false);

  const give = async () => {
    setBusy(true);
    try {
      const result = await api.vaccinateHerd(token, { kind: 'vaccination', ...form });
      const skipped = result.skipped ? `, ${result.skipped} already had it` : '';
      onNotice(
        result.count === 0
          ? `Every animal already has ${result.name} recorded for that day.`
          : `${result.name} recorded for ${result.count} animals${skipped}.` +
              (result.next_due_on ? ` Next due ${shortDate(result.next_due_on)}.` : '')
      );
      setOpen(false);
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <SectionTitle
        right={
          <AddButton
            open={open}
            onPress={() => setOpen((prev) => !prev)}
            label={open ? 'Close the vaccination round' : 'Vaccinate the herd'}
          />
        }
      >
        Vaccination round
      </SectionTitle>
      {open ? (
        <View style={styles.inlineForm}>
          <View style={styles.pickerRow}>
            <Picker
              label="Vaccine"
              value={form.name}
              options={COMMON_VACCINES}
              onChange={(v) => setForm((p) => ({ ...p, name: v }))}
            />
          </View>
          <FieldRow>
            <Field
              label="On"
              size="sm"
              value={form.date}
              onChangeText={(v) => setForm((p) => ({ ...p, date: v }))}
              placeholder="YYYY-MM-DD"
            />
            <Field
              label="Vet"
              size="md"
              value={form.vet}
              onChangeText={(v) => setForm((p) => ({ ...p, vet: v }))}
              placeholder="optional"
            />
          </FieldRow>
          <Field
            label="Batch"
            size="md"
            value={form.batch}
            onChangeText={(v) => setForm((p) => ({ ...p, batch: v }))}
            placeholder="on the vial"
          />
          {/* Says who it will reach before it reaches them. Animals that
              already have this jab on this date are skipped, so a second
              pass for the three that were out at pasture is safe. */}
          <Text style={styles.roundNote}>
            Every animal still on the farm. Anyone already given {form.name} on that day is skipped.
          </Text>
          <Button title="Give it to the herd" onPress={give} busy={busy} disabled={!form.date.trim()} />
        </View>
      ) : null}
    </Card>
  );
}

// What the farm produced. The question a dairy owner actually asks, and
// until now the only answers available were per-day or per-animal.
//
// Milk under a drug withdrawal is stated separately rather than folded
// in: it was produced but it cannot be sold, and one figure covering
// both is the wrong answer to either question.
function Production({ token, onError }) {
  const [range, setRange] = useState(30);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const to = today();
    const from = addDays(to, -(range - 1));
    api
      .getHerdSummary(token, from, to)
      .then((body) => {
        if (!cancelled) {
          setSummary(body);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          onError(err.message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, range, onError]);

  const totals = summary?.totals;
  const days = summary?.days || [];
  const top = summary?.top || [];

  return (
    <Card>
      <SectionTitle
        right={
          <ViewToggle
            value={String(range)}
            onChange={(v) => setRange(Number(v))}
            options={[
              { value: '7', label: '7 days' },
              { value: '30', label: '30 days' },
            ]}
          />
        }
      >
        Production
      </SectionTitle>

      {loading ? (
        <ActivityIndicator style={styles.smallLoader} color={colors.accent} />
      ) : !totals || !totals.days_recorded ? (
        <Empty>No milk recorded in that stretch.</Empty>
      ) : (
        <>
          <SummaryRow>
            <SummaryTile label="Milk sold" value={`${round1(totals.total)} L`} />
            <SummaryTile label="A normal day" value={`${round1(totals.per_day)} L`} note={`${totals.days_recorded} days`} />
            {totals.discarded > 0 ? (
              <SummaryTile label="Discarded" value={`${round1(totals.discarded)} L`} tone="warning" />
            ) : null}
          </SummaryRow>

          {top.length > 0 ? (
            <View style={styles.topList}>
              <Text style={styles.topHead}>Who carried it</Text>
              {top.map((item) => (
                <View key={item.animal_id} style={styles.dueRow}>
                  <Text style={styles.dueTag}>{item.animal_tag}</Text>
                  <View style={styles.bar}>
                    <View
                      style={[
                        styles.barFill,
                        { width: `${Math.max(4, (item.total / top[0].total) * 100)}%` },
                      ]}
                    />
                  </View>
                  <Text style={styles.dueWhen}>{round1(item.total)} L</Text>
                </View>
              ))}
            </View>
          ) : null}

          {/* The most recent handful. A thirty-row table of dates is not
              something anybody reads on a phone. */}
          <View style={styles.topList}>
            <Text style={styles.topHead}>Recent days</Text>
            {days.slice(0, 7).map((d) => (
              <View key={d.date} style={styles.dueRow}>
                <Text style={styles.dueWhat}>{shortDate(d.date)}</Text>
                <Text style={styles.dueWhen}>
                  {round1(d.morning)} + {round1(d.evening)}
                </Text>
                <Text style={styles.dayTotal}>{round1(d.total)} L</Text>
              </View>
            ))}
          </View>
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  loader: { marginTop: spacing.xl * 2 },
  headingDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginTop: -spacing.sm,
    marginBottom: spacing.md,
  },
  toolsRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowOpen: { backgroundColor: colors.surfaceAlt },
  pressed: { opacity: 0.6 },
  tagText: { width: 78, fontSize: 15, fontWeight: '800', color: colors.text, fontVariant: ['tabular-nums'] },
  rowMiddle: { flex: 1, minWidth: 0 },
  nameText: { fontSize: 14, fontWeight: '600', color: colors.text },
  breedText: { fontSize: 11, color: colors.subtitle, marginTop: 1 },
  rowEnd: { alignItems: 'flex-end' },
  stageText: { fontSize: 12, color: colors.subtitle },
  dueText: { fontSize: 11, fontWeight: '700', color: colors.warning, marginTop: 1 },
  menuGlyph: { width: 24, textAlign: 'right', fontSize: 18, color: colors.link, fontWeight: '700' },
  expanded: { paddingVertical: spacing.xs },

  inlineForm: { marginBottom: spacing.md },
  pickerRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md, flexWrap: 'wrap' },

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
  holdText: { fontSize: 12, fontWeight: '700', color: colors.error, marginTop: 2 },
  dueList: { gap: spacing.xs },
  dueRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dueTag: { width: 64, fontSize: 13, fontWeight: '800', color: colors.text, fontVariant: ['tabular-nums'] },
  dueWhat: { flex: 1, minWidth: 0, fontSize: 13, color: colors.text },
  dueWhen: { fontSize: 12, color: colors.subtitle },
  dueOverdue: { fontSize: 12, fontWeight: '700', color: colors.error },
  roundNote: { fontSize: 12, color: colors.subtitle, marginBottom: spacing.sm },
  smallLoader: { marginVertical: spacing.lg },
  topList: { marginTop: spacing.md, gap: spacing.xs },
  topHead: { fontSize: 13, fontWeight: '700', color: colors.subtitle, marginBottom: spacing.xs },
  bar: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.muted, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3, backgroundColor: colors.accent },
  dayTotal: { width: 62, textAlign: 'right', fontSize: 13, fontWeight: '700', color: colors.text },
  eventNotes: { fontSize: 12, color: colors.subtitle, marginTop: 2 },
  withdrawalNote: { flexGrow: 1, flexBasis: 180, minWidth: 0, justifyContent: 'flex-end' },
  withdrawalText: { fontSize: 12, color: colors.subtitle, paddingBottom: spacing.sm },
});
