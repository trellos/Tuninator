# Where the recogniser stands, and what the audio will and will not support

Measured on the committed fixtures. Every number here came from running the
code, not from reasoning about it. The five original 120bpm fixtures and their
thresholds are untouched — no label edited, no gate lowered. The 140bpm
fixtures added since are held-out data: new label files and additive
`eval.config.json` entries only, and no engine constant is fitted to them.

## Against the frozen baseline (docs/BASELINE.md)

| metric | baseline | before the region lane | now | gate |
|---|---|---|---|---|
| labels missed | 12 / 78 | 5 / 78 | **4 / 78** | 0 |
| required fixtures failing | 2 | 0 | **0** | 0 |
| clean-lead pitch class (gated) | 77.4% | 92.9% | **96.3%** | 90% |
| clean-lead exact | — | 79.5% | **81.6%** | — |
| triplets pitch class | — | 90.5% | **95.0%** | — |
| clean-lead false positives | 8 | 1 | **1** | 3 |
| power-chords onset median | 140ms FAIL | 113ms PASS | **113ms PASS** | 120ms |
| chords-a-bm missed | 3 | 0 | **0** | — |
| spurious Notes | 23 | 6 | **6** | — |
| events yielding more than one Note | — | 11 / 78 | **11 / 78** | — |

Every required fixture passes every gate it is held to, and `npm run eval`
exits 0. The one remaining failure is `spicy-chords`' `maxFalseLabels`, on an
informational fixture, and it is a chord-template problem rather than a
segmentation one.

## What was wrong, and what fixed it

A strummed chord shed contiguous fragments — one Em strum became three Em
Notes 500ms apart. Two causes, both now fixed:

1. **The decay fit lived on the Note.** Splitting a Note discarded the only
   evidence that could reject the *next* split, so each fragment was too young
   to say no and split again. The fit now carries across a split.
2. **The level test used a rolling baseline that falls with the decay**, so
   sustain ripple cleared it every few hundred milliseconds. Over a chord that
   has named itself, the decay curve and the transient's sharpness now carry
   the case alone.
3. **Octave jumps were only treated as artefacts under harmonic context.** On a
   clean lead line nothing stopped them, so a sustained note flipped octave and
   split, and the matcher then paired the label with the wrong-octave half.

Spurious Notes: 51 → 35 at that point, and 6 now.
No labelled event was lost to any of these.

## The one that mattered

`currentLabel()` returned the newest frame's pitch. The tracker had always
accumulated a confidence-weighted vote per pitch — with a comment explaining
that naming a Note from its last frame hands it its neighbour's name — and the
label never read the votes. Naming a Note from its own accumulated evidence took
the lead take from 89.7% to **93.1%** pitch class and 79.3% to **86.2%** exact,
clearing a gate that fixture had never met.

That is also why every experiment above that adjusted *voting* measured as
neutral: the votes were not reaching the label. They are worth re-testing now
that they do.

## The remaining required failure — closed

`clean-lead` failed `maxFalsePositives` at baseline (8 against 3) and had never
passed. It now reports **1**. Every required fixture meets every threshold and
`npm run eval` exits 0.

What closed it was not a threshold sweep. It was the one shape the table below
kept failing to separate: a transient firing inside a note that is already
sounding. A re-pick puts energy into a string, so a re-picked note sits at or
above where its own measured decay says it should be — across the fixtures,
genuine re-picks land between 0.93 and 1.05 of the prediction. The seven
spurious Notes that came from a played note splitting in two measure 0.43 and
0.52: those notes are dying *faster* than their own fit expected, so nothing was
added to them and the sharp transient on top is the string, not the pick. The
sharpness escape now has a floor under it (`transient.ringOutDecayFloor`), and
the gap between 0.55 and 0.65 is wide enough to sit in.

## Fragmentation: one played event, several Notes

The eval's false-positive count understates this, because its matcher pairs one
detection with each label. `scripts/measure-splits.ts` counts it directly, under
two assignment rules that bracket the truth — every Note blamed on the one label
it started under, and every Note that overlaps a label counted against it.

| | events split | extra Notes | worst single event |
|---|---|---|---|
| before this pass | 24 / 78 | 41 | 9 Notes |
| now | **11 / 78** | **13** | **3 Notes** |
| (overlap rule) | 51 -> 41 | 78 -> 48 | |

Five changes did it, each measured separately:

1. **The room's harmonic context latches.** A strummed chord's context estimate
   sags as the chord decays — the third dies first, one string comes to
   dominate, and YIN starts finding a period in what is still six strings
   ringing. Read hop by hop, that estimate decided mid-ring that the chord had
   become a single note, and the pitch-step segmentation it was suppressing came
   straight back. `harmonicSince` existed for exactly this and was **never
   written**, so the escape it gated had never once fired.
2. **A stub is absorbed into the articulation that shed it.** For the first tens
   of milliseconds of anything, the fast lane has nothing true to say: the
   attack transient is the least periodic part of a note, so the pitch reported
   belongs to whatever was ringing before, and a strum's six strings arrive one
   at a time at six different pitches. When an attack ends a Note younger than
   `transient.articulationMs`, the Note that follows takes its start time and
   keeps its own pitch evidence — boundary from the stub, name from the frames
   that describe what was played.
3. **A voice is not a Note.** Once a Note has bloomed into a chord, an arriving
   pitch no longer counts as a new pitch. A chord has no single pitch to change.
4. **A ringing chord stops re-strumming itself.** The sharpness escape exists
   for a muted upstrum, which answers its downstrum within a beat. Seconds into
   a ring-out the same evidence means finger noise. Past
   `transient.mutedRestrumWindowMs` a re-strum takes energy above the decay
   curve.
5. **A chord change that has held is a boundary even while the chroma
   hesitates.** The pending-change timer was only ever consulted from inside the
   branch handling a confident disagreement — and the moment a chord changes
   over a ringing one is when the chroma is least sure of itself. The change
   could stand pending for a second and never become a boundary.

A bend also stays one Note again (architecture §17). A bend leaves the note it
is named after on purpose, so "the arriving pitch is not this Note's pitch"
stops carrying information; the estimate wobbling across the A#3/B3 boundary was
enough to open a new Note. While a Note bends, an arriving pitch has to differ
from the one that Note was sounding a hop ago by a real step.

## What is still fragmenting, and why

- **`cowboy:c2` (3 Notes)** — the D chord decays below the RMS gate mid-label
  and comes back. The third Note is the same chord resurfacing after the
  recogniser had honestly ended the previous one.
- **`power:p3` (3 Notes)** — two of the three are a genuine second strum
  (measured 1.27 above the decay curve, inside the range where `chords-a-bm-g-d`'s
  labelled restrums live at 1.27, 1.29 and 1.35) and the third is the following
  E chord's Note beginning 800ms before its label.
- **The lead take's six remaining splits** are all boundary placement in the
  triplet run: a Note carrying its neighbour's name for its first hops. That is
  the latency-model problem below, not a threshold.

## What the audio will not support

### t10 (E5, 13360-13527ms) is not recoverable

The label is honest — a player did pick an E5 there — but nothing in the signal
carries it. Swept both analysis windows across the whole span:

```
fftSize=2048 (43ms) and 4096 (85ms), windows ending 13400..13540ms
  every position:  strongest = D5 at salience 1.00
  E5:              ABSENT (one 0.333 blip at 13440ms, 85ms window)
```

The fast lane agrees: across t10 it reports D5 at 576-598Hz with confidence
0.83-0.97 and never approaches E5 (659Hz). The preceding D5 is still ringing
and its harmonic series swamps a weakly-picked neighbour (t10's own fundamental
measures 0.0007 against 0.0036 for t9).

This is the documented exception: analysis shows the label is not recoverable.
It costs no gate — clean-lead has no `maxMissed` check.

### The sixteenths run is not resolvable monophonically

The run has an open B ringing under the melody, so the passage is polyphonic
even though it reads as a lead line. Multi-pitch sees the melody note plainly —
at s4 it reports `A4 salience 0.986` beside `B4 1.000` — but the *loudest*
fundamental is the ringing open string, not the note just played.

Resolving these needs the deep lane to pick the fundamental that is NEW at the
Note's onset rather than the strongest, which is the Voices-versus-Notes
distinction (architecture §21) applied to pitch rather than to harmony.

`s4` and `s11` were already unrecoverable. **`s9` joins them** in this pass:
absorbing articulation stubs removes one detection from a run where the
detections and the labels were only loosely in register, and the matcher then
leaves `s9` unpaired. Total missed labels went 4 -> 5, all five inside this
section or `t10`/`t17`, and the section is marked `required: false` in
`eval.config.json`. Nothing in a gated section was lost.

### `spicy:sp1` is named `E5` rather than abstained

`maxFalseLabels` has never passed on this fixture. The Cmaj9 voicing now comes
out as ONE Note rather than seven, but the template that fits that one Note is
`E5` at confidence 0.85, and the gate wants "unknown" instead. That is the
chord-template path, not segmentation, and it is untouched by this pass.

## Hypotheses tested and rejected

Each was implemented, measured on the fixtures, and reverted. Recorded so they
are not tried again:

| change | result |
|---|---|
| backdate step boundaries by estimator group delay | onset error 90->77ms, accuracy unchanged, +1 spurious |
| let a frame vote only once its window is inside the Note | no change at all |
| delay voting until the estimate settles (40/70/95ms) | neutral at 40, accuracy 0.897->0.862 at 70+ |
| give the deep lane a vote on a monophonic Note's pitch | no accuracy change (it is fooled by the same ringing note) |
| median smoothing 3->2 / 3->1 | 3->2: +11 spurious; 3->1: +2 missed |
| require a transient for same-pitch re-articulation | spurious 11->9 but accuracy 0.897->0.786 |
| restrum sharpness 1.1 instead of 0.9 | -4 spurious, +2 missed, second fixture fails |
| attribute each frame's pitch retrospectively, to the Note sounding when that audio happened | no change at 45ms, accuracy 0.931->0.862 beyond it |
| absorb an identically-named stub into the Note it runs out of | clean-lead spurious 12->4, but eats genuine repeats: +4 missed, accuracy 0.931->0.828 |
| widen the glide window so a slow bend registers as gliding | does not stop the bend splitting; breaks two other fixtures |
| past the ring-out, require energy above the decay with no sharpness escape | missed 4->12, three fixtures failing, one unit test broken. Re-tested after this pass: still missed 5->14 and two required fixtures failing. A **floor** under the sharpness escape is what works; removing it is not |
| subtract the lag from *reported* times only, leaving voting untouched | onset error 90->36ms, but accuracy 0.897->0.862 and +2 missed |
| clear a Note's pitch votes when it absorbs an attack | the merged Note then has no pitch at all for most of a fast run: eight lead notes came out "unknown", pitch class 0.929->0.818. Absorbing the stub INTO the survivor, so the survivor keeps its own votes, is the version that works |
| absorb the predecessor of a *pitch-step* split as well as an attack split | at 60ms it costs a label; at 36ms it changes nothing. A step boundary is one the player put there |
| let the articulation window scale with the recent gap between attacks | identical numbers to the fixed window on every fixture — the ceiling dominates. Inert complexity, not kept |
| require the room to be in a harmonic stretch before a Note may abstain | does not recover any label and costs chords-a exact accuracy 0.833->0.769 |
| `articulationMs` above 100 | the triplet and sixteenth runs start losing real notes: missed 5->7 at 100, 5->9 at 110 |
| `minStableMs` above 60 | same cliff: 70ms costs two labels in the sixteenths |
| keep the previous decay curve alive across a restart, so a restrum still has a curve to be measured against | correct in principle and provably inert here: the attack fires on the pick, a hop or two before the energy actually arrives, so the comparison is made too early to help. Not kept |

## The corpus grew a controlled variable: three signal paths per performance

Every 140bpm performance now exists as a direct input, an amp sim and a room
mic, labelled per path from the same playing. That is the most useful thing in
the set, because a number that moves between the three paths is a signal-path
effect and a number that moves on all three is the detector.

It settled the power-chord take's structure outright. The take was suspected of
hiding a quieter re-strum on beats 2 and 4 under each ringing strum, which would
have made it 32 events rather than 16. On the DI, whose noise floor is 3.3e-5
against strum peaks of 0.79:

- every spectral-flux peak that is not one of the sixteen strums is followed by
  a FALL in 30ms RMS of 2-22dB, where each of the sixteen is followed by a RISE
  of 12-55dB. The in-between peaks are the muting hand, not a pick;
- a targeted scan of the quarter-note midpoint after each strum (+428.6ms
  +-120ms) finds a maximum 60ms RMS rise of 1.6-5.0dB and a 4kHz-band peak
  2.1-5.5x the window median, against 18-60dB and 8-524x at the strums.

Sixteen events, and 857ms is the performer's quarter note rather than a half
note: he played that take at 70bpm. Four bars of chord X on 1, X on 2 then
muted, chord Y on 3, Y on 4 then muted.

The DI also confirms the two label sets that were least certain: all 48 of the
sixteenths and all 55 of the lead-line notes have their own flux peak there,
matched one to one against the mic labels shifted by a constant offset, at a
median disagreement under 1ms.

## The chord-chopping defect: a threshold that changed meaning

The performer reported that a single strum comes apart into several notes while
it rings. It reproduces on the held-out fixtures, and the cause is not a
threshold set too low. It is two tests that mean something different once the
signal path changes.

**`transient.restrumSharpness` is not path-independent.** Sharpness is spectral
flux over the frame's RMS, which removes how loud the passage is and nothing
else. A compressor holds the level flat while the spectrum keeps churning, so a
compressed chord's ordinary sustain reads as sharp as a real pick does on a
direct input:

| | off-label sharpness (p10 / median / p90) |
|---|---|
| clean 120bpm takes | 0.27 / 0.46-1.02 / 1.12-3.00 |
| amp-sim takes | 0.99-1.12 / 1.30-1.37 / 1.45-1.86 |

The fitted threshold, 0.9, sits between them. On the amped cowboy take ten
separate re-articulations were accepted inside ringing chords at sharpness
1.26-1.53 with a rise ratio of 1.00 — no energy arrived at all.

The flux kernel already carries a figure that does generalise. Its threshold is
a running median of this signal's own recent flux, so flux/threshold asks
"sharper than this signal usually is". Its off-label median is 1.02-1.24 on
every path in the corpus, against 0.46-3.24 for sharpness. Both sharpness
escapes now require it (`transient.restrumFluxRatio`), and the value comes off
the 120bpm fixtures as every other constant here did: the two muted upstrums the
escape exists for measure 1.58 and 1.78 there, while ripple that has just
cleared the onset threshold sits a hair above 1.0 by construction.

**Blooming into a chord, not naming one, is what protects a chord.** The strict
polyphonic branch was entered only once a Note had NAMED a chord. Naming
additionally requires a chord template to fit, and a saturated amp sim is
exactly where templates stop fitting — the recognizer emits "unknown" for chords
on that take that it hears perfectly well as chords. So the one path that
protects a ringing chord from being chopped switched itself off on the signal
that needed it most, and the chord went down the monophonic route instead.
The branch now keys on `harmonyBloomed`, which is a claim about the audio
(several fundamentals, spread across more than a fifth, no single period) rather
than about a template.

### Measured, before and after

| fixture | detections / labels | | missed | | false positives | |
|---|---|---|---|---|---|---|
| | before | after | before | after | before | after |
| cowboy amped 140 | 19 / 8 | **11 / 8** | 0 | 0 | 11 | **3** |
| cowboy mic 140 | 9 / 8 | **8 / 8** | 0 | 0 | 1 | **0** |
| cowboy DI 140 | 10 / 8 | 9 / 8 | 0 | **1** | 2 | 2 |
| lead line mic 140 | 72 / 55 | 72 / 55 | 0 | 0 | 17 | 17 |
| power chords mic 140 | 22 / 16 | 22 / 16 | 1 | 1 | 7 | 7 |
| the five 120bpm fixtures | — | unchanged | 4 | 4 | 1 | 1 |

The five originals are bit-identical: 11 of 78 events split, 13 extra Notes,
and every required fixture meets every threshold it is held to. On the eleven fixtures that existed before the new
signal paths arrived, fragmentation goes 48/221 events split and 55 extra Notes
to 47/221 and 49.

**One event was lost, and it is worth naming.** `cowboy-chords-di` c6 — the D to
Em change 1400ms into a ringing chord — used to be carried by the ring-out
sharpness escape on a Note that had never named a chord. Once that Note blooms,
the change falls past `transient.mutedRestrumWindowMs` and is rejected. Letting
a late re-strum through on a high flux ratio recovers it and costs two extra
splits on the 120bpm fixtures, whatever ratio is chosen between 2.5 and 3.4, so
it was not kept. The right repair is the harmony-change path carrying that
boundary, not the re-articulation path.

### What did NOT move, and why

`lead-line-quarter-eighth-triplet` (72 detections for 55) and
`power-chords-...-140bpm` (22 for 16) are unchanged, and neither is the defect
above. Instrumented, the lead take accepts only six re-articulations that land
on no labelled event; its 22 split events are each exactly two Notes, which is
the boundary-placement problem this document has already named — a Note whose
boundary is right and whose first hops describe its predecessor. The power mic
take's extras are the muting hand (a mute produces a transient AND, briefly,
energy above the chord's decay curve, measured at 1.35) and three handling
knocks after the playing stops. Separating a mute from a strum needs to see that
the energy collapsed 60ms LATER, which the fast lane cannot do causally; the
region lane can see it and currently has no way to act on it, because merging is
off on measurement.

### Also measured and rejected in this pass

| change | result |
|---|---|
| enter the strict polyphonic branch whenever the ROOM reads harmonic, not just this Note | cowboy amped 19 -> 10 and the lead mic take 72 -> 65, but clean-lead falls to 6 missed and 81.1% pitch class and FAILS its required gate: a lead line reads harmonic in flashes, and merging on those flashes eats real notes |
| past `mutedRestrumWindowMs`, allow a re-strum on a high flux ratio instead of rejecting outright | recovers `cowboy-di` c6 and takes the power DI/amped takes closer to 16 events, but costs two splits on the 120bpm fixtures at every ratio tried (2.5, 3.0, 3.4). Not kept |
| require the flux ratio on the weakest sharpness fallback as well | the genuine fast re-picks in `clean-lead` measure 1.07-1.15 there, so any ratio that removes the amped fragments (1.02-1.15) removes real notes too |

## The half-rate reading: picking faster than one articulation

The sixteenths take came out at half its real rate — 27 Notes for 48 played on
the room mic, 34 on the direct input and 34 on the amp sim. It reproduces
identically on all three signal paths, so it is the detector rather than the
room, and the Notes it did emit were spaced at the *eighth* note: one Note per
pair of strokes.

The cause is two devices that exist because a pick is not one transient. The
fast lane opens a Note on the first, and whatever fires over the next few tens
of milliseconds is the same pick still landing — a strum crossing six strings,
or pick noise and then the string speaking. So a split's boundary is backdated
to the FIRST transient of the burst, and a Note the burst shed on the way is
absorbed into the articulation that shed it.

Both stop being true the moment the player picks faster than the burst window.
The boundary then lands at or before the start of the Note it is meant to end;
`end()` clamps it, the Note is zero length, being zero length it is never
announced, and the successor absorbs it and takes its start. Two picks, one
Note, silently. At 140bpm the strokes are 107ms apart and the quieter ones
measure 80ms — comfortably inside `transient.articulationMs`, which is sized so
a 120bpm strum's fragments are absorbed.

Neither repair is a threshold:

- **A Note cannot end before it began.** When the burst that would place the
  boundary is the same one this Note starts on, that burst has already been
  spent, and the boundary is the transient in hand.
- **A Note that had already begun to decay was not a stub.** A fragment of a
  forming articulation is interrupted by the same pick still arriving, so it is
  at its own peak when it dies; a note answered by a second pick had peaked and
  started to fall first. That is the Note measured against itself, so it reads
  the same at any level, on any signal path and at any tempo — which is exactly
  what a duration cannot claim.

| sixteenths, detections / 48 | before | after |
|---|---|---|
| room mic | 27 | **32** |
| direct input | 34 | **37** |
| amp sim | 34 | 34 (one fewer false positive) |

The five 120bpm fixtures are bit-identical: same detections, same misses, same
false positives, 11 of 78 events split and 13 extra Notes. Every required
fixture still meets every threshold. The cowboy 140bpm takes are unchanged on
all three paths.

**What it costs, stated plainly.** The lead take's over-segmentation moves the
wrong way — mic 72 detections for 55 labels to 74, amp sim 59 to 64, direct
input 64 unchanged — because two of the Notes this stops absorbing are in the
triplet run, where the thing being absorbed was not a stroke but a decaying
note shedding flux. Instrumented at `q13`: a transient fires at 10627ms with a
rise ratio of 0.64, i.e. while the envelope is FALLING, and opens an 80ms Note
that the old rule swallowed. Three attempts to keep that one and still keep the
sixteenths were measured and none worked:

| rule | sixteenths mic | lead mic |
|---|---|---|
| absorb when the stub never decayed (kept) | 32 | 74 |
| ...or when its own transient brought no energy (`riseRatio < 1.25`) | 29 | 73 |
| ...or when the envelope was outright falling (`riseRatio < 1.0`) | 30 | 74 |

The reason is that "the envelope barely rose" is the DEFINING property of the
stroke this pass exists to recover: the performer's upstrokes measure 0.85 to
1.6 on the same ratio. A rule that reads a falling envelope as "no pick" cannot
be tightened far enough to separate them without taking the upstrokes with it.
Separating those two needs a witness that is not the broadband envelope, and
the obvious candidate is the next section.

## The attack band: built, measured, rejected

*Superseded in part. A HIGHPASS is what this section rejects, and rightly. A
BANDPASS, and the discovery that the adaptive median was never the threshold,
are two sections further down.*

The remaining sixteenths are the quiet upstrokes. The performer's own
annotation of that take says how it was resolved by hand: a 5kHz-highpassed
1ms RMS envelope shows four attacks per beat where a broadband onset function
shows two. The physics behind that is real — a pick is an impulse and spreads
its energy flat, while a string already ringing is a few narrow low partials —
and the recogniser's broadband flux is compared against a floor proportional to
the whole frame's magnitude, so a quiet pick landing on a loud ringing note has
to beat a bar set by the ringing note.

A second, band-limited flux was built on that argument: the same rectified flux
summed above `attackBandHz`, with its own running median, so a transient could
clear the floor up high instead of broadband. Swept on the five 120bpm fixtures
alone, the band edge behaves exactly as the physics predicts — the flux at a
labelled attack relative to the signal's own recent flux climbs from 33x
broadband to 87x above 2kHz, 191x above 3kHz and 498x above 4kHz, while the
same figure away from any label stays flat at about 5x. Raw onset coverage over
the whole corpus went 390/459 labels to 425/459.

**It does not survive contact with the tracker, and the reason is worth
recording.** Every downstream constant was fitted to the attack rate the
broadband detector produces, and the extra transients cost more than they buy:

| variant | sixteenths mic/DI/amp | clean-lead FP (gate 3) | chords-a-bm missed | lead mic detections (55 labels) |
|---|---|---|---|---|
| without the band | 32 / 37 / 34 | 1 | 0 | 74 |
| band at 4kHz | 34 / 37 / 35 | 6 | 1 | 74 |
| + superseding a band-only onset with a broadband one | 36 / 38 / 35 | 11 | 0 | 77 |
| + a band re-articulation escape at every ratio 10..150 | 36 / 38 / 35 | 5-11 | 0 | 77 |

Three separate containments were built and measured, and none of them helped:
keeping a band-only transient out of the attack burst (worse on every axis),
refusing to let one open a Note out of silence (worse still), and stopping one
from clearing the pitch estimator's history (inert). The band's own escape in
the re-articulation path turned out not to matter at all — disabling it left
the sixteenths unchanged — so what the band buys is the extra transients and
what it costs is the extra transients.

**And the band edge cannot be chosen honestly on this corpus.** Sweeping it
upward keeps improving the sixteenths (mic 38 at 12kHz, 40 at 10kHz) while
leaving the 120bpm fixtures bit-identical, which looks like a free win and is
not one. Measured, the fraction of total magnitude above 12kHz is 0.0006-0.003
on every 120bpm fixture and on every DI and amp-sim take — those files are
lossy-coded and have nothing up there — against 0.20-0.43 on the three room-mic
140bpm takes. A room mic take that is 43% of its magnitude above 12kHz is
hiss, not music. So a high band "wins" by measuring the modulation of one
recording's noise floor, and the originals only look untouched because their
band is empty. That is precisely the kind of accident that held-out data exists
to catch.

Not kept. The 5kHz highpass is a sound way to annotate one file by hand; it is
not a detector rule that transfers to a direct input.

## What is left

Two shapes, both now measured rather than guessed at.

The first is the ledger above: **45 to 46 of the 48 labelled strokes on each
sixteenths take have a transient the tracker is handed, and 35 to 39 come out as
Notes.** Nothing is left to perceive. What loses them is that two boundaries
landing closer together than one articulation window destroy the earlier event —
it is either too young to be ended (`tracking.minStableMs`) or short enough to
be swallowed by its successor (`transient.articulationMs`) — and both constants
are pinned from the other side by the 120bpm fixtures. Separating "old enough to
be ended" from "old enough to be announced" is the change that would move this;
they are one constant today and they are two different questions.

The second is the one the last pass named and this one did not touch: **the
pitch path runs about 90ms behind the transient path.** Every remaining split in
the lead takes is a Note whose boundary is right and whose first hops describe
its predecessor, or the reverse. Correcting only the reported times fixes the
onset error almost completely (90ms to 36ms) and makes the labelling worse,
because the boundaries and the pitch evidence then disagree about where a Note
is. Either both move or neither does. It is why the lead takes over-segment,
and it is why they got worse here rather than better: this pass made the
detector more willing to find boundaries, and on a take whose boundaries are
already doubled that is the wrong direction. That is a change to how
segmentation works, not a constant to tune.

## Where this pass landed, per fixture per signal path

Detections against labels, with missed events and false positives. "Before" is
the state at the top of this pass; nothing in the five 120bpm fixtures moved.

| fixture | before | after | missed | fp |
|---|---|---|---|---|
| chords-a-bm 120 | 16 / 16 | **16 / 16** | 0 -> 0 | 0 -> 0 |
| clean-lead 120 | 40 / 43 | **40 / 43** | 4 -> 4 | 1 -> 1 |
| cowboy 120 | 12 / 8 | **12 / 8** | 0 -> 0 | 4 -> 4 |
| power-chords 120 | 9 / 8 | **9 / 8** | 0 -> 0 | 1 -> 1 |
| spicy | 3 / 3 | **3 / 3** | 0 -> 0 | 0 -> 0 |
| sixteenths mic | 32 / 48 | **35 / 48** | 16 -> 13 | 0 -> 0 |
| sixteenths DI | 37 / 48 | **39 / 48** | 11 -> 9 | 0 -> 0 |
| sixteenths amp | 34 / 48 | **38 / 48** | 15 -> 13 | 1 -> 3 |
| lead line mic | 74 / 55 | 78 / 55 | 0 -> 0 | 19 -> 23 |
| lead line DI | 64 / 55 | 71 / 55 | 5 -> **2** | 14 -> 18 |
| lead line amp | 64 / 55 | **64 / 55** | 9 -> 9 | 18 -> 18 |
| cowboy mic 140 | 8 / 8 | **8 / 8** | 0 -> 0 | 0 -> 0 |
| cowboy amp 140 | 11 / 8 | **11 / 8** | 0 -> 0 | 3 -> 3 |
| cowboy DI 140 | 9 / 8 | **9 / 8** | 1 -> 1 | 2 -> 2 |
| power mic 140 | 22 / 16 | 23 / 16 | 1 -> 1 | 7 -> 8 |
| power DI 140 | 12 / 16 | **12 / 16** | 5 -> 5 | 1 -> 1 |
| power amp 140 | 11 / 16 | **11 / 16** | 7 -> 7 | 2 -> 2 |

The sixteenths move on all three paths, which is what says it is the detector
and not the room. The DI lead take's missed events halve and its pitch class
goes 87.3% to 96.4%. The two takes that get worse are the room-mic lead line and
the room-mic power chords, both of which were already over-segmenting and both
of which gain events rather than losing them; that is the cost of a pass whose
every constant was moved toward sensitivity, and it is recorded rather than
explained away.


## The onset threshold was never the adaptive median

The flux kernel's threshold is `max(sensitivity * median, floor * magnitude,
1e-3)`, and everything written about it here and in the config assumed the first
term decided things. Instrumented at every labelled attack in the five 120bpm
fixtures, it does not:

| | `sensitivity * median` | `floor * magnitude` | binding term |
|---|---|---|---|
| clean-lead, 43 labels | 0.000 - 0.020 | 0.006 - 0.026 | relative floor at 41 |
| the other four fixtures | 0.000 - 0.020 | 0.009 - 0.130 | relative floor at every label |

So the onset test in practice reads **"did more than a tenth of this frame's
magnitude arrive as new energy"**, which is why a quiet pick landing on a loud
ringing note cannot clear it: the bar is set by the note it is landing on. It
also means `transient.fluxSensitivity` and `fluxMedianWindow` decide almost
nothing on this material, and that `restrumFluxRatio` — introduced as the
path-independent figure because it divides by "the signal's own recent flux" —
is in practice `10 x flux / magnitude`, a level-relative measure like the
others. That last point is recorded rather than acted on; the constant works and
the reason given for it is wrong.

## The attack band, second attempt: a bandpass, and what it is good for

The previous attempt used a HIGHPASS and could not choose its edge honestly:
raising it kept improving the room-mic takes while leaving the 120bpm fixtures
bit-identical, because a mic take here is 28% of its magnitude above 12kHz where
every direct input is 0.2%. A bandpass was swept instead, both edges and the
floor together, on the five 120bpm fixtures alone, scoring raw onset coverage of
the 78 labels against the fraction of off-label hops that fire:

| band \ floor | 0.10 | 0.09 | 0.08 | 0.07 |
|---|---|---|---|---|
| 0-24k (before) | 88.5% / 6.27% | 92.3% / 7.10% | 94.9% / 8.40% | 94.9% / 9.93% |
| 750-6000 | 91.0% / 5.07% | 92.3% / 5.53% | 93.6% / 6.02% | 93.6% / 6.88% |
| **1000-6000** | 89.7% / 4.11% | 91.0% / 4.46% | **93.6% / 4.99%** | 93.6% / 5.43% |
| 1250-6000 | 89.7% / 3.82% | 92.3% / 4.16% | 92.3% / 4.45% | 92.3% / 4.94% |
| 1000-24000 | 91.0% / 4.58% | 92.3% / 4.89% | 93.6% / 5.51% | 93.6% / 6.09% |

Two properties of that sweep matter more than the winning cell, and they are the
honesty check the highpass failed:

- **Coverage has an interior maximum in the lower edge.** It climbs from 84.6%
  at 0Hz to 91.0% at 750-1000Hz and falls back to 79.5% by 3000Hz.
- **Raising the upper edge past 6kHz never buys a label.** Coverage is identical
  at 6k, 8k, 12k and 24k; only the off-label rate keeps climbing. A band that
  stops at 6kHz cannot win by measuring hiss, and the sweep does not want to.

The chosen point, 1000-6000Hz at a floor of 0.08, is a local optimum in all four
directions and is better than the broadband detector on **both** axes.

**It still may not decide anything, and that is measured.** Routed into the fast
lane's own decisions it costs `chords-a-bm` a labelled event and takes
clean-lead's false positives from 1 to between 5 and 9, at every sharpness
threshold from 1.0x down to 0.1x of the fitted values, because every downstream
constant is fitted to what the broadband flux does. So it is recorded on the
tracker's list of transients it saw and was not allowed to act on, where the
region lane corroborates against it.

**What it is worth, ablated:** the room-mic sixteenths go from 33 detections to
35 with the band present and everything else identical, and the labels with any
transient within 60ms go from 38 to 46 of 48. Every other fixture is unchanged.

### What no band can do

Per-label, on the room-mic sixteenths, the quiet upstrokes do not stand out in
ANY band. Peak flux over threshold in the window around each labelled attack:

```
label   0-24k   0-2k  0.5-3k   1-4k   2-6k   3-8k  5-24k
s5       2.44   3.18    2.81   2.99   1.54   1.52   2.38   <- downstroke
s6       0.60   0.49    0.47   0.88   0.85   0.44   0.75   <- upstroke
s16      0.75   1.08    1.04   0.99   0.58   0.33   0.00   <- upstroke
s20      0.67   1.31    1.24   0.70   0.77   0.56   0.03   <- upstroke
```

The upstrokes sit at 0.5-1.5 everywhere. There is no frequency region in which a
quiet upstroke on that take is loud; the band buys its eight extra labels by
lowering the floor it is measured against, not by finding a place where the pick
is obvious.

## The ledger: where the sixteenths actually go

Requested directly, and it settles what to work on. Every onset the tracker
receives on the three sixteenths takes, accounted for:

| | mic | DI | amp |
|---|---|---|---|
| labels | 48 | 48 | 48 |
| labels with a transient within 60ms | **46** | 45 | 45 |
| hops with an accepted transient | 38 | 42 | 46 |
| hops with a band-only transient | 27 | 8 | 14 |
| re-articulations attempted over a sounding Note | 35 | 41 | 43 |
| ...accepted | 29 | 34 | 34 |
| ...rejected while sitting on a label | 6 | 7 | 8 |
| stubs absorbed into their successor, on a label | 3 | 0 | 5 |
| region carves / splits / inserts accepted | 2 | 1 | 2 |
| **detections** | **35** | **39** | **38** |

The raw evidence is not the limiting factor and has not been for some time: 45
to 46 of the 48 labelled strokes have a transient the tracker is handed. What
loses them, named:

| cause | mic | DI | amp |
|---|---|---|---|
| the Note being re-articulated is younger than `minStableMs` | 3 | 1 | 5 |
| gliding, and the envelope rise below `glideRiseOverride` | 1 | 3 | 3 |
| no energy arrived and the transient was not sharp | 1 | 3 | 0 |
| absorbed as an articulation stub | 3 | 0 | 5 |

The first and the last are the same defect seen twice: **when two boundaries
land closer together than one articulation window, the earlier event is
destroyed** — either it is too young to be ended, or it is short enough to be
swallowed by its successor. The previous pass fixed one instance of this (a
boundary placed at or before a Note's own start collapsed it to zero length);
these are the other two, and they are bounded by constants that the 120bpm
fixtures pin from the other side.

## Re-derived against the corrected onset rate

Every constant below was swept downward on the five 120bpm fixtures alone until
one of them moved, and set one step above that. The five are bit-identical to
the pass before this one at every value chosen: same detections, same misses,
same false positives, same pitch classes, 11 of 78 events split, 13 extra Notes.

| constant | was | now | what breaks below |
|---|---|---|---|
| `deep.segmentAttackRiseRatio` | — | 1.25 | 1.15: clean-lead +1 false positive |
| `transient.glideRiseOverride` | — | 1.6 | 1.5: clean-lead +1, 1.25: +5 |
| `transient.rearticulationSharpness` | 0.7 | 0.65 | 0.60: spicy +2 |
| `transient.rearticulationRiseRatio` | 1.25 | 1.2 | 1.15: clean-lead +3 |
| `transient.articulationMs` | 90 | 80 | 75: chords-a-bm +1 |
| `tracking.minStableMs` | 60 | 55 | 50: clean-lead +3 |
| `analysis.rmsGateNoiseMultiple` | — | 200 | 150: chords-a-bm +1 |

The direction is deliberate. A played note that never appears cannot be
recovered later; an extra one can. Where the 120bpm material gives a band rather
than a point, this pass sits at the sensitive end of it.

## A bend does not put energy into a string

The glide guard rejected every attack arriving while the pitch estimate was
moving, and in a fast run the estimate is moving most of the time. Instrumented
on the direct-input sixteenths, four of the nine strokes it loses were rejected
for this reason alone, one of them carrying an envelope rise of **13.5** — a
figure no bend can produce, because bending redistributes the energy already in
a string rather than adding any. Mid-glide now takes an unmistakable arrival
(`transient.glideRiseOverride`) instead of nothing at all.

## The region lane owns the partition

The change the last pass named as next. The region used to PROPOSE boundaries
into the partition the fast lane had already made, so `s4`'s boundary — landing
61ms before the end of the Note in front of it — became a split candidate too
short to survive, and the event was lost. Three parts:

1. **The fast lane proposes and the region disposes**, which is the reverse of
   what it replaces. Every transient the tracker recorded and was not allowed to
   act on now reaches the region as a sample index. A pick localises a boundary
   to one sample where the region's 21ms hop localises it to 21ms; the region
   answers the only question a transient cannot, which is whether anything
   followed it (`deep.segmentAttackRiseRatio`). `RegionSegment.boundary` gains
   `"attack"` for a boundary both witnesses agree on.
2. **`carveAfter`** truncates a Note at a boundary near its end and opens the
   event that begins there, bounded by whatever anybody emitted next. Only a
   transient may do this. A leader that changes sixty milliseconds before a Note
   ends is the analysis window straddling a boundary that is already there, and
   truncating on that measured +3 false positives on the 140bpm lead take and
   +1 detection and +1 false positive on the cowboy DI take, recovering nothing.
3. **`deep.regionMerge` stays off**, re-tested under the new partition: it takes
   `spicy` from 3 detections to 7 and costs the sixteenths three detections on
   every path. The reason is the one already recorded — the survivor of a merge
   is marked structural, which stops it absorbing its own attack fragments
   later, and the chord it belongs to then sheds them as Notes.

## Measured, and not kept

| change | result |
|---|---|
| the band-limited flux as the fast lane's own onset witness | `chords-a-bm` loses a labelled event and clean-lead's false positives go 1 -> 5-9 at every sharpness scale from 1.0x to 0.1x. It is a corroborating witness or it is nothing |
| band edges swept for a *decision* threshold rather than coverage | the joint criterion (coverage, off-label rate) is monotone in the lower edge and its optimum runs away to 3kHz+, where coverage has already fallen to 79%. Coverage alone has the interior maximum; the ratio does not |
| deriving the amplitude gate from the tracked noise floor | correct in shape, inert on this corpus. The tracked floor is 2.6e-5 to 4.8e-4 across all seventeen fixtures and does NOT sort by signal path — the room-mic and direct-input sixteenths both track 3.3e-4 — so the cap binds on sixteen of them and nothing moves |
| feeding digital silence to the noise-floor tracker | converges on 1e-7 on the room-mic takes, which is the codec's silence and not the room. Frames below `noiseFloorMinimum` are skipped, not clamped |
| carving on a `pitchChange` or `energyRise` boundary as well as an `attack` | lead mic 77 -> 81 detections for 55 labels, cowboy DI 9 -> 10 with a third false positive, and not one extra detection on any sixteenths take |
| refusing an `attack` boundary as a *split* while allowing it as a carve | lead mic 77 -> 79: the split that does not happen leaves a Note whole, and a carve happens instead. Non-monotone, and worse |
| letting an `attack` boundary past the bend guard | completely inert on all seventeen fixtures. The bend guard is not what blocks the sixteenths |

## The deep lane re-segments; it no longer tags windows

The section below this one is still true of the lane it describes, and it is
why that lane was replaced rather than tuned. A job was queued for the Notes
active at the scheduling moment and its result was filed under them, which
fixes what the lane is able to say: it can improve a Note's name, and it can
do nothing else. It cannot report that three notes were played where two were
emitted, because the third does not exist to be tagged, and it cannot pick the
voice that just *arrived* over the loudest one, because one window has nothing
to compare against.

The lane now analyses a **region** — the span from the start of the oldest Note
nobody has ruled on to now — as a sequence of 4096-point windows at a hop of
1024, and returns an ordered list of segments with no `noteId` anywhere in the
result. The tracker reconciles that against the Notes it already emitted, and
a Note only reaches `Resolved` once it has been compared against a re-analysis
of its own audio. Closing Notes are held until then; without that hold there is
nothing left to correct by the time the verdict arrives.

Two witnesses, decided from the window sequence alone:

- **the leader moved and stayed moved** — compared by pitch class, held for two
  windows;
- **the envelope rose above the trough since the last boundary** — the only
  witness that can ever separate a note re-picked at its own pitch from itself,
  since a D5 picked twice is D5 throughout.

### `t17` — three notes played, two emitted, and now three

| | before | after |
|---|---|---|
| `t17` (D5 @14527ms) | missed | matched, onset error **+4ms** |
| triplets missed | 2 (`t10`, `t17`) | 1 (`t10`, documented unrecoverable) |
| triplets pitch class | 90.5% | 95.0% |

The fast lane emitted one Note over 14360–14653ms covering both `t16` and
`t17`, and abstained on it. The region sees the envelope trough at 14552ms and
a 2.6x rise by 14616ms; the fast lane saw a transient at 14573ms and acted on
nothing, because that hop sits **below the amplitude gate** — a note picked into
the tail of the one before it can. Neither witness is sufficient alone and
together they are unambiguous.

The recovered Note abstains rather than naming itself. Splitting a Note the
recognizer declined to name is a claim about how many events there were, not a
licence to name them, and `t16`'s E5 is still not in the signal.

### What keeps it from shredding everything else

Each is a rule the fast lane already lives by, applied to region evidence:

1. **A Note that named a chord is identified, not merely detected.** Untouched.
2. **A chord's leader moving is a voice, not a Note.** A strum's strings arrive
   over tens of milliseconds and decay at different rates, so the strongest
   fundamental wanders for the chord's whole life. Without this rule
   `chords-a-bm` shed five extra Notes and `spicy` shattered into seven.
3. **A bend is one thing the player did.** A sweep fires both attack witnesses
   repeatedly and drags the leader through every semitone on the way.
4. **A re-articulation needs energy to have arrived**, within one backdate
   window of a transient the fast lane actually saw.
5. **A split must change the Note's name.** Cutting a C#5 in two and calling
   both halves C#5 is fragmentation whatever the transform saw in between. This
   one rule is worth 1 split, 1 extra Note and 1 false positive on its own.

### Measured and rejected in this pass

| change | result |
|---|---|
| block re-segmentation while the room reads harmonic (`harmonicSince`) | crude: still 4 false positives on `chords-a-bm` and it blocks the sixteenths outright. The per-witness rules above are strictly better |
| let a bloomed Note be split on a leader change | inert on these fixtures — the bend guard fires first on the merged sixteenths Note — and it shatters chords when the bend guard does not |
| allow a split when the region's leader RETURNS to an earlier pitch class (a melody returns, a decay converges) | measured completely inert: identical eval and identical fragmentation. Inert complexity, not kept |
| let a carved-out event run for the length the region gave it rather than stopping at the Note it came from | false positives 6 -> 8, fragmentation 11/78 -> 12/78, and it still does not recover `s4` |
| `deep.segmentRiseRatio` 2.0 / 2.5 / 3.0 / 3.5 | identical on every fixture. The attack corroboration dominates; the ratio only proposes |
| `deep.segmentHoldWindows` 2 / 3 / 4 | identical on every fixture |
| `deep.minSegmentMs` 90 / 100 / 110 / 125 | identical totals; only the boundary placement inside one triplet moves |
| `deep.regionSettleMs` x `deep.maxRegionMs` over 200/400/700 x 700/1200/2000 | no combination recovers `s4`, `s9` or `s11`; several cost false positives |
| deep-lane merging (`deep.regionMerge`) | false positives 6 -> 10, fragmentation 11/78 -> 12/78, worst case five Notes on one event. Absorbing a pair moves a start time, which opens the survivor to the fast lane's own absorption path and cascades. Built, tested, **off** |
| deep-lane pitch correction (`deep.regionCorrectPitch`) | clean-lead pitch class 92.9% -> 81.5%, gate fails. Same cause the earlier "give the deep lane a vote" experiment found: the strongest fundamental in a window is the loudest voice, and in a fast run that is the note before this one. Built, tested, **off** |

### `s4`, `s9`, `s11` are still missed, and here is exactly why

The evidence is plainly there. Over 20200–20560ms the region's leader reads
`B4 -> A4 (window ending 20371) -> B4 (20520)`, and the A4 stretch is `s4`,
which the fast lane emitted **nothing at all** for — a 146ms hole between two
Notes. Over 20940–21520ms it reads `A4 -> B4 -> C#5 -> B4 -> A4`, which is
`s8` through `s12`.

Two structural things stop the reconciler acting on it, and neither is a
threshold:

- **`s4`'s segment starts inside its neighbour.** The boundary estimate lands at
  20286ms while the Note before it runs to 20347ms, so the segment is *owned* by
  that Note and becomes a 61ms split candidate rather than a new event. Letting
  a carved event run its own length instead was measured above and is worse.
- **`s9`/`s11` live inside a Note the bend guard protects.** The fast lane's one
  Note across 20960–21493ms measures a 193-cent "bend", because a Note that
  spans a melody wanders by definition. Distinguishing that from a real bend is
  the open problem; the returning-leader test written for it measured inert.

Both want the region lane to own boundary *placement* rather than proposing
boundaries into a timeline the fast lane already partitioned. That is the next
change, and it is a bigger one than this.

## Latency alone does not buy correctness

The deep lane is allowed to be late, and it is natural to assume that letting it
wait longer would let it answer better. Measured, it does the opposite.

`deep.latencyMs` only sets when a result may be APPLIED. The job's span is fixed
when it is queued and always ends at the scheduling moment, so waiting longer
delays the same answer rather than improving it:

| deep.latencyMs | missed | spurious | required failures |
|---|---|---|---|
| 40 (current) | 5 | 6 | 0 |
| 150 | 4 | 7 | 1 |
| 400 | 9 | 17 | 2 |

Reaching the window FORWARD so it covers audio that has not happened yet — a
`deep.lookaheadMs` prototyped and reverted — is worse still:

| lookahead | missed | spurious | required failures | overall exact | lead pitch class |
|---|---|---|---|---|---|
| 0 (current) | 5 | 6 | 0 | 78.6% | 92.9% |
| 100ms | 5 | 9 | 1 | 72.9% | 92.6% |
| 200ms | 12 | 12 | 3 | 53.2% | 65.2% |
| 400ms | 12 | 15 | 3 | 51.7% | 59.1% |
| 800ms | 8 | 25 | 3 | 39.0% | 65.0% |

The cause is attribution, not analysis. A job is queued for the Notes active at
that moment and its result is applied to them. Reach 200ms forward during a
167ms triplet run and the window covers the NEXT note, so the lane gathers
evidence about a Note's successor and files it under the Note. Chords degrade
more gently (cowboy 75% to 63%) precisely because their extra audio still
belongs to the same event, while the lead line collapses.

**This is the part the region lane changed.** `deep.regionSettleMs` waits for
the audio a region is about to finish arriving before analysing it, which is
not the latency measured above: that one delayed *applying* a window that
always ended at "now", and bought nothing. Waiting until a boundary has audio
on both sides of it is what makes the boundary visible at all.

Extra time is only worth having if the window stays INSIDE the Note it is about.
That means scheduling relative to a Note's own span — analyse its sustain, apply
it to that Note, and discard the result if the window has drifted past the
Note's end — rather than at a fixed offset from now. That is a different change
from "add latency", and it is the one worth making. It should be built and
tuned against recordings these constants have never seen, not against these 78
events.
