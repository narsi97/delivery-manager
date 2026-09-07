# Design: what the screen is for

The first real business used this app for a fortnight and said it was
verbose — too much to take in. They were right, and the reason is worth
writing down, because it was not carelessness. Every screen was built
while somebody was learning it, so every screen teaches. A control that
explains itself is a good control on day one and noise on day two
hundred.

Measured on the customer roster with a real hundred-customer list:
**52% of the words on screen were repeated lines.** Seventy "pending"
badges, fifty-two drag handles, a hundred and four arrows, and an
instruction above them saying what the handles were for. None of it was
information. All of it was furniture.

These are the rules that come out of that. They are deliberately few.

---

## 1. The screen is a list, not a lesson

An instruction belongs where somebody is doing the thing for the first
time — an empty state, a form, a dialog. It does not belong above a list
they will read every morning for a year.

If a control needs a sentence every time it is shown, the control is
wrong. Fix the control.

> Rams: *good design makes a product understandable* — not *good design
> explains the product.*

## 2. Ink is for differences

A badge on every row is a badge on nobody. Show a status only when it is
not the ordinary one: "pending" on all fifty-two customers says exactly
as much as no badge at all, while costing fifty-two eye stops and the
colour that should have been carrying "failed".

The rest of the app already knew this — `PriorityBadge` renders nothing
for the default tier, and says so in its own comment. The rule just was
not applied anywhere else.

> Tufte: erase non-data ink.

## 3. Rare controls are not furniture

Reordering a round is something a business does when it changes, not
something it does while reading. The controls for it should arrive when
asked for and leave again — one switch at the top of the list, not a
hundred and fifty-six glyphs down the side of it.

The number stays. Where somebody is in the round is a fact about them,
and facts stay on the card.

> Raskin: a mode you did not choose is the thing that makes software
> feel hostile. A mode you *did* choose is just a tool in your hand.

## 4. Show what is true, not the whole shape

Four counters reading 91 / 0 / 0 / 0 spend three quarters of their space
on things that have not happened. Show the ones that have. Zero failures
is worth saying only on a day that had some.

## 5. Say it once

Two routes on a screen printed "Who's driving? … Nobody assigned yet.
Tap a name — the route is already planned and waiting." twice, once
each. Ten routes would print it ten times. Repetition of the *same*
sentence is always a layout mistake: lift it out, or delete it.

---

## Two tests before shipping a screen

**The count test.** Take the rendered text. Any line appearing more than
three times is furniture — justify it or remove it. This is mechanical
and catches most of it.

**The five-second test.** Look at the screen for five seconds and say
what you learned. On the old roster the honest answer was "there are a
lot of customers and they are all pending", which two words would have
told you.

---

## What this is not

Not a licence to hide things. A control that is hard to find is worse
than one that is merely present, and "clean" is not a goal — legible is.
Where something genuinely needs saying, say it, in the fewest words that
are still true. The driver's screen in particular keeps its plain
sentences: it is read one-handed, at a gate, in a hurry, by somebody who
may be new this week.

Nor is it a reason to remove what somebody asked for. The reorder pill
was designed with the business, at their request, down to which side the
number sits on. It has not been taken away — it has been given a switch,
so it is there when they are reordering and gone when they are reading.
