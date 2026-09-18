# Where the recogniser stands, and what the audio will and will not support

Measured on the committed fixtures. Every number here came from running the
code, not from reasoning about it. The five original 120bpm fixtures and their
thresholds are untouched — no label edited, no gate lowered. The 140bpm
fixtures added since are held-out data: new label files and additive
`eval.config.json` entries only, and no engine constant is fitted to them.

## Against the frozen baseline (docs/BASELINE.md)

| metric | baseline | before the region lane | before the flux reference | now | gate |
|---|---|---|---|---|---|
| labels missed | 12 / 78 | 5 / 78 | 4 / 78 | **3 / 78** | 0 |
| required fixtures failing | 2 | 0 | 0 | **0** | 0 |
| clean-lead pitch class (gated) | 77.4% | 92.9% | **96.3%** | 92.6% | 90% |
| clean-lead exact | — | 79.5% | **81.6%** | 76.9% | — |
| clean-lead false positives | 8 | 1 | **1** | 2 | 3 |
| power-chords onset median | 140ms FAIL | 113ms PASS | 113ms PASS | **PASS** | 120ms |
| chords-a-bm missed | 3 | 0 | **0** | **0** | — |
| cowboy 120 false positives | — | — | 4 | **2** | — |
| sixteenths detected, mic / DI / amp | — | — | 35 / 39 / 38 | **38 / 41 / 36** | 48 |
| events yielding more than one Note (whole corpus) | — | — | 98 / 459 | **97 / 459** | — |

The two clean-lead rows that went the wrong way are the price of the change,
and the section "What 48 detections would actually take" says exactly what was
traded for what. Both still clear their gates; nothing else on the five
originals moved except in the recogniser's favour.

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

**Followed up and acted on since.** Everything above is still true of the
threshold as a scalar, and the conclusion drawn from it — that the bar is set
by the note the pick is landing on — turned out to be the whole problem rather
than a curiosity. Forcing `fluxSensitivity` as high as 4 changes no decision on
any fixture and none on a synthetic steady low E, which confirms the median
term is inert; the fix was not to reweigh the terms but to stop measuring
either of them against the whole frame. See "What 48 detections would actually
take". The `restrumFluxRatio` note above is now also literally true and
harmless: it divides the held flux by a threshold whose binding term is
`0.1 x magnitude`, and it is used only over a ringing chord, where that is the
right thing to be relative to.

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

**And that reading of it was right, which is why the answer was elsewhere.**
The floor is what had to change, not the region it is applied over — but it had
to change per band and against a reference with no memory of the ringing note,
not globally. Judged that way the BROADBAND detector reaches all 48 labels on
all three takes on its own; the table above is the same evidence, seen through a
bar the ringing note was still setting.

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

## The constants are absolute milliseconds: built, measured, rejected

The section above ends by naming two of the fixed durations — `tracking.minStableMs`
and `transient.articulationMs` — as what loses the sixteenths, and notes that
both are pinned from the other side by the 120bpm fixtures. The obvious repair
is that they should not be fixed durations at all. `minStableMs` of 55ms is a
sliver of a whole note and half of a 107ms stroke; one number cannot be right
for both, which would explain why every sweep of it trades one fixture against
another. So the constants would stay and what they are measured in would change:
durations at a *reference* pace, read proportionally shorter when the music is
faster than that.

It was built and measured against the whole corpus, in the shape the argument
asks for, and it does not work. Recorded in full, because the reason it fails
also rules out a class of repairs rather than one attempt at one.

### What was built

A `PaceEstimator` holding a ring of the recent inter-onset intervals, fed from
every transient the fast lane accepted (in source time, allocation-free, no
clock). Its `paceMs` is the median of the last eight, ignoring gaps shorter than
`transient.minIntervalMs` — two transients closer than that are one articulation
— and dropped entirely after 1.5s of silence, so a pause falls back to the
reference. Deliberately one-directional: the estimate is clamped at the
reference, so material at or below the reference rate behaves exactly as it did
before, and only faster material is affected. Every duration named in the brief
was routed through it: `tracking.minStableMs` at four separate sites,
`transient.articulationMs` at both of its, `minRestrumMs`, `ringOutMs`,
`mutedRestrumWindowMs`, `tracking.releaseGraceMs`, `harmony.changeStableMs`.

### The reference pace, derived on the five originals

Sweeping the reference UPWARD scales the constants down harder at any given
pace, including inside the 120bpm sixteenth run itself, which is what makes the
number falsifiable on the derivation set rather than only on the held-out data.
Each site was swept alone, and the five originals were compared detection by
detection and label by label:

| the duration scaled | largest reference the five originals survive | what moves one step above it |
|---|---|---|
| `articulationMs`, attack-burst continuation | 167 | `cowboy` 12 -> 11 detections at 200 |
| `minRestrumMs`, re-striking a named chord | 167 | `chords-a-bm` 16 -> 17 detections at 200 |
| `minStableMs`, old enough to be ENDED | 143 | `clean-lead` 40 -> 39 detections and one label lost at 167 |
| `ringOutMs` | 143 | `clean-lead` +1 false positive at 167 |
| `minStableMs`, old enough to be ANNOUNCED | 125 | `clean-lead` +1 false positive at 143, +2 at 167 |
| `articulationMs`, absorbing a stub | below 125 | `clean-lead` 40 -> 41 detections at 125 — one extra false positive, with the eval's missed count unchanged at 4 |
| `changeStableMs` | below 125 | `cowboy` 12 -> 13 detections at 125 |
| `minUnpitchedStableMs`, the `enriching` promotion, the stability term, `mutedRestrumWindowMs` | inert at every reference tried | nothing moves at 250 |

Two of those are worth naming. `changeStableMs` is bounded by how long the
chroma path needs to turn over — a 4096-point transform run once every four hops
— and not by how fast the player is going, so scaling it is wrong in principle
and the fixtures agree. And `tracking.releaseGraceMs` is falsified outright
below.

### With a PERFECT pace estimate, nothing changes

The estimate can be wrong, and a fair test of the hypothesis has to separate "the
idea is wrong" from "the measurement is". So the estimator was replaced with an
oracle: the median gap between the LABELS within 700ms of now — the true local
note rate, which no causal detector can have.

| take, detections / labels | fixed constants | measured pace | ORACLE pace |
|---|---|---|---|
| sixteenths mic | 35 / 48 | 37 | 37 |
| sixteenths DI | 39 / 48 | 39 | 39 |
| sixteenths amp | 38 / 48 | 39 | 39 |
| lead line mic | 78 / 55 | 81 | 79 |
| lead line DI | 71 / 55 | 76 | 71 |
| lead line amp | 64 / 55 | 65 | 65 |
| `clean-lead` 120bpm | 40 / 43 | 41 | **36** |

Perfect knowledge of the tempo buys **nothing at all** on the sixteenths, which
is the thing this was built to fix. It does repair the damage to the lead takes,
which says the estimate is genuinely poor — and the last row says the idea is
wrong independently of that. Scaling by the TRUE note rate costs `clean-lead`
four detections and three labels on the derivation set. Instrumented per site,
one constant carries all of it: `tracking.releaseGraceMs`. How long silence must
persist before a Note has ended is a property of the instrument's decay and of
the amplitude gate, not of how fast the player is going, and the fixtures say so
in the only way that counts.

### Why the estimate is poor, and why a better one is not available

The measured pace against the truth, per take:

| take | median gap between LABELS | measured pace, p10 / median |
|---|---|---|
| sixteenths mic | 105 | 93 / 125 |
| sixteenths DI | 105 | 107 / 113 |
| sixteenths amp | 105 | 107 / 120 |
| lead line mic | 196 | 93 / 125 |
| lead line DI | 197 | 107 / 125 |
| lead line amp | 197 | **80 / 107** |
| the five 120bpm fixtures | 167 - 1920 | 113-125 / 125 |

On the amp path the estimator reads the lead take — 197ms per note — as FASTER
than the sixteenths take at 105ms. The inversion is not noise, it is the defect
measuring itself: the sixteenths take is missing a third of its onsets, which
stretches its intervals, and the lead take produces 86 accepted transients for
55 played notes, which shortens its. The rate estimate needed to fix the
segmentation is corrupted by the segmentation errors it is meant to fix, and
the two takes it must separate sit at the same tempo and differ only in
subdivision — which is precisely the quantity being mis-measured.

### The ceiling of the whole idea

Suppose the estimate were free to be anything. Forcing the scale factor to a
constant, from 1 down to 0.01 — every one of these durations driven to nothing —
bounds what shortening them can ever buy. Detections, and in brackets how many
of the 48 labels a detection actually lands on:

| factor | sixteenths mic | sixteenths DI | sixteenths amp | lead mic (55 labels) |
|---|---|---|---|---|
| 1.0 (today) | 35 (41) | 39 (46) | 38 (47) | 78 |
| 0.75 | 38 (42) | 39 (46) | 40 (47) | 86 |
| 0.5 | 43 (41) | 40 (46) | 44 (46) | 98 |
| 0.25 | 24 (23) | 40 (46) | 50 (46) | 96 |
| 0.1 | 28 (25) | 41 (46) | 51 (46) | 96 |

The detection count on the amp sim climbs past 48 and keeps going, and the
number of labels it lands on never moves. Shortening these floors does not
recover played notes; past a point it manufactures fragments, and on the room
mic it destroys the take outright. **No setting of any of these constants, at
any tempo, gets the sixteenths materially closer to 48.** (Still true, and
narrower than it reads: it is a statement about the tracker's duration floors,
measured while the fast lane was only offering 37 usable transients on the room
mic. It says nothing about the evidence, which turned out to be all there.)

### What the best version measured, end to end

The most defensible configuration — reference 143, every site scaled except the
three the originals rule out — run over all seventeen fixtures:

| fixture | detections before | after | missed before/after | fp before/after |
|---|---|---|---|---|
| chords-a-bm 120 | 16/16 | 16/16 | 0 / 0 | 0 / 0 |
| clean-lead 120 | 40/43 | **41/43** | 4 / 4 | 1 / **2** |
| cowboy 120 | 12/8 | 12/8 | 0 / 0 | 4 / 4 |
| power-chords 120 | 9/8 | 9/8 | 0 / 0 | 1 / 1 |
| spicy | 3/3 | 3/3 | 0 / 0 | 0 / 0 |
| sixteenths mic | 35/48 | **37/48** | 13 / **11** | 0 / 0 |
| sixteenths DI | 39/48 | 39/48 | 9 / 9 | 0 / 0 |
| sixteenths amp | 38/48 | **39/48** | 13 / **12** | 3 / 3 |
| lead line mic | 78/55 | **81/55** | 0 / 0 | 23 / **26** |
| lead line DI | 71/55 | **76/55** | 2 / **1** | 18 / **22** |
| lead line amp | 64/55 | **65/55** | 9 / **8** | 18 / 18 |
| cowboy mic/amp/DI 140 | 8, 11, 9 | 8, 11, 9 | unchanged | unchanged |
| power mic/DI/amp 140 | 23, 12, 11 | 23, 12, 11 | unchanged | unchanged |

Three sixteenths recovered across three paths, against eight extra Notes on the
lead takes, `clean-lead`'s gated pitch class 96.3% -> 92.6%, `chords-a-bm`'s
exact accuracy 83.3% -> 76.9%, and whole-corpus fragmentation 98/459 events
split with 109 extra Notes -> 107/459 with 121. Not kept. The mechanism is
sound, the estimator does what it says, and it does not pay for itself.

## What 48 detections would actually take — the ceiling claim was wrong

**This section previously concluded that the room-mic sixteenths take "cannot
reach 48 — it cannot reach 39" without letting the band-limited witness open
events. That conclusion was wrong, and it was refuted by direct measurement.
What follows replaces it.** The reasoning that produced it was sound about the
numbers it had and wrong about where they came from: it read the transient
count off the fast lane's output and treated that as a property of the audio,
when it was a property of one constant inside the flux kernel.

### What the audio actually contains

Raw broadband spectral flux against the PREVIOUS FRAME — N=1024, hop 256, local
maxima, above the 0.008 amplitude gate, 60ms minimum separation — on the
sixteenths takes:

| path | rule | candidates | labels covered | extras |
|---|---|---|---|---|
| mic | flux > 0.10 x frame magnitude | 71 | **48/48** | 23 |
| DI | flux > 0.10 x frame magnitude | 50 | **48/48** | 2 |
| amp | flux > 0.05 x frame magnitude | 76 | **48/48** | 28 |

All forty-eight strokes are reachable on all three paths, from a candidate set
of 50 to 76. The evidence was never missing. What was missing was a detector
willing to look at it.

### Why the old detector could not see them

`kernels/onset.ts` measured flux against a per-bin peak hold decaying at 0.95 a
hop — half a second of memory. That was a deliberate fix for a real problem
(see below), but during a ringing note the reference stays high, so a quiet
pick landing on top of a sounding note cannot raise any bin above it.
Instrumented over the corpus, the old kernel's own onsets covered:

| take | labels | old kernel covered | new kernel covered |
|---|---|---|---|
| sixteenths mic | 48 | 40 | **48** |
| sixteenths DI | 48 | 45 | **48** |
| sixteenths amp | 48 | 46 | **48** |
| the five 120bpm fixtures | 78 | 50 | **70** |

and, at the fast lane's output where the tracker can act on them:

| take | labels | accepted before | accepted after | covered before | covered after |
|---|---|---|---|---|---|
| sixteenths mic | 48 | 37 | 47 | 38 | **44** |
| sixteenths DI | 48 | 41 | 43 | 44 | **45** |
| sixteenths amp | 48 | 44 | 52 | 43 | **45** |
| clean-lead | 43 | 66 | 69 | 28 | **30** |

A second, compounding defect was found in the same file and is worth naming
separately, because it cost more than any threshold in the corpus: the kernel
armed its own minimum-interval dead time from onsets BELOW the caller's
amplitude gate — hops the fast lane was never going to act on. A note decaying
across the gate fires, and swallows the pick that lands 70ms later. On the five
120bpm fixtures that alone accounted for **fifteen of the seventy-eight
labels**. The kernel now takes the caller's gate as an argument.

### What replaced the decaying hold

Three changes, each derived on the five 120bpm fixtures only, by the method the
attack band was chosen by — highest label coverage available at an off-label
firing rate no worse than the detector it replaces:

1. **The reference is the per-bin maximum over the last three hops** (~32ms),
   and nothing older. Long enough to cover the unresolved-harmonic beating,
   far too short to remember a note.
2. **The decision is made band by band**, each band judged against its own
   magnitude and its own recent peak, with two bands required to agree. A
   threshold set as a fraction of the whole frame's magnitude is a bar the
   loudest thing sounding sets; per band, a ringing note is loud only where it
   lives. A band narrower than eight bins is merged into its neighbour: at
   fftSize 1024 the lowest band spans four and a half bins, and rectified flux
   over four bins is a coin toss, which is what let a stationary noise floor
   fire three or four times a second.
3. **The flux is still REPORTED against the old decaying hold, alongside the
   new one**, and the tracker uses each where it belongs. This is the part that
   is not obvious: the short reading is what can SEE a quiet pick land on a
   ringing note, and the long reading is what can tell that a compressed
   chord's sustain, however busy it looks hop to hop, has added nothing since
   the chord was struck. Measured on the amped cowboy take, the short reading
   cannot separate that take's sustain (sharpness 1.5-3.7, ratio 0.6-1.2) from
   its strums (1.9-8.6, 0.8-5.4) at all; the long reading separates them as it
   always did. Routing the whole tracker onto the short reading chops ringing
   chords; routing it onto the long one loses the sixteenths back down to 23 of
   48 on the room mic. Both were measured.

The steady-low-E ripple the peak hold was added for is real and has not come
back: `tests/onset.test.ts` holds it directly, and shortening the reference to
one hop fails that test.

### What it bought, end to end

| fixture | detections before | after | missed before/after |
|---|---|---|---|
| chords-a-bm 120 | 16/16 | 16/16 | 0 / 0 |
| clean-lead 120 (gated) | 31/31 | 32/31 | 1 / 1 |
| cowboy 120 | 12/8 | **10/8** | 0 / 0 |
| power-chords 120 | 9/8 | 9/8 | 0 / 0 |
| spicy | 3/3 | 3/3 | 0 / 0 |
| sixteenths mic | 35/48 | **38/48** | 13 / **10** |
| sixteenths DI | 39/48 | **41/48** | 9 / **7** |
| sixteenths amp | 38/48 | 36/48 | 13 / 15 |
| lead line mic | 78/55 | **64/55** | 0 / 3 |
| lead line DI | 71/55 | 78/55 | 2 / **0** |
| lead line amp | 64/55 | **61/55** | 9 / 13 |
| cowboy mic/amp/DI 140 | 8, 11, 9 | 8, 11, 9 | unchanged |
| power mic/DI/amp 140 | 23, 12, 11 | 20, 12, 10 | 1, 5, 7 / 2, 4, 7 |

Whole-corpus fragmentation went from 98 of 459 events split with 109 extra
Notes to **97 with 107**. Every required fixture meets every gate and
`npm run eval` exits 0.

### What is still true, and what the remaining gap is

The room mic emits 38 of the 48 strokes it now HAS evidence for 44 of, so the
remaining loss is downstream of the detector for the first time in this
document's history. The exhaustive ledger below still describes where those go.

And one thing measured in this pass deserves to be believed before the next
attempt at `clean-lead`'s fast run: **the true and false splits inside it are
not separable by any witness the engine has**. The transient at 12173ms that
opens a stub inside a played note reads sharpness 2.59, flux ratio 1.38, rise
0.98, and the labelled re-pick at 13720ms reads 2.16, 1.13, 0.83. Neither the
held-scale readings, the band witness, nor the envelope flag distinguishes the
two populations on that take. Whatever separates them is not in the transient,
and a threshold sweep will only trade one for the other — which is exactly what
every sweep of them did.

## The exhaustive ledger: every missed sixteenth, and the line that discarded it

Requested as the decisive version of the partial ledgers above. Every labelled
stroke on the three sixteenths takes with no detection paired to it under a
greedy nearest-match at +-70ms, and for each one, the test that rejected it.
Produced by instrumenting the tracker at the onset record, the re-articulation
decision, the settled test, `absorbArticulationFragment` and the never-announced
branch of `end()`, and reading the labels against the resulting trace.

| cause | mic | DI | amp | total |
|---|---|---|---|---|
| band-only transient; the fast lane may not act on it | 7 | 1 | 2 | **10** |
| a Note opened on this stroke, and the matcher paired it with a neighbouring label | 1 | 4 | 3 | **8** |
| re-articulation accepted, but the sounding Note was too young to be ended | 3 | 0 | 2 | **5** |
| rejected: gliding, and the envelope rise below `glideRiseOverride` | 1 | 3 | 1 | **5** |
| a Note opened and was never announced | 2 | 0 | 1 | **3** |
| absorbed as an articulation stub | 1 | 0 | 2 | **3** |
| rejected: no energy arrived and the transient was not sharp | 1 | 0 | 2 | **3** |
| no transient of any kind within 60ms | 0 | 1 | 1 | **2** |
| **missed** | **16** | **9** | **14** | **39** |

Per stroke, on the room mic:

```
s4  @4977  band-only transient                    s31 @7813  too young to be ended [sounded 40 < 55]
s6  @5213  paired with a neighbouring label       s32 @7918  band-only transient
s8  @5388  absorbed as an articulation stub       s34 @8135  too young to be ended [sounded 27 < 55]
s15 @6124  no energy, not sharp [1.12 < 1.2, 0.62 < 0.65]   s36 @8365  band-only transient
s16 @6250  gliding [rise 1.21 < 1.6]              s40 @8761  never announced [sounded 40 < 55]
s18 @6451  band-only transient                    s42 @8984  never announced [sounded 27 < 55]
s20 @6660  band-only transient                    s44 @9234  band-only transient
s28 @7462  band-only transient                    s46 @9475  too young to be ended [sounded 53 < 55]
```

Three things follow, and they agree with everything measured above.

**The fixed floors account for eleven of the thirty-nine**, and the eight
"too young" and "never announced" cases sit at 13, 27, 27, 27, 27, 40, 40 and
53ms. A floor scaled to a 107ms stroke is 41-47ms, depending on the reference:
it reaches the 53 and nothing else. A
floor scaled far enough to reach all of them is the 0.25 column of the limit
table, where the room-mic take collapses to 24 detections. There is no setting
in between that recovers them, which is why the estimator recovers three
strokes and no more.

**The largest single cause is not a threshold at all.** Ten of the thirty-nine
strokes — seven of the room mic's sixteen — were seen only by the band-limited
witness, which the tracker records and is not allowed to act on.

**Eight more are boundary placement rather than detection.** A Note opened on
the stroke and the matcher paired it with the label either side, which is the
pitch-path lag this document has named twice: a Note whose boundary is right
and whose first hops describe its predecessor. It is why the same takes
simultaneously miss labels and over-segment, and it is not a duration.

## The downstream ledger: every missed label, and the line that discarded it

The onset kernel reaches 44-45 of the 48 strokes on each sixteenths take and
the tracker emitted 36-41 Notes, so for the first time in this document the
losses are entirely downstream of the evidence. `scripts/measure-downstream-ledger.ts`
is the reproducible version of the hand-built ledgers above: it runs the real
engine, listens to `NoteTracker.trace` — every onset, every re-articulation
verdict with the test that decided it, every Note opened, absorbed and ended —
matches the detections against the labels with the eval's own matcher, and for
each missed label names the branch that discarded it.

It is built on the tracker's own decisions rather than on a re-implementation
of its rules, which is the whole point: a ledger that re-derives the rules
describes a version of the tracker that no longer exists. `npx tsx
scripts/measure-downstream-ledger.ts --detail` prints it per label, `--all`
covers every fixture.

### Before this pass

| cause | amp trip | amp 16th | DI trip | DI 16th | mic trip | mic 16th | total |
|---|---|---|---|---|---|---|---|
| a Note opened and a pitch step ended it before it could be announced | 6 | 3 | 0 | 0 | 2 | 4 | **15** |
| a Note opened and the matcher paired it with a neighbour | 1 | 3 | 0 | 4 | 1 | 3 | **12** |
| re-articulation accepted, the Note too young to be ended | 0 | 5 | 0 | 1 | 0 | 0 | **6** |
| rejected: gliding, rise below `glideRiseOverride` | 1 | 1 | 0 | 1 | 0 | 0 | **3** |
| no transient within 70ms | 0 | 1 | 0 | 1 | 0 | 2 | **4** |
| rejected: chord branch (`chord-not-sharp`, past `mutedRestrumWindowMs`) | 5 | 0 | 0 | 0 | 0 | 0 | **5** |
| absorbed as an articulation stub | 0 | 1 | 0 | 0 | 0 | 0 | **1** |
| rejected: no energy arrived and not sharp | 0 | 1 | 0 | 0 | 0 | 1 | **2** |
| band-only transient | 0 | 1 | 0 | 0 | 0 | 0 | **1** |
| missed | 13 | 15 | 0 | 7 | 3 | 10 | **48** |

The two partial ledgers this replaces pointed at `minStableMs`, `gliding`,
articulation stubs, band-only transients and the matcher. All five are real and
all five together are a minority: **the largest single cause was a pitch step
ending a Note two or three hops old**, which none of them had named.

### What that is

The attack transient is the least periodic part of a note, so a Note's first
hops report whatever was ringing before it. The estimator then catches up, and
what it reports is a *step*. That step ends the Note — which is too young to
have been announced, so it is dropped rather than emitted — and opens a
successor that is the same event, starting late with none of the stub's span.
Two picks, one Note, silently: the same shape as a burst boundary landing on a
Note's own start, which an earlier pass fixed on the re-articulation path.

Three changes, each derived on the five 120bpm fixtures:

1. **A step that ends a Note too young to be announced is renaming a stub**, so
   the successor absorbs it: boundary from the stub, name from the frames that
   describe what was played. Bounded by the announcement bar rather than by a
   duration — every longer bound tried costs `clean-lead` a labelled note.
2. **...and the reading it is leaving has to be one it cannot defend**: the
   name of the Note in front of it, or a pitch between that name and the one
   now arriving. On the room-mic sixteenths an F#5 answered by an E5 reads F5
   for two hops — a pitch nobody played. Without this test the lead takes gain
   three split events and two extra Notes.
3. **A stub that never described itself is a stub however long it lasted.** On
   the direct-input lead take an attack fires 52ms before the string speaks and
   opens a Note that spends its whole 67ms life reporting the pitch still
   ringing, clears the announcement bar on that, and is then renamed. The
   second condition is not a duration: every vote the Note holds is for the
   reading it is now leaving.

Absorbing lends a boundary, not evidence: a stub a step shed is the previous
note still ringing, so its hops do not count toward the successor's
announcement (`NoteRecord.announceSoundedMs`). Without that a 40ms stub and a
53ms tail add up to a Note where neither was one, which
`tests/engine/note-tracker.test.ts` holds directly.

And separately, **a pitch that "differs" has to differ by a real step in cents
rather than by rounding to another name.** `pitchDiffers` compared
`nearest.midi` against the Note's voted name, and a note sitting 40 cents sharp
of D5 reads as D#5 — so a held quarter note with vibrato on it changed name
every few hops without the frequency having gone anywhere, and shed a Note when
it did. The bend guard immediately below it has always measured in cents.

### Measured, end to end

| fixture | detections before | after | missed before/after | fp before/after |
|---|---|---|---|---|
| chords-a-bm 120 | 16/16 | 16/16 | 0 / 0 | 0 / 0 |
| clean-lead 120 | 42/43 | 41/43 | 3 / 3 | 2 / **1** |
| cowboy 120 | 10/8 | 10/8 | 0 / 0 | 2 / 2 |
| power-chords 120 | 9/8 | 9/8 | 0 / 0 | 1 / 1 |
| spicy | 3/3 | 3/3 | 0 / 0 | 0 / 0 |
| sixteenths mic | 38/48 | 38/48 | 10 / 10 | 0 / 0 |
| sixteenths DI | 41/48 | 41/48 | 7 / 7 | 0 / 0 |
| sixteenths amp | 36/48 | **37/48** | 15 / **14** | 3 / 3 |
| lead line mic | 64/55 | **63/55** | 3 / 3 | 12 / **11** |
| lead line DI | 78/55 | **76/55** | 0 / 0 | 23 / **21** |
| lead line amp | 61/55 | 66/55 | 13 / **9** | 19 / 20 |
| cowboy mic/amp/DI 140 | 8, 11, 9 | unchanged | unchanged | unchanged |
| power mic/DI/amp 140 | 20, 12, 10 | unchanged | unchanged | unchanged |

`clean-lead`'s gated pitch class (92.6%) and exact accuracy (81.5%) are
unchanged, every required fixture meets every gate, and the amped sixteenths
take now passes its own informational gate. Whole-corpus fragmentation goes
**97 of 459 events split with 107 extra Notes to 97 with 105**.

The amped lead take is the one row that gains detections, and it gains four
labels with them: 13 missed to 9, against one extra false positive. It is the
take whose saturation makes a lead line read as harmonic, and the section below
says what is still eating its notes.

### Where the remaining 43 go

| cause | amp trip | amp 16th | DI trip | DI 16th | mic trip | mic 16th | total |
|---|---|---|---|---|---|---|---|
| absorbed as an articulation stub | 6 | 1 | 0 | 0 | 2 | 2 | **11** |
| the split was made; its Note took a neighbour's label | 0 | 2 | 0 | 4 | 1 | 3 | **10** |
| re-articulation accepted, the Note too young to be ended | 0 | 5 | 0 | 1 | 0 | 1 | **7** |
| no transient within 70ms | 0 | 1 | 0 | 1 | 0 | 2 | **4** |
| rejected: gliding, rise below `glideRiseOverride` | 1 | 1 | 0 | 1 | 0 | 0 | **3** |
| a Note opened and was never announced | 2 | 1 | 0 | 0 | 0 | 0 | **3** |
| rejected: no energy arrived and not sharp | 0 | 1 | 0 | 0 | 0 | 1 | **2** |
| band-only transient / no successor / no boundary | 0 | 2 | 0 | 0 | 0 | 1 | **3** |
| missed | 9 | 14 | 0 | 7 | 3 | 10 | **43** |

Six of the amped triplet take's nine are one event: a Note that blooms into a
chord at the end of a phrase reaches back with `absorbAttackFragments` and
swallows four played notes, each inside `mergeMaxFragmentMs` and inside
`mergeLookbackMs`. On a saturated amp sim a lead line reads harmonic, so the
one path that protects a strummed chord's fragments is applied to a run of
single notes. Two containments were measured and both are worse (below).

### The same-pitch branch is not what loses the sixteenths

Instrumented directly, because it is the obvious suspect and it is innocent.
Every same-pitch re-articulation decision on the room-mic sixteenths take, in
the monophonic no-fit fallback:

```
  44 decisions, 42 accepted, every one of them on a labelled stroke
  the two rejections:  s3 @4893  env 1.04  sharp 0.87  rise 1.19  (no-energy-not-sharp)
                          @6200  env 1.08  sharp 5.28  rise 1.21  (glide-rise)
```

Forty-two of the take's forty-eight strokes get a boundary out of that branch.
What the take is short of is not boundaries; it is Notes that survive to be
emitted and land where the matcher can pair them, which is what the ledger
above says line by line.

### Measured in this pass, and not kept

| change | result |
|---|---|
| `arrivalBands`: report how many of the onset kernel's bands showed arrival, and require a broad arrival for a same-pitch re-pick | the count does not separate on-label from off-label onsets on the derivation fixtures (clean-lead: on-label 2:13 3:15 4:5, off-label 2:6 3:9 4:6), and gating on it costs clean-lead nine detections and nine labels at 3 bands. As an ESCAPE instead of a gate it is inert at every reachable value. Built, measured, reverted |
| let the `settled` test pass when the Note had already peaked (`STILL_RISING_FRACTION`) | recovers strokes and breaks the derivation set: clean-lead 40 detections, 5 missed, gated pitch class 84.0%, required gate FAILS |
| require the `settled` test to ALSO see a Note past its peak | clean-lead 84.0% pitch class, gate fails again, and the amped triplet take collapses to 47 detections with 21 missed |
| a pitch step must leave the Note's voted NAME, not merely the last reading | clean-lead 42 -> 41 detections with a labelled note lost, amp sixteenths 37 -> 33, DI sixteenths 41 -> 39 |
| in `absorbAttackFragments`, refuse a candidate that had already peaked | chords shatter: `spicy` 3 detections -> 6, `cowboy` 120 10 -> 11, `cowboy` mic 140 8 -> 9, fragmentation 97/105 -> 104/114 |
| in `absorbAttackFragments`, refuse a candidate YIN was confident about (`maxMonophonicConfidence`) | the originals hold, but the amped triplet take gains ten Notes (66 -> 76) and fragmentation goes 97/105 -> 100/108. The bloomed Note stops eating four notes and the take sheds more elsewhere |
| accept a same-pitch re-articulation when the onset KERNEL fired, as against the envelope witness | clean-lead's false positives 1 -> 3 and the room-mic lead take 63 -> 70 detections. Qualified by an envelope rise it becomes a new constant the derivation set cannot pin: the five 120bpm fixtures are bit-identical at 1.05, 1.1, 1.15 and 1.2, so any value in that range is fitted to held-out data. At the one value the derivation set does move (1.0, where clean-lead's pitch class goes 91.7% -> 94.4%) the room-mic lead take goes 63 -> 69. Recorded rather than kept: it buys one sixteenth on the room mic for three extra Notes on the room-mic lead take, which is the frontier every previous sweep died on |

### The `settled` bar is two milliseconds off, and closing it costs more than it buys

Ten labels are lost to `note-tracker.ts process()` refusing an ALREADY-ACCEPTED
re-articulation because the Note it would end was too young. Eight of the ten
lose by the same two milliseconds:

```
  s4  E5@4058  n5  opened@3933 attack       sounded=53  bar=55  via envelope-rise
  s8  F#5@4467 n12 opened@4387 attack       sounded=53  bar=55  via sharpness
  s12 E5@4903  n16 opened@4813 pitchChange  sounded=27  bar=55  via envelope-rise
  s18 E5@5504  n19 opened@5387 attack       sounded=53  bar=55  via envelope-rise
  s26 E5@6353  n25 opened@6227 attack       sounded=53  bar=55  via envelope-rise
  s30 F#5@6763 n30 opened@6733 pitchChange  sounded=53  bar=55  via sharpness
  s40 F#5@7828 n39 opened@7747 attack       sounded=53  bar=55  via envelope-rise
```

That is arithmetic, not evidence. The fast hop is 13.3ms at 48kHz, so a Note
that sounds for four hops has sounded 53.3ms and `minStableMs: 55` means five
hops. The bar reads as a duration and behaves as a hop count.

Two ways of closing it were built and both are worse than leaving it:

| change | result |
|---|---|
| `minStableMs` 55 -> 50 (four hops) globally | total missed 41 -> 39, but the required `chords-a-bm-g-d` take loses a label for the first time (16/16 -> 15/16 detections, 1 missed), the room-mic cowboy take goes 11 -> 15 detections and the amped triplet take 1 -> 3 missed |
| `minStableMs` 55 -> 40 globally | total missed 41 -> 37 with the same `chords-a-bm-g-d` regression |
| a separate `minAttackStableMs: 50` applied only to Notes that opened on their own transient | total missed 41 -> 46. The room-mic sixteenths take goes 10 -> 13 missed and `chords-a-bm-g-d` still loses its label |

The shape is consistent in all three: ending Notes sooner produces more and
shorter Notes, which are then absorbed or paired with a neighbour, and the
labels recovered at the `settled` test are lost again one step downstream. The
bar is not what is holding these strokes back — what happens to a short Note
after it is created is. Recorded so the two-millisecond miss is not mistaken
for an easy win a third time.

## A bend moves energy; a pick brings some. The glide guard could only see one

Three of the ledger's missed labels were discarded by one line — `gliding &&
riseRatio < glideRiseOverride` — and a fourth on `clean-lead`, the derivation
fixture, by the same line. The guard is right about what it is for. A bend
sweeps the spectrum and fires both attack witnesses repeatedly inside one note,
so an attack arriving mid-glide has to prove that energy ARRIVED rather than
merely moved.

What it had to prove it with was the wrong witness. `riseRatio` is the
20ms envelope over an 80ms baseline, and in a run picked at 107ms that baseline
already contains the stroke before this one, so the ratio is structurally
compressed exactly where the guard asks its hardest question. Instrumented at
the four labels it discards:

```
  fixture           label   glide     rise   sharpness   flux ratio   kernel
  amped triplet     t12     -74c      1.20   10.51/2.62  3.22/1.77    fired
  amped sixteenths  s20      43c      1.37    2.36/0.49  1.24/0.57    fired
  DI sixteenths     s26      29c      1.16    2.72/0.98  1.47/1.16    fired
  clean-lead        (fast run)         1.21    5.28/-     -           fired
```

Two of the three "glides" are 29 and 43 cents — the pitch estimate wobbling
across a fast alternate-picked run, not a bend — and every one of the four has
a transient the flux kernel fired on.

**The kernel already answers the question the guard is asking.** Its decision is
made band by band, and a band only votes when it is LOUDER than its own recent
peak, which is precisely "energy arrived here" as against "energy moved from
the bin next door". That test exists for vibrato, which sweeps every partial
across its neighbours and makes no band louder; a bend is the slow monotonic
form of the same thing. So mid-glide the guard now takes either witness: an
unmistakable envelope rise, or the kernel having fired at all.

`tests/engine/articulation.test.ts` holds the synthetic A3->B3 bend and the
vibratoed A3 as one Note each with the escape open, which is the case the guard
exists for, stated as a signal rather than as a threshold.

### Measured, end to end

| fixture | detections | missed | false positives | gated pitch class |
|---|---|---|---|---|
| `clean-lead` 120bpm | 41 -> **42** | 3 -> **2** | 1 -> 1 | 92.6% -> **92.9%** |
| `chords-a-bm` 120bpm | 16 -> 16 | 0 -> 0 | 0 -> 0 | unchanged |
| `cowboy` 120, `power-chords` 120, `spicy` | unchanged | unchanged | unchanged | unchanged |
| lead line amped triplet | 66 -> 68 | 9 -> **8** | 20 -> 21 | — |
| lead line mic triplet | 63 -> 64 | 3 -> 3 | 11 -> 12 | — |
| lead line DI triplet | 76 -> 76 | 0 -> 0 | 21 -> 21 | — |
| sixteenths amped | 37 -> **38** | 14 -> **13** | 3 -> 3 | 70.8% |
| sixteenths DI | 41 -> **42** | 7 -> **6** | 0 -> 0 | 85.4% -> **87.5%** |
| sixteenths mic | 38 -> **39** | 10 -> **9** | 0 -> 0 | 72.3% |
| everything else | unchanged | unchanged | unchanged | unchanged |

Whole corpus: **+7 detections, -5 missed labels, +2 false positives**, both of
the extra Notes on lead takes that were already over-segmenting. The
`glide-rise` cause is now zero everywhere, including on the derivation fixture,
and `npm run eval` still exits 0 with every required fixture meeting every
gate.

## Where the remaining evidence-side losses actually are

The four causes upstream of the tracker, measured one label at a time with
`scripts/measure-label-evidence.ts` — a hop-by-hop mirror of `kernels/onset.ts`
that is checked against the real kernel on every hop of every fixture before
anything is read off it (`--verify`: 0 disagreements over 26971 hops).

Every contrast below is computed WITHIN one file. Recording levels differ by
orders of magnitude between the three signal paths, so a figure compared across
files measures the recording rather than the playing.

### Two of them are not in the audio, and the labels say so themselves

`s14` on the direct-input and amp-sim sixteenths takes. The DI label file's own
derivation note says it: three of its onsets (`s14`, `s15`, `s34`) "had no flux
peak within 45ms of where the beat puts them", and their times are an even
subdivision of the surrounding beat rather than a measurement. The amp-sim
labels are the DI labels shifted by the measured +2ms, so it is the same
instant on the same performance.

Measured independently, by the performer's own method — the peak of a 1ms RMS
envelope of the 5kHz-highpassed signal in [-25, +45]ms of each label, against
that file's own median:

```
  direct input   s14  0.56x the file's median   every other stroke  2.4 - 5.1x
                 s6   0.73x                     (s6 is a miss too)
  amp sim        s14  1.18x                     every other stroke  1.8 - 2.6x
```

This is the documented-exception case: analysis shows there is nothing there.

### The other five are real strokes, and each is a hair's breadth

| label | take | evidence at the label | what discarded it |
|---|---|---|---|
| `s28` @7462 | mic 16ths | hp5k peak **13.9x** the file's median | kernel: two bands arrived, held corroboration 0.85 of its bar |
| `s30` @7704 | mic 16ths | **14.1x** | kernel: one band; the second measured `BAND_RISE` 1.04 against 1.05 |
| `s3` @4891 | mic 16ths | **39.6x** — one of the loudest attacks on the take | `no-energy-not-sharp` on a reading taken 13ms before the string spoke |
| `s24` @6139 | amp 16ths | **1.80x**, inside the 1.8-2.6 band of the take's real strokes | `no-energy-not-sharp`: env 1.18 against a bar of 1.20 |
| `s10` @4703 | amp 16ths | **2.36x** | band-only: the broadband kernel's dead time, armed at `s9`, ran to 4686 and it fired nothing after |

For scale, the five strokes the room-mic label file itself places by
subdivision rather than by measurement (`s6`, `s14`, `s16`, `s18`, `s20`)
measure 3.3 - 7.5x on the same figure, and the strokes the detector finds run
9.5 - 56x. All five above sit in the detected population. A listener would call
every one of them a note.

### The attack is a burst, and the tracker is handed its weakest hop

Three of those five are the same defect, and it is worth stating even though
the repair measured below was not kept. `s3` is the clearest instance: the
kernel fires at 4893 with sharpness 0.87, the tracker rejects the
re-articulation on that reading, and 13ms later the same arrival reads several
times sharper — but the kernel's `minIntervalMs` dead time, armed by its own
first firing, suppresses it. A pick is not one hop: pick noise arrives, then
the string speaks.

### Built, measured, NOT kept: one onset, two readings

The repair keeps `isOnset` as one onset per articulation — `tests/onset.test.ts`
holds that contract and it is right — and adds a second, separate report:
`OnsetResult.stronger`, true when a hop cleared the arrival test, was held back
only by the interval, and is strictly sharper than the burst has already been.
There is no threshold in it; "sharper than itself" is not a constant. The fast
lane forwards it as `AttackEvidence.continuation`, which the tracker treats as
the reading the decision should have been taken on rather than as a second
pick: it does not extend the attack burst, it does not clear the pitch
estimator's history a second time, and it may not re-decide an articulation
already accepted.

It is the largest single move on the held-out data in this document:

| fixture | detections | missed | false positives |
|---|---|---|---|
| `power-chords-di` 140 | 12 -> **16** | 4 -> **0** | 0 -> 0 |
| sixteenths DI | 42 -> 42 | 6 -> 6 | 0 -> 0 |
| sixteenths mic | 39 -> 39 | 9 -> 9 | 0 -> 0 |
| sixteenths amped | 38 -> 38 | 13 -> 13 | 3 -> 3 |
| whole corpus | **+11** | **-7** | +4 |

and it fails the derivation set, which is what decides it. `clean-lead`'s gated
pitch class goes 92.9% to **86.7%** against a required gate of 90%, and two
labels change hands: `t4` is lost outright, and `t16` — which this document
already records as a Note the recognizer is right to ABSTAIN on, because its E5
is not in the signal — is given a confident `D5` instead. Both are inside the
triplet run, which is the pitch-path lag this document has named three times.

Requiring the second reading to beat the first by a factor was swept, and the
sweep is the familiar frontier rather than a way out:

| factor | required failures | `clean-lead` | `chords-a-bm` |
|---|---|---|---|
| 1.0 (any stronger reading) | 2 | 42 det, 3 missed, **86.7%** | 16/16, 0 missed |
| 1.5 | 1 | 42 det, 3 missed, 86.7% | 16/16, 0 missed |
| 2.0 | 0 | 42 det, 2 missed, 90.0% exactly | **17 det, +1 false positive** |
| 2.5 | 0 | 42 det, 2 missed, 90.0% exactly | **1 missed, +1 false positive** |

Every value that clears the gate moves a derivation fixture the wrong way and
leaves `clean-lead` sitting exactly on its bar. Recorded in full rather than
kept: the mechanism is sound, the evidence it recovers is real, and what stops
it is that the triplet takes' boundaries and pitch evidence already disagree —
so making the detector more willing to find boundaries there costs more than it
buys. It should be re-tried once the pitch path stops running 90ms behind the
transient path.

### Also measured in this pass, and not kept

| change | result |
|---|---|
| `HELD_CORROBORATION` 0.45 -> 0.35, the other end of the band this document derives it in | the five 120bpm fixtures are bit-identical, exactly as recorded, and the held-out takes go +5 detections, -2 missed, **+3 false positives**. It does not reach `s28` — the engine's hop grid puts no hop where the mirror's does — so it is a change with no derivation-set evidence for it, fitted to held-out data, that loses more Notes than it finds. Not kept |

## The mute is the cleanest witness in the corpus, and nothing reads it

Three labels on the amped power-chord take are lost to
`rearticulation.ts: polyphonic && !sharpEnough()`. Every decision on that take,
hit and miss, with the bars at `restrumSharpness` 0.9 and `restrumFluxRatio`
1.3:

```
  MISS p2  held=0.73 hfr=0.77   rise=1.04 env=1.07
  MISS p8  held=0.84 hfr=0.75   rise=1.10 env=1.02
  MISS p16 held=1.60 hfr=1.17   rise=1.07 env=1.01
  ok   p4  held=2.28 hfr=1.50   rise=1.01 env=1.00
  ok   p10 held=2.87 hfr=2.10   rise=0.92 env=1.01
  ok   p12 held=1.71 hfr=1.61   rise=0.95 env=1.02
  ok   p14 held=1.65 hfr=1.42   rise=1.13 env=1.09
```

The accepted and rejected strokes are the same event played the same way — a
muted restrum, energy flat or down on every one of them, which is why only
sharpness can carry the case. The amp sim's compression has taken the flux
down on three of them and there is no other witness in the branch. Lowering
either bar to reach `p16` at 1.17 leaves `p2` and `p8` at 0.77 and 0.75, and
the sweeps that end at this frontier are recorded above.

**The evidence is not in the strike. It is in the mute that follows it.**
`scripts/measure-mute-witness.ts` measures the energy 40ms after each stroke
against the lowest over the following third of a second:

```
  path        odd strikes (answered)   even strikes (muted)   gap
  amp sim     0.885 - 1.061            0.243 - 0.641          0.641 | 0.885
  room mic    0.932 - 1.498            0.229 - 0.538          0.538 | 0.932
  direct      0.455 - 0.604            0.037 - 0.140          0.140 | 0.455
```

Forty-eight strokes, forty-eight on the correct side, on all three signal
paths. Nothing else measured in this project separates that cleanly, and the
reason is physical rather than statistical: a mute REMOVES energy, and removal
is not something a compressor, a room, or a decaying string can imitate. Every
other witness tried here asks whether energy ARRIVED, which is the question the
recording path distorts most.

Read within a file only. The direct take's ANSWERED strokes sit at 0.455, below
the amp take's MUTED ones at 0.641, so a bar chosen across paths measures the
recording — the trap this document records several previous versions of.

**What to do with it.** A mute is the end of something somebody played. A
transient that the re-articulation detector rejected for being too weak,
followed by a mute, is a rejection the mute contradicts. The contradiction
arrives after the decision, which is exactly the case the deep lane and the
structural-revision protocol exist for: hold the rejected candidate, and when
the chord is stopped rather than left to ring, make the boundary retroactively
with a backdated start.

The guard that keeps this from inventing notes is that a rejected TRANSIENT has
to exist: a single strike left to ring and then stopped has nothing to
resurrect. The mute's own hand noise must not be the candidate either, which
the gap makes checkable — the measured collapse is 160ms or more after the
transient it would corroborate.

Not yet implemented. Recorded with its measurement so the implementation starts
from evidence rather than from the idea.

## The room mic names a power chord as a triad, and it is an octave error

The two remaining informational eval failures are both `minLabelAccuracy
(exact)` on power chords, and neither is a detection failure — every strike is
found. They are naming failures, and the room-mic take is the clear one: of its
seven scored labels, three are named `B`, `B` and `E` where the player fretted
`B5`, `B5` and `E5`. Naming a triad is a claim about a third nobody played.

One performance, three signal paths, three answers: direct 15 of 16 exact,
amp sim 11 of 13, room mic 4 of 7.

`scripts/measure-chord-voicing.ts` prints what the multi-pitch analyser finds
at each chord, with register. The direct and mic takes on the same strike:

```
  direct  p1 B5   B2(+0,root)  F#3(+7,fifth)
  mic     p1 B5   F#3(+0,fifth) B3(+5,root)  D#5(+21,THIRD,s=0.37)
```

The mic take has no `B2`. Its lowest activation is the FIFTH, an octave and a
fifth above where the direct take finds the root. And `D#5` sits exactly 28
semitones above the missing `B2`, which is its fifth partial — a partial of a
fundamental the analyser never detected, so cancellation had nothing to
subtract it from. The `Esus2` and `Gsus2` misnames are the same shape one
harmonic along: `A4` is 19 semitones above `D3`, the third partial of the
fifth.

**Three discriminants were measured and none of them separates.**

| tried | why it fails |
|---|---|
| the third's chroma strength relative to the root | amp-sim power chords carry a third at 0.60–1.08 of the root; real cowboy triads carry one at 0.66–1.26. The populations overlap almost completely, because on an amplified guitar the fifth partial is as strong as a fretted note |
| the third's register above the bass | false thirds sit at +16 and +21 semitones; real fretted thirds in the corpus sit at +4, +8, +9, +15 and +16. +16 is on both sides |
| the third's salience among the activations | false thirds 0.29–0.62, real thirds 0.29–0.86. Overlapping |
| "an activation at an integer harmonic of a lower activation is a partial" | correct in principle and inert here: the fundamental these partials belong to is the one that was NOT detected. There is nothing lower to test them against |

The mechanism is understood exactly and the fix is not a rule in the
interpreter. It is upstream: the mic take's bass is detected an octave and a
fifth high, and every downstream error follows from that one miss. Recorded
here so the next attempt starts at the octave error rather than at the third.

### The mic has 5% of the fundamental, and that is not a detector defect

Following the octave error above to its source. Measuring the partial series of
the same `B5` strike on all three signal paths, each normalised within its own
file (`scripts/measure-missing-fundamental.ts`):

```
  partial of B2   direct   amp sim   room mic
  n=1  123.5Hz     0.726    0.714    0.037    <- the fundamental
  n=2  246.9Hz     0.439    0.641    0.619
  n=3  370.4Hz     1.000    1.000    1.000
  n=4  493.9Hz     0.775    0.601    0.384
  n=6  740.8Hz     0.437    0.611    0.966
```

The room mic has 5% of the fundamental the direct input has. Nothing in the
recognizer did that: a guitar speaker and a room rolled 123Hz off before the
signal reached the file, and the multi-pitch analyser is correctly reporting
what is present. Chasing this at the interpreter, at cancellation, or at the
bass picker would all be chasing audio that is not in the recording.

The remaining partials still determine the note — 247, 370, 494 and 741 are the
2nd, 3rd, 4th and 6th of 123.5, and no other fundamental in the guitar's range
explains all four. So the answer is the classic missing-fundamental inference:
estimate the bass from the SPACING of the partials rather than from the lowest
peak. Harmonic-product-spectrum or subharmonic summation is the standard shape.

This is worth more than the three labels it currently costs. Microphone input
is the case this library exists for, and a mic is exactly where the fundamental
goes missing — the same rolloff will move every bass-dependent answer on any
mic'd rig: inversions, slash names, and the register in `detectedPitches`.
### A same-pitch boundary the next attack contradicts: built, measured, reverted

A same-pitch re-articulation cannot be judged when it is made. In the eighth
note run at 13.3s of the amped triplet take the tracker cuts B4 in two at
13440 and every energy witness says nothing arrived — envelope 0.95 against the
Note's own baseline, rise 1.02, and the string 0.72 of the way below its own
decay curve — while the flux figures there are HIGHER than at the real attack
67ms later, because a saturated amp path churns the spectrum in sustain harder
than a pick does. No threshold at the moment of the decision separates that
from a player genuinely re-picking a ringing string.

So the boundary was reconsidered afterwards instead, which is what the
structural-revision machinery exists for. The rule: a Note opened by an
accepted SAME-pitch re-articulation, ended within one articulation by a
genuine PITCH-CHANGING attack, and voting the same pitch class as its
predecessor, was never an event — it goes back into its predecessor the way
`mergeWithinSegment` does, with the predecessor's end extended and a
`structuralRevision` emitted.

It works, and it costs more labels than it buys events:

| bar (`soundedMs <`) | events split | extra Notes | labels missed |
|---|---|---|---|
| rule off | 83 / 459 | 85 | 35 |
| 67 / 68 / 80 (`transient.articulationMs`) | 72 / 459 | 74 | **39** |
| 94 | 66 / 459 | 68 | **43** |
| 107 | 65 / 459 | 67 | **43** |
| 120 | 64 / 459 | 66 | **43** |
| 134 | 63 / 459 | 65 | **45** |

Every value that removes extra Notes loses labels, monotonically, and the
labels it loses are all on the sixteenths takes: `s4`, `s29` (amped),
`s5`, `s25`, `s41`, `s45` (room mic), `t2` (room mic triplet). Those takes
alternate E and F# in groups of four, so a same-pitch re-pick 107ms apart is a
real event there, and the Note the rule swallows is the label's OWN detection
sitting +9ms from its annotated onset.

Three discriminators were built and measured against the fifty merges the rule
performs:

| discriminator | result |
|---|---|
| a lower bound on the fragment as well as an upper one (`soundedMs` in [41,80), [54,80), [61,80)) | 71 / 459 split, 73 extras, missed 39 -> 38. The populations overlap: the good merges on the amped triplet take sound 27, 40, 53 and 67ms and the bad ones on the sixteenths takes sound 27, 40, 53 and 67ms |
| require the boundary to have had no energy behind it (`restrikeEnvelope < 1` AND `decayExcess < 1`) | 75 / 459 split, 77 extras, missed 38. No separation: good merges run env 0.84-1.05, bad ones 0.64-1.15 |
| undo only a LONE same-pitch boundary, never one whose predecessor was itself the child of a same-pitch split | inert — 72 / 459 split, 74 extras, missed 39, unchanged. The sixteenths predecessors are not same-pitch children, so the chain test never fires |

The trade is real and it is the wrong way round: eleven fewer spurious Notes
for four fewer detected notes, on a recogniser whose first requirement is to
detect every labelled note. Reverted rather than kept. What the measurement
does establish is that the retroactive direction is sound — the boundary IS
false and the revision machinery does remove it cleanly — and that the missing
piece is a way to tell a lone artefactual same-pitch split from a real re-pick
that neither duration, energy, nor chaining supplies. The next thing to try is
not another witness at the boundary but the inter-onset interval the take has
established by then: the false split makes a stroke that is half its
neighbours', and the real re-pick makes one the same length as its neighbours'.

### `transient.articulationMs` is not what holds the attack stubs back

`absorbArticulationFragment()` is meant to swallow a Note that opened before
its pitch arrived, and the standing guess was that its 80ms bound is simply
shorter than the estimator's lag. `scripts/measure-articulation-stubs.ts`
counts every offer made to it, keyed by the call site that made it, and the
guess does not survive the count:

```
  attack / too-long              267      pitchChange / ABSORBED         59
  attack / bloomed                59      pitchChange / already-falling  35
  attack / already-falling        23      pitchChange / too-long         22
  attack / ABSORBED                6
```

The two call sites answer different questions and only the second is about
stubs. The 267 refusals at the attack site are Notes a re-articulation had just
ended — whole notes, correctly refused. At the pitch-step site, which is the
one that offers a stub of the note now arriving, `too-long` fires 22 times with
a median duration of 293ms; those are not stubs either. Raising
`articulationMs` reaches almost none of the shape it was supposed to reach.

### The labels are not annotated late; the attack search was reading the wrong stroke

Worth writing down because it has now been inferred twice from the same
artefact, and because a conclusion that the ground truth is wrong would license
changing it.

`scripts/verify-fixtures.ts` reported each label's nearest energy rise within
`ONSET_SEARCH_MS` (150). A sixteenth note at 140bpm is 107ms, so that window
reaches a stroke and a half in each direction, and an unbounded nearest-attack
search happily returns the PREVIOUS stroke's transient. Read naively that says
the label is annotated 100ms late.

It is not. Of the labels whose nearest attack sat 30ms or more early:

```
  take                       early    within 25ms of the PREVIOUS label's onset
  amped sixteenths            19                19
  room-mic sixteenths         16                11
  DI sixteenths                4                 4
  amped triplet                3                 3
  DI triplet                   1                 1
  clean-lead 120bpm           12                 0
```

Every one of them on the fast held-out takes is the neighbour, landing one
subdivision back. Bounding the search at the midpoint between adjacent labels
moves the amped sixteenths take from p10 −98ms / median −11ms to p10 −12ms /
median −3ms, and the room mic from −97/−12 to −21/−8. The labels sit on the
attacks.

This is the third instance of the same class of error in this project — a
window wider than the spacing of the events it discriminates. The other two
were the fragmentation metric's 120ms ownership tolerance and the downstream
ledger's absorb attribution, and all three inflated a number in the direction
of blaming something innocent.

A second thing the bound exposes, which is not a defect: with the search
correctly narrowed, 105 labels have no energy rise of their own. That is
expected and is reported rather than counted against them. A legato or tied
note never re-attacks, and a MUTED restrum damps the strings — it puts total
energy DOWN while plainly re-articulating the chord — so eight of the sixteen
strokes on each power-chord take have no rise by construction. `SEPARATED` in
`measure-mute-witness.ts` is the evidence that all of them are real. Only
inaudibility or an absent pitch class can put a label on the exception list,
and that list is unchanged at three.
## The pitch path does not lag on the material that misnames — measured

This document has named "the pitch path runs about 90ms behind the transient
path" three times, and the reasoning behind it is sound as far as it goes: a
frame is stamped at the END of the window it analysed, the long YIN window is
2048 samples (43ms at 48kHz), and the temporal median needs several hops to
turn over. From that it follows that a Note opening on an attack spends its
first hops voting on its predecessor's audio.

The hypothesis that follows from it is testable: **a frame whose analysis window
straddles a Note's own start is not evidence about either Note and should not
vote.** It is derivable rather than fitted — the window length is the
estimator's own and `PitchEvidence.source` says which window won — so it costs
no new constant. It was built, measured on the whole corpus, and it is wrong in
both of its premises.

### The window is not 43ms on the material that misnames

`scripts/measure-pitch-lag.ts` reports, per fixture, the confidence-weighted
vote mass from hops whose window reaches back past the Note's own start:

| take | vote mass straddling | of it, wrong | short window wins |
|---|---|---|---|
| lead line amped triplet | 9.8% | 23.8% | **88%** |
| lead line DI triplet | 9.3% | 31.9% | **90%** |
| lead line mic triplet | 8.0% | 59.0% | **91%** |
| sixteenths mic / DI / amped | 11.3 / 9.4 / 11.6% | 26.7 / 5.0 / 16.2% | **89 / 84 / 88%** |
| `clean-lead` 120bpm | 6.0% | 46.5% | 42% |
| the chord takes | 1.5 - 6.7% | 0 - 78% | 0 - 21% |

On every lead take, 84-91% of voiced hops are decided by the SHORT window: 512
samples, **10.7ms**, which is shorter than the 12ms hop. The 43ms window only
wins on low or unconfident material — the chord takes — where an event lasts
seconds and 43ms of contamination is nothing. So the quantity the argument is
built on is 10.7ms wide exactly where the misnaming is, and only 6-12% of the
vote mass straddles anything at all.

### And the Notes are not named late

The eval already records when each Note first said what it finally says
(`revisions.timeToFinalLabelMs`). On the six 140bpm lead takes:

```
  amped triplet     82 Notes,  4 corrected      DI triplet     76 Notes,  2 corrected
  amped sixteenths  38 Notes,  0 corrected      DI sixteenths  42 Notes,  0 corrected
  mic triplet       65 Notes, 11 corrected      mic sixteenths 39 Notes,  2 corrected
```

96-100% of Notes on the lead takes name themselves correctly at their first
emission and never revise. The lag is real on the CHORD takes — 120 to 1666ms
to a final label there — and it is harmless, because a chord is seconds long.

### Measured end to end, and it makes naming worse

Two forms, both parameter-free: discard a straddling frame's vote outright, and
weight it by the fraction of its window that lies inside the Note. They measure
identically.

| | detections | missed | false positives | `clean-lead` gated pitch class |
|---|---|---|---|---|
| now | 515 | 35 | — | **92.9%** |
| straddling votes discarded | +1 | +0 | +1 | **89.3%**, required gate FAILS |
| straddling votes weighted by overlap | +1 | +0 | +1 | **89.3%**, required gate FAILS |

Not one label is recovered, one false positive is added, and the required gate
fails. `scripts/measure-pitch-lag.ts` predicts it: of the Notes whose name
would change, most would be renamed to their SUCCESSOR's pitch, not to their
own — the early hops were carrying the Note's own attack-region pitch, and
removing them lets the next event's bleed decide instead.

This also explains why `pitch.voteLagMs` measured inert at every value: moving
a vote's ownership and removing the vote both assume the vote is wrong, and on
this material it is right.

### What the split shapes actually are

`measure-splits.ts --detail` prints, for the amped triplet take, twenty-one
lines that read like a naming lag — `e16 D5 @16308: C5 + D5`, the previous
note's pitch and then the right one. `scripts/measure-split-shape.ts` asks the
one question that separates the readings: where did that leading Note BEGIN?

| shape | corpus | amped triplet |
|---|---|---|
| the leading Note began >45ms BEFORE this label — it is the PREVIOUS event's Note | **49** | **21** |
| ...and of those, it carries the previous label's own name | 24 | 15 |
| began here, named as the note before — the pitch-lag shape | **9** | 3 |
| began here, named as this label — a boundary the player did not put there | 13 | 3 |
| named as neither | 12 | 0 |
| **split events** | **83** | **27** |

The assignment rule is `measure-splits.ts`' own, so the two agree on which
events are split before they disagree about why. Read note by note, the amped
triplet's eighth-note run is unambiguous:

```
  labels   e2 B4 @13312    e3 C5 @13492    e4 D5 @13679    e5 C5 @13894
  Notes    13320-13440 B4  13507-13627 C5  13693-13827 D5  13907-14040 C5
           13440-13507 B4  13627-13693 C5  13827-13907 E5  14040-14107 C5
```

Every event is emitted twice: a correctly-named ~130ms Note, then a ~70ms tail
fragment at the same pitch. The tail fragment starts nearer to the NEXT label
than to its own, so the nearest-label rule charges it there, and the pair reads
as "the previous pitch, then the right one". Nothing was misnamed. The hop
table for one of them, from `measure-pitch-lag.ts --detail`, is flat:

```
  14507-14573 named A4     (label e7 is A4 @14334; label e8 is B4 @14550)
    +0ms A4 conf 0.49   +13ms A4 0.43   +27ms A4 0.91
    +40ms A4 0.39       +53ms A4 0.88   +67ms B4 0.87   <- the next Note starts
```

**So the defect behind the largest block of splits is a same-pitch boundary
inside one event, not a name arriving late.** That is a segmentation question
and it is where the effort belongs.

### `one onset, two readings`, re-measured against this baseline

The section above this one records the mechanism and says it should be re-tried
once the lag was closed. There is no lag to close, and re-run as it stands on
the current tree it no longer pays at all — its former headline win,
`power-chords-di` 12 detections to 16 with 4 missed to 0, has since been banked
by other changes and that take now sits at 16/16 with 0 missed without it.

| | detections | missed | false positives | required failures |
|---|---|---|---|---|
| now | 515 | 35 | — | 0 |
| one onset, two readings | **-1** | **+1** | +0 | **2** |

`clean-lead`'s gated pitch class goes 92.9% to 86.7% and `power-chords` 120bpm
fails `maxMedianOnsetErrorMs`. The one take it still helps is
`power-chords-amped`: 15 detections to 17, 3 missed to 1, pitch class 78.6% to
92.9%. Everything else is neutral or worse. Recorded, and closed: it is not
waiting on the pitch path.

### The fragmentation metric charged a tail fragment to the event that had not started

The fourth instance of the window-wider-than-the-spacing error, and the one that
manufactured a defect out of nothing.

`measure-splits.ts` assigned each Note to the label whose onset it began
NEAREST. That fixed the 120ms lookback, and introduced a subtler version of the
same thing. The amped eighth-note run emits:

```
  n27 13320-13440 B4     n28 13440-13507 B4     <- tail fragment of e2
  n29 13507-13627 C5     n30 13627-13693 C5     <- tail fragment of e3
  labels: e2 B4@13312   e3 C5@13492   e4 D5@13679
```

`n28` begins 128ms after `e2` and 52ms before `e3`, so nearest-onset charged it
to `e3` — an event that had not begun. `e3` then read as "B4 then C5", which is
the "previous note's pitch, then the right one" pattern that was twice diagnosed
as a naming lag in the pitch estimator. It was measured twice and refuted twice:
84-91% of voiced hops on the lead takes use the SHORT 512-sample window, 10.7ms,
shorter than the hop, so nothing straddles a boundary; and 96-100% of Notes on
those takes name themselves correctly at their first emission. The Notes are
named right. Each event simply emits a correctly-named ~130ms Note plus a ~70ms
SAME-PITCH tail fragment, and the tail was being charged forward.

The rule is now the last event that had started when the Note did, with a 40ms
reach forward for a Note backdated slightly onto its own attack. 40 because
matched detections sit at a median of +12ms with a tenth percentile near -35ms,
and because it must stay well under a 107ms sixteenth.

Corpus fragmentation reads **99 of 459 events split, 107 extra Notes, 10
strays**, where the nearest-onset rule said 83/85/23. The number went UP, and
that is the correction working: a fragment that begins inside an event is that
event's, and thirteen Notes that the previous rule filed as unplaceable strays
are fragments of an event that was sounding at the time.

The defect that remains is one thing, stated correctly at last: **a same-pitch
boundary inside a single event**, shedding a short tail after a correctly-named
Note.
So the idea survives the cheap test that killed the pace hypothesis, and the
oracle gives the target to build against: at the true rate the gate must reach
64 of the 75 spurious Notes without touching a label. Recorded as a confirmed
lead rather than a change — the estimator is not built here, and the numbers
above are what it has to be measured against when it is.

> **Corrected below.** That count is of merge CANDIDATES, not of Notes anybody
> saw. Most of them never cleared the announcement bar and were never
> detections, so removing them changes no reported figure. The oracle's true
> ceiling is eight emitted Notes, not sixty-four. See "The causal rate
> estimator: built, measured, reverted".



## The missing fundamental: the bass read from the spacing, not from the lowest peak

The room mic has 5% of the `123.5Hz` fundamental the direct input has, and no
amount of better cancellation recovers audio that is not in the file. The
partials that survive still name the note — 247, 370, 494 and 741 are the 2nd,
3rd, 4th and 6th of 123.5 — so the estimate now comes from their spacing.

`src/engine/kernels/missing-fundamental.ts` is the whole of it, and
`chroma.ts` calls it once per frame, after `findBass()` and before
cancellation, over the same peak list.

**Subharmonic summation, not harmonic product.** HPS multiplies the spectrum
decimated by 1, 2, 3..., so a single absent harmonic drives the product to zero
— and the case being solved is *defined* by an absent harmonic. A sum degrades
gracefully: the missing term contributes nothing and the four that are present
carry the estimate. The 5th partial makes the same argument a second time. On
the low string it holds a few percent of the 3rd's energy (`n=5` is 0.069 of
the frame's loudest partial on the mic take, 0.005 on the amp sim), which is
plenty as a *peak* — the whitened spectrum finds it prominent — and nothing at
all as a factor in a product.

### What it asks of a candidate

Fundamental absent (else the peak pickers own the answer), the 2nd and 3rd
partials present, four partials present in total among `h = 2..8`, and both the
3rd and the 5th present. Candidates run from `E2` up to the top of the existing
bass range.

### The guard, and it is doing work

Every harmonic of `f` is also a harmonic of `f/2`, so a subharmonic estimator
will invent a note an octave below a real one unless something stops it. Three
things stop this one, and each was measured by removing it:

| guard removed | derivation set | held out |
|---|---|---|
| **odd support 2 -> 1** (accept the 3rd alone) | `chords-a-bm` 11/12 exact -> 11/14; three labels it used to abstain on become confidently wrong | mic power chords 8/11 -> 8/12 |
| **7th admitted as odd evidence** | synthesized `Cmaj9` (`C3 E3 B3 D4 E4`) is renamed `Em7`: the `D5` at 588Hz sits 34 cents from `E2`'s 7th, inside a 45-cent window, and invents an `E2` under the chord. `tests/chroma.test.ts` catches it | mic cowboy chords 6/8 -> 7/8, which is one label bought with a fiction |
| **range floor `E2` -> `C2`** | `cowboy-120` false positives 4 -> 1, pitch class 87.5% -> 100% | `cowboy-di` 6/8 -> 5/8 exact and 100% -> 87.5% pitch class |

The odd-harmonic test is what a power chord makes hard: its fifth sits exactly
at `3f/2`, so the 3rd partial of an octave-below fiction is always there and
proves nothing. The 5th is not a chord tone of anything a guitar is likely to
be playing over `f`, and requiring it is what separates the two.

The range floor is the guard against the *root-position major triad*, which
beats the odd-harmonic test outright: under an open C, `C2`'s 3rd partial is
the chord's fifth and its 5th partial is the third two octaves up, 14 cents
away. Scanning the derivation fixtures for candidates that clear every other
bar turned up exactly two, `C2` (65.4Hz) under an open C and `D2` (73.4Hz)
under an open D — neither of them a note a standard-tuned guitar can sound.
The floor is set from the instrument, at `E2`, and NOT from the eval: the
derivation set mildly prefers `C2` (see the table), the held-out DI take is
worse for it, and a fundamental below the lowest string is a fiction whichever
way the labels fall. A drop tuning would need the floor two semitones lower and
would re-admit the open-D reading.

### Measured, end to end

`npm run eval`, per fixture, exact and pitch class. Fifteen of the seventeen
fixtures are byte-identical before and after; only these two moved, and both up:

| fixture | before | after |
|---|---|---|
| `chords-a-bm-g-d-2x-120bpm` (derivation, required) | 10/12 exact, 83.3%, pc 100% | **11/12, 91.7%**, pc 100% |
| `power-chords-b-a-g-fsharp-b-a-g-e-140bpm` (room mic, held out) | 4/7 exact, 57.1%, pc 100% | **8/11, 72.7%**, pc 100% |

The derivation fixture is the more interesting of the two. Its last `D` was
being named `D5/A` — a power chord over the fifth — because the bass read as
`A3` and the third never made it into the name. The estimate finds the `D`
below it and the chord is named `D`. Two `G` strums stop being `G/D` for the
same reason. That is the same octave error as the mic's, on a 120bpm fixture
recorded direct, which is worth recording: the missing fundamental is not only
a microphone's problem.

On the mic take, `scripts/measure-chord-voicing.ts` now prints the bass
alongside the activations. Across its sixteen strikes the bass pitch class went
from 8 of 16 correct to 14 of 16, and where it is inferred it is reported at the
grid frequency (`123.5Hz` exactly) rather than at a measured peak, because there
is no peak to measure:

```
        before                       after
  p1    bass=F#@184.3Hz              bass=B @123.5Hz
  p5    bass=D @149.7Hz              bass=G @98.0Hz
  p9    bass=F#@183.0Hz              bass=B @123.5Hz
  p11   bass=D#@159.4Hz              bass=A @110.0Hz
  p15   bass=E @164.8Hz              bass=E @82.4Hz
```

`p14` still reads `D` under a `G5` and `p16` still reads `B` under an `E5`;
in both the fifth's own fundamental is present and the root's series does not
clear the bar.

`scripts/measure-downstream-ledger.ts --all` is unchanged in every cell: 515
detections, 35 MISSED, the same cause for each. The bass change costs no
detections.

### Also measured in this pass, and NOT kept

**Seeding cancellation with the estimate.** The obvious next step, and the one
the previous entry predicted: record the inferred fundamental as a detected
note and let it cancel its own partials, so the `D#5` that turns `B5` into a
triad is spent against the `B2` it belongs to. It does exactly that — the mic
take's `p1` voicing becomes `B2 F#3`, matching the direct input, and `p1` is
named `B5` instead of `B`. It also costs a label on the derivation set, which
decides it: `chords-a-bm`'s last `D` loses its third and is named `D5`, 11/12
-> 10/12. On the held-out takes it was a wash (mic power chords 8/11 either
way: `p1` gained, `p13` lost to `Gsus2`), so there was nothing to weigh against
the derivation-set regression. Reverted; the estimate changes the bass reading
and nothing else. The chord matcher already takes the bass as evidence, and
that turns out to be enough to move the labels.

**Searching only up to 125Hz.** The rolloff a speaker and a room impose is a
low-frequency phenomenon, so the search was tried bounded at `B2` rather than at
the existing 200Hz bass ceiling. It loses the derivation-set corrections above
(`chords-a-bm` back to 10/12) and gains nothing. Bounds of 150Hz and 200Hz give
identical results on all seventeen fixtures, so the existing
`BASS_MAX_FREQUENCY_HZ` is reused rather than a new constant introduced.

### What this does not fix

The amp-sim power-chord take is untouched at 11/14: its fundamentals are all
present (`n=1` is 0.714 there, against 0.726 direct), so there is nothing to
infer, and its three missed labels are `rejected: chord-not-sharp` in the
ledger — a segmentation cause, not a naming one. The mic take remains an
informational FAIL at 72.7% against an 80% bar, with `p14` and `p16` above
still misnaming and two labels named as triads.

## The mute as a retroactive witness: built, measured, kept

`scripts/measure-mute-witness.ts` found the cleanest separation in the corpus —
48 of 48 strokes on all three signal paths — and the reason it is clean is
physical. Every witness this project has tried at a boundary asks whether energy
ARRIVED, which is the question the signal path distorts most. A mute REMOVES
energy, and a compressor, a room and a decaying string can all imitate an
arrival while none of them can imitate a removal.

The rule that follows: a re-articulation rejected for a weak transient, followed
by a mute, is a rejection the mute contradicts. The contradiction arrives after
the decision, so the boundary is made retroactively and backdated to the
transient that was refused.

### What it recovers, and what it costs

| | detections | missed |
|---|---|---|
| corpus, before | 515 | 35 |
| corpus, after | 519 | **32** |
| `power-chords-amped`, before | 15 / 16 | 3 |
| `power-chords-amped`, after | 18 / 16 | **0** |

The three recovered labels are exactly the three the brief predicted, and that
fixture's eval gate goes from FAIL to PASS. Fragmentation is unchanged at 83 of
459 split, 85 extras, 23 strays. Every other fixture is bit-identical, including
all five 120bpm originals. One extra Note appears on `cowboy-chords-mic`, at a
point where that take plausibly has an unlabelled second strum.

### The guard that makes it safe, and the one that does not

The obvious reading of the witness — fire on the first frame that falls far
enough below the Note's own fitted decay — does not work, and the way it fails
is worth recording. Raising the required separation between the transient and
the collapse does not EXCLUDE a false fire, it postpones it: the signal keeps
falling, so a later frame crosses the same bar at a lower value. "First frame
past a threshold" is a race that any decaying signal eventually wins, which is
why the raw measurement gets its separation from a minimum over a fixed window —
a shape — and a crossing test cannot inherit it.

Nor do the readings at the collapse separate once they are taken through the
engine rather than off the raw audio. The strokes the rule must recover read
0.41, 0.60 and 0.67 against their own fitted decay; the fires it must refuse
read 0.11, 0.47, 0.60, 0.67, 0.70 and 0.74. There is no bar between them.

What separates is a question asked at the CANDIDATE rather than at the collapse:
how near its own peak was the chord when the transient landed?

| | fraction of the Note's peak |
|---|---|
| the three strokes to recover | 0.85, 0.96, 1.00 |
| every fire to refuse | 0.63, 0.63, 0.60, 0.26, 0.25, 0.14 |

A transient landing on a chord already down to a third of its peak is finger
noise on a dying string. That is the same claim `mutedRestrumWindowMs` makes in
time, made in energy instead — and energy is the axis that survives the signal
path, where an absolute level is not: the direct take's ANSWERED strokes collapse
further than the amp take's MUTED ones, so any bar chosen across paths measures
the recording rather than the playing. Without this guard the rule invents nine
Notes; with it, one.

The result is a plateau rather than a fitted edge. Missed stays at 32 across
every constant swept: live fraction 0.60 to 0.85, collapse 0.55 to 0.90,
separation 120 to 250ms.

### The head/tail test, measured and refuted

A candidate discriminator for the reverted same-pitch merge: merge the later
Note into the earlier only when the earlier is the LONGER of the two, on the
grounds that a tail is shorter than its head while a real event swallowed by a
stub is longer than what precedes it. It needs no constant, so it was worth a
pass.

It has to be measured on an UNFILTERED candidate set. The earlier table capped
fragments at `transient.articulationMs`, which makes "is it shorter than its
head" inert by construction — every candidate passes. Collected without that cap:

| gate | labels missed | Notes removed |
|---|---|---|
| rule off | 32 | 0 |
| `soundedMs < 80` — the reverted rule | 36 (+4) | 80 |
| shorter than what precedes it | **42 (+10)** | 93 |
| shorter than half what precedes it | 34 (+2) | 64 |
| `soundedMs / oracle IOI <= 0.40` | **32 (+0)** | 66 |

The head/tail test is worse than the plain duration bar it was meant to replace,
and by a wide margin. The two populations overlap on it from end to end —
spurious 0.00 to 1.00, matched 0.38 to 8.71 — and the best threshold on the
ratio that loses no label removes 56 of 81 against the oracle rate's 70. The
premise is where it fails: a real event preceded by a stub is not reliably
longer than that stub, because the stub is often the head of the previous event
rather than a fragment.

On the wider candidate set the oracle rate holds everything it held before: 66
Notes removed at 0.40 with no label touched, 70 at the best label-safe
threshold, and still flat under rate errors from half the true value to a
quarter above it.

> **Corrected below.** "66 Notes removed" counts merge candidates; only eight of
> them were ever emitted. And the flatness under rate error is flatness in the
> COST — the benefit collapses to nothing by 0.7. See "The causal rate
> estimator: built, measured, reverted".

## Does any COMBINATION of the witnesses separate accept from reject? No

`scripts/measure-decision-separability.ts`.

Every threshold this project has swept has been a threshold on one witness, and
each one has failed the same way: attack contrast varies 2.0x to 24.2x across
the corpus and up to 106x within a single take, so a bar that works on one take
measures the recording on the next. `heldFluxRatio` separates cleanly on eight
takes and inverts on the ninth. The question that had never been asked is
whether the witnesses TOGETHER carry information none of them carries alone —
because if they do, a learned combination is worth building, and if they do not,
a large planned effort dies here for the cost of one script.

They do not. The answer is no, and the way it is no is more informative than the
answer: a fitted combination reproduces the single-witness failure exactly, one
level up. It learns each take's own scale.

### The table

The tracker's `rearticulation` trace fires before the `settled` gate and before
the tracker acts, so these are the decisions that COULD be taken rather than the
ones that were. One row per attack that reached `RearticulationDetector.verdict`
over a sounding Note, carrying the twelve witnesses the verdict has in hand.

A row is a POSITIVE when a labelled event begins within 70ms of it and no Note
opened BEFORE it (in trace order) sits within 70ms of that label — the
attribution `measure-downstream-ledger.ts` uses, where a Note opened inside the
window means the boundary was already found. Trace order rather than timestamp
order is load-bearing: a split backdates its successor to the first transient of
the attack burst, so a decision compared by timestamp finds its own successor
sitting before it and marks itself already covered, which silently deletes every
true positive. That bug was present in the first run of this script and it did
not look like a bug; it looked like a table with fifteen positives.

| set | takes | rows | positives | base rate | distinct labels |
|---|---|---|---|---|---|
| derivation (120bpm) | 5 | 161 | 59 | 0.366 | 48 |
| held out (140bpm) | 12 | 564 | 310 | 0.550 | 282 |

What the current code scores on the same table, as the thing to beat:

| | TP | FP | FN | TN |
|---|---|---|---|---|
| derivation, verdict only | 36 | 38 | 23 | 64 |
| derivation, splits acted | 32 | 16 | 27 | 86 |
| held out, verdict only | 264 | 176 | 46 | 78 |
| held out, splits acted | 240 | 67 | 70 | 187 |

The population is conditioned on the current code in one way that cannot be
removed: a row exists only where the fast lane found a transient AND a Note was
open to decide about. The four strokes lost to `no transient within the window`
are not in this table, and no rule fitted on it could recover them.

### Single witnesses, for the baseline

Pooled over the five derivation takes, in-sample, oriented so a witness that
separates by being LOW counts as well as one that separates by being high.

| witness | AUC | oriented | dir | FP at zero label cost |
|---|---|---|---|---|
| sharpness | 0.728 | 0.728 | high | 102 / 102 |
| fluxRatio | 0.701 | 0.701 | high | 101 / 102 |
| heldSharpness | 0.658 | 0.658 | high | 100 / 102 |
| heldFluxRatio | 0.590 | 0.590 | high | 100 / 102 |
| decayExcess | 0.558 | 0.558 | high | 102 / 102 |
| soundedMs | 0.456 | 0.544 | low | 91 / 102 |
| kernelOnset | 0.543 | 0.543 | high | 102 / 102 |
| gliding | 0.472 | 0.528 | low | 102 / 102 |
| pitchDiffers | 0.480 | 0.520 | low | 98 / 102 |
| riseRatio | 0.515 | 0.515 | high | 97 / 102 |
| bloomed | 0.488 | 0.512 | low | 102 / 102 |
| envelopeOverBaseline | 0.497 | 0.503 | low | 101 / 102 |

The last column is the number that matters and it is already fatal. The loosest
bar on the best witness that keeps every played stroke also keeps 102 of the 102
rejections. Nine of the twelve witnesses are within 0.06 of a coin toss.

### The witnesses are not twelve readings

| pair | r |
|---|---|
| sharpness / heldSharpness | 0.954 |
| riseRatio / envelopeOverBaseline | 0.881 |
| fluxRatio / heldFluxRatio | 0.867 |
| sharpness / fluxRatio | 0.862 |
| heldSharpness / heldFluxRatio | 0.832 |
| heldSharpness / fluxRatio | 0.824 |
| sharpness / heldFluxRatio | 0.723 |
| soundedMs / bloomed | 0.550 |

`sharpness` and `heldSharpness` are two divisions of the same flux and correlate
at 0.954. Six of the twelve columns are one measurement — spectral flux, scaled
four ways — plus the envelope, scaled two ways. There is no twelve-dimensional
space here to find a hyperplane in.

### All twelve together

Plain L2-regularised logistic regression, standardised inputs, gradient descent,
no dependency. Cross-validated two ways: stratified 5-fold, which mixes takes,
and leave-one-take-out, which does not.

| lambda | in-sample AUC | 5-fold AUC | leave-one-take-out AUC | FP at zero label cost |
|---|---|---|---|---|
| 0.01 | 0.808 | 0.758 | **0.434** | 94 / 102 |
| 0.1 | 0.783 | 0.736 | 0.428 | 94 / 102 |
| 1 | 0.745 | 0.707 | 0.398 | 97 / 102 |
| 10 | 0.735 | 0.697 | 0.335 | 97 / 102 |

The gap between the two cross-validation columns IS the finding. Folds that mix
takes score 0.758 — better than any single witness, which is what a hopeful
reading would stop at. Folds that hold out a whole take score 0.434, which is
worse than a coin toss. Everything the combination appeared to learn was each
take's own scale.

That is not the same as the model learning nothing. Scored within the take it
was held out from, it is a fair-to-poor classifier; pooled across takes it
inverts, because each take's scores sit at a different offset:

| take | pos | neg | sharpness AUC | 12-witness in-sample | 12-witness held-out fold |
|---|---|---|---|---|---|
| chords-a-bm-g-d-2x-120bpm | 10 | 15 | 0.760 | 0.680 | 0.260 |
| clean-lead-120bpm | 38 | 33 | 0.695 | 0.790 | 0.709 |
| cowboy-chords-c-d-em-g-c-d-em-am-120bpm | 9 | 19 | 0.661 | 0.766 | 0.561 |
| power-chords-c-a-g-e-c-d-fsharp-e-120bpm | 2 | 24 | 0.667 | 0.625 | 0.500 |
| spicy-chords-cmaj9-g-am11 | 0 | 11 | - | - | - |

This is the trap `measure-mute-witness.ts` documents in its own header, met
again: a quantity can separate within every file and still have no bar across
files. Twelve witnesses combined do not escape it — they land in it faster,
because a fitted offset is exactly the thing that does not transfer.

### Two at a time

All 66 pairs, leave-one-take-out.

| pair | leave-one-take-out AUC | FP at zero label cost |
|---|---|---|
| heldSharpness + fluxRatio | 0.599 | 102 / 102 |
| fluxRatio + pitchDiffers | 0.596 | 97 / 102 |
| fluxRatio + gliding | 0.581 | 96 / 102 |
| fluxRatio + kernelOnset | 0.581 | 101 / 102 |
| sharpness + fluxRatio | 0.580 | 101 / 102 |
| fluxRatio + heldFluxRatio | 0.571 | 102 / 102 |

The best pair beats the twelve-witness fit across takes (0.599 against 0.434) —
fewer parameters, less scale to memorise — and still loses to reading
`sharpness` on its own in-sample. No pair reaches a usable operating point:
every one of them accepts at least 96 of the 102 rejections in order to keep
every played stroke.

### Held out: the twelve 140bpm takes

Fitted on the five derivation takes, standardised on their statistics, scored on
the twelve held-out takes with nothing refitted and nothing tuned. The operating
point is the derivation set's own zero-label-cost threshold, carried over
unchanged.

| rule | derivation AUC | held-out AUC | positives kept | labels lost | false accepts |
|---|---|---|---|---|---|
| all twelve witnesses | 0.808 | 0.647 | 295 / 310 | 15 | 240 / 254 |
| best pair: heldSharpness + fluxRatio | 0.701 | 0.700 | 309 / 310 | 1 | 247 / 254 |
| best single: sharpness | 0.728 | 0.667 | 310 / 310 | 0 | 252 / 254 |

The twelve-witness fit drops from 0.808 to 0.647 and ends up BELOW the single
witness it was supposed to improve on (0.667). The transferred operating point
accepts 94% of the held-out rejections and still loses fifteen strokes. There is
no version of this where the combination is the thing to build.

### Verdict

No. No combination of the witnesses we already compute separates the
accept-from-reject decision.

- The best single witness, `sharpness`, reads 0.728 in-sample and 0.667 held
  out. A twelve-witness fit reads 0.434 across derivation takes and 0.647 held
  out — worse on both honest measures than the one witness it was built to beat.
- The apparent gain (5-fold 0.758) comes entirely from folds that share a take.
  Hold the take out and it is gone. The fit is learning the recording, which is
  the same defect every hand-tuned threshold has hit, arrived at faster.
- No operating point costs zero labels at a tolerable price. On held-out data
  the cheapest such point admits 240 to 252 of 254 rejections.
- The twelve columns are not twelve measurements. Four of them are one flux
  divided four ways (r up to 0.954), two are one envelope, and nine of the
  twelve are within 0.06 AUC of a coin toss on their own.

The consequence for planning: a learned or fitted re-articulation gate over the
CURRENT witness set should not be built. What would change the answer is a new
witness that is physically different rather than another scaling of the flux —
the mute (`measure-mute-witness.ts`) is the existing example, and it works for
the reason the flux witnesses do not: a mute REMOVES energy, and removal is not
something a compressor, a room, or a decaying string can imitate. Evidence of
that kind arrives after the decision, which is why the retroactive path exists.
Adding a thirteenth reading of the same spectral flux will not separate anything
these twelve do not.

Falsifiable: a combination whose leave-one-take-out AUC clears the best single
witness by more than the spread across folds AND holds on the twelve held-out
takes, or a zero-label operating point whose held-out false accepts fall
materially below 252 of 254. The script prints both columns every run.

## The rig is measurable, but it is not what the witnesses are scaled by

`scripts/measure-rig-profile.ts`, `src/engine/rig-profile.ts`.

The proposal this pass tests: stop hunting for a constant that works on every
signal chain and calibrate to the chain that is actually present, the way
`NoiseFloorTracker` already derives the amplitude gate from the rig's own
measured noise floor instead of assuming 0.008 means the same thing everywhere.

`RigProfileEstimator` accumulates, per hop and from the evidence the fast lane
already computes, quantiles of what a rig does: each transient witness at the
hops the detector was confident about against the hops it was not, the share of
magnitude above 2kHz and inside the guitar's fundamental range, crest factor,
and the decay time constant of a struck note fitted by the tracker's own
`VoiceDecay`. Bounded rings and quantiles throughout — one loud stroke must not
move a profile. It decides nothing; this pass measures whether it COULD.

The corpus is what makes the question answerable. Four groups, each a fixed
chain, and the four takes inside an LP group are the same guitar in the same
session playing four different things. So spread WITHIN a group is what the
playing does to a statistic and spread BETWEEN groups is what the rig does.

### What separates, and what only looks like it does

Two statistics of twenty-four qualify, and they are one statistic measured two
ways: the FLOOR of the flux family, which is what the spectrum does on the hops
where nothing was struck.

| statistic | 120bpm | LP DI | LP mic | LP amped | within | between | sep |
|---|---|---|---|---|---|---|---|
| `sharpness.floor` | 0.70-1.10 | 0.91-1.27 | 1.31-2.04 | 1.87-2.60 | 1.58x | 2.95x | **1.87** |
| `heldSharpness.floor` | 0.366-0.484 | 0.276-0.389 | 0.607-0.939 | 0.718-1.148 | 1.60x | 2.96x | **1.85** |
| `heldFluxRatio.floor` | 0.543-0.873 | 0.429-0.520 | 0.628-0.876 | 0.829-1.024 | 1.61x | 1.84x | 1.14 |
| `crest` | 2.19-2.71 | 2.59-2.85 | 2.77-3.47 | 2.93-3.13 | 1.25x | 1.35x | 1.08 |
| `sharpness.attack` | 0.90-3.50 | 2.61-5.66 | 2.81-9.17 | 2.63-5.43 | 3.88x | 3.56x | 0.92 |
| `brightness` | 0.028-0.107 | 0.007-0.178 | 0.216-0.681 | 0.387-0.488 | 25.4x | 8.86x | 0.35 |
| `bassShare` | 0.664-0.899 | 0.213-0.694 | 0.051-0.494 | 0.099-0.299 | 9.73x | 3.57x | 0.37 |
| `decayTauMs` | 249-1161 | 80-1028 | 235-747 | 80-1943 | 24.3x | 5.91x | 0.24 |

`within` is the widest max/min ratio inside any one chain, `between` the ratio
of the four chain medians, `sep` their quotient. The full twenty-four-row table
is what the script prints.

Read the failures, they are more informative than the successes:

- Everything measured AT an attack fails. `sharpness.attack` moves 3.88x within
  one chain against 3.56x between chains: it is a statistic of the playing
  wearing a rig's clothes. Every `*.attack`, `*.attackLow` and `*.contrast`
  column lands at sep 1.5 or below.
- `brightness` and `bassShare` separate the chain MEDIANS by 8.9x and 3.6x — a
  room mic really is brighter than a direct input, and the amp sim really does
  take the fundamental — and they have the FEWEST overlapping group pairs of
  anything measured. They still fail, because a sixteenths run on the top two
  strings and a cowboy chord are not the same spectrum, and that difference is
  25x inside one rig. A statistic can be a true fact about the chain and still
  be useless for calibrating one, and this is what that looks like.
- The decay time constant varies 24x within a chain. It is a property of the
  note that was struck, not of the rig that carried it.

The two floors that do qualify tell the two clean paths (originals, DI) from the
two coloured ones (room mic, amp sim) and do not tell mic from amp: of the six
group pairs, the two that overlap are exactly those.

### The decisive question, answered directly

Leave-one-take-out failed at 0.434 in `measure-decision-separability.ts` while
take-mixing folds reached 0.758, and takes within a chain are different takes.
So the question is not only whether a statistic separates BETWEEN chains, it is
whether the flux scale is tight WITHIN one chain across four performances.

| flux-family statistic | widest within one chain | between chain medians |
|---|---|---|
| `sharpness.floor` | 1.58x | 2.95x |
| `heldSharpness.floor` | 1.60x | 2.96x |
| `heldFluxRatio.floor` | 1.61x | 1.84x |
| `fluxRatio.floor` | 1.84x | 1.56x |
| `sharpness.attack` | 3.88x | 3.56x |
| `heldSharpness.attack` | 3.09x | 2.24x |
| `fluxRatio.attack` | 2.88x | 3.12x |
| `heldFluxRatio.attack` | 2.26x | 1.92x |

The floors are the only place the rig leads the playing by a clear margin, and
even there a factor of 1.6 between two performances on ONE rig is most of the
factor of 3 between rigs. Measured at the attacks, the playing leads outright.

### Built, measured, NOT kept: rescaling the decision by the profile

The premise proved or disproved end to end. Every row of
`measure-decision-separability.ts`'s decision table, with the six scale-carrying
witnesses rescaled by a profile, under the same twelve-witness L2 fit at the
same lambda, scored leave-one-take-out.

| calibration | derivation LOTO AUC | FP at zero label cost | all 17 takes LOTO |
|---|---|---|---|
| raw, nothing calibrated | 0.434 | 94 / 102 | 0.727 |
| same-take, divide by floor — UPPER BOUND | 0.359 | 94 / 102 | 0.709 |
| same-take, affine floor-to-attack — UPPER BOUND | 0.373 | 96 / 102 | 0.626 |
| cross-take within chain, divide by floor | 0.451 | 94 / 102 | 0.715 |
| cross-take within chain, affine | 0.518 | 97 / 102 | 0.683 |
| all-other takes regardless of chain, divide | 0.444 | 94 / 102 | 0.728 |

The number to beat is 0.758, what the same rows and the same fit reach when the
folds are allowed to mix takes. Nothing here comes near it. The best honest
calibration moves leave-one-take-out from 0.434 to 0.518, still below the best
single raw witness held out (0.667), and the zero-label operating point is
unmoved: 94 to 97 of 102 rejections admitted, whatever is done.

The line that settles it is the upper bound. Calibrating on the very take being
scored — which no deployed system could do, and which nothing honest can beat —
makes the fit WORSE, at 0.359 against 0.434 raw. If the per-take scale defeating
this model were the scale a rig profile measures, that row would be the best in
the table. It is the worst. Whatever varies from take to take here is not the
signal chain's contribution, and dividing by the chain's floor removes real
information along with it.

`cross-take within chain` also fails to beat `all-other takes regardless of
chain` by any margin worth the name (0.451 against 0.444). That was the control,
and it says the small movement is a global rescaling rather than anything
rig-specific.

### The warm-up, since it was asked

Source time before a statistic stays within 15% of its final value, median over
the seventeen takes / worst take:

```
  brightness, bassShare, crest         8s / 15-20s
  the flux floors                     10s / 20-30s
  the attack quantiles               8-10s / 20-30s
  decayTauMs                          15s / 30s
```

Nothing is available in the first two seconds and little is settled before six.
This is a ten-second proposition at best, which matters for the product
question: a profile cannot help the opening bars of a session, only the rest of
it. And on dense playing it may not be available at all — at the 60ms attack
holdoff the three sixteenths takes retain 183-225 hops that belong to no attack,
just above the 200 the estimate requires, and at an 80ms holdoff they fall below
it and have no floor to report. The material a re-articulation gate most needs
calibrating for is the material that leaves least room to calibrate from.

### Verdict

The premise half holds, and the useful half fails.

- A rig IS measurable: the flux floor is a real property of the signal chain,
  tight enough within a chain (1.6x) against its spread between chains (3.0x)
  to be worth reporting, and it settles in about ten seconds.
- It is NOT what the re-articulation witnesses are scaled by. Rescaling by it,
  in the honest cross-take form or in the same-take form that cannot be beaten,
  does not restore comparability across takes and does not move the operating
  point that costs zero labels.
- So a per-rig calibration layer should not be wired into the decision. What the
  leave-one-take-out collapse is really saying, now that a per-rig normaliser
  has been ruled out as the fix, is that the varying quantity is per-PASSAGE
  rather than per-rig — a much shorter time constant than anything in this file.

Falsifiable: a normaliser whose cross-take-within-chain leave-one-take-out AUC
clears the raw 0.434 by more than the 0.084 measured here AND cuts the zero-cost
false accepts below 94 of 102. The script prints both columns every run. The
estimator stays in the tree because it costs nothing, decides nothing, and its
floors are the honest starting point for anyone who wants to try; the invariants
it has to hold are in `tests/engine/rig-profile.test.ts`.

### The causal rate estimator: built, measured, reverted — and the oracle target was overstated

The oracle result above justified building a causal estimator. One was built and
measured end to end, and it does not pay. The interesting part is not that it
fell short but WHERE, because the shortfall is not where the earlier sweep said
to look — and correcting that sweep changes what the oracle was ever promising.

#### What was built

`PaceEstimator`: a ring of the last eight inter-onset gaps, read at a quantile,
gaps under `transient.minIntervalMs` dropped, the reading discarded after 1.5s
of silence and null until three gaps are in hand. Null is a real answer meaning
"no opinion", and the consumer leaves the boundary alone.

Two choices were derived on the five 120bpm fixtures only, against an oracle
rate read off their labels:

- **Fed once per attack BURST, not per transient.** Feeding every accepted
  transient reads a passage as several times faster than it is played, because
  one pick crossing six strings is one stroke with several transients. Measured,
  that took the amped triplet take to a third of its true rate. The burst
  grouping already in `note-tracker.ts` is the tracker's own answer to "how many
  strokes was that", so the pace is read off the same decision. This alone moved
  whole-corpus extras 107 -> 102.
- **Quantile 0.25**, chosen by the asymmetry rather than by best fit. Reading a
  passage as SLOWER than it is merges Notes somebody played; reading it as
  faster only declines merges. So the quantity to control is the upper tail:

  | quantile | p10 | median | p90 |
  |---|---|---|---|
  | 0.15 | 0.37 | 0.64 | 0.84 |
  | 0.25 | 0.39 | 0.64 | **1.12** |
  | 0.35 | 0.40 | 0.72 | 1.27 |
  | 0.50 | 0.48 | 0.80 | 1.60 |

#### The spread is not sampling noise

Widening the ring from 8 to 12, 16 and 24 leaves the distribution unchanged —
p10 0.39/0.40, median 0.64, p90 1.12 at every size. There is nothing to average
away. These takes deliberately mix quarters, eighths, triplets and sixteenths,
so "the local stroke length" is genuinely multi-valued, and on top of that the
estimator's onsets are denser than the labelled events. That is the circularity
the pace refutation named, now confirmed for the ratio form: the rate estimate
is corrupted by the over-segmentation it exists to correct, and the onsets it
would have to ignore are exactly the ones the gate exists to remove.

#### The estimator lands inside the flat band and still underperforms

Against the oracle, at the 101 candidates the gate is offered:

```
  causal / oracle rate:  p10 0.32   median 0.82   p90 1.01
                         below 0.5: 18 of 83      above 1.25: 4 of 83
```

A median of 0.82 is squarely inside the 0.5-to-1.25 region the earlier sweep
called flat. It still achieves almost nothing:

| | merges | of which were EMITTED Notes |
|---|---|---|
| oracle rate | 69 | **13** |
| causal rate | 48 | **2** |

#### Why: the earlier sweep measured the wrong quantity

**The "64 of 75 spurious Notes removed" figure reported earlier is wrong, and
this is the correction.** That sweep counted merge CANDIDATES and measured cost
in missed labels. Most of what this gate merges never cleared the announcement
bar and was never a detection at all, so removing it changes nothing anybody can
see. Re-run with an emitted column, the oracle's true ceiling is **8 emitted
Notes at 0.40**, not 64 — and the flat band is flat only in the cost:

| rate multiplied by | missed | merges | of which emitted |
|---|---|---|---|
| 0.50 | 32 (+0) | 37 | **0** |
| 0.70 | 32 (+0) | 51 | 1 |
| 0.80 | 32 (+0) | 59 | 5 |
| 0.90 | 32 (+0) | 64 | 8 |
| 1.00 | 32 (+0) | 66 | 8 |
| 1.25 | 32 (+0) | 74 | 15 |
| 1.50 | 33 (+1) | 82 | 17 |

The cost is flat from 0.5 to 1.25. The BENEFIT collapses to nothing by 0.7. The
usable band is not 0.5-1.25 but roughly 0.9-1.25, and the causal median of 0.82
sits below it.

The mechanism is a threshold, not a slope. The gate removes something visible
only when `0.40 x rate` clears the announcement bar, which runs 55-90ms — so
only when the rate reads 138ms or more. The oracle's median rate at these
candidates is 154ms, giving a gate of 61ms, just above the bar. The causal
median is 120ms, giving 48ms, just below it. An 0.82 factor is harmless
everywhere except across that edge, and that edge is where the whole benefit
lives.

#### End to end, and why it was reverted

Whole corpus, burst feed at quantile 0.25:

| | split | extras | strays | detections | missed |
|---|---|---|---|---|---|
| before | 99 / 459 | 107 | 10 | 519 | 32 |
| after | 98 / 459 | 106 | 10 | 517 | 32 |

The totals hide a shuffle rather than a gain. Per fixture, the amped triplet
take goes 27 extras to 25 with no label cost, the room-mic triplet take goes 15
extras to 16 AND 2 missed to 3, and the room-mic sixteenths take goes 9 missed
to 8. One label lost and one gained on different takes, one net Note removed.
The label lost is the upper tail doing what the asymmetry predicted: four of the
83 readings exceed 1.25 even at quantile 0.25.

Reverted. Not because it is a loss — it is a wash — but because a wash that
conceals a per-fixture regression is not worth a subsystem.

#### What this says about the idea

The ratio itself is not refuted: with a rate it can trust, the gate removes
Notes at zero label cost where every duration bar costs four. What is refuted is
reaching it from a windowed estimate built on the detector's own onsets, for two
compounding reasons — the estimate is biased low by roughly a fifth and cannot
be de-biased without pushing its upper tail into the region that costs labels,
and the benefit it is reaching for turns out to be about eight Notes rather than
sixty-four.

That is a small enough prize that the next attempt should be judged against it
honestly. A rate not derived from the onsets being corrected would be the
interesting version; so would dropping the rate entirely and comparing a
fragment against its two immediate neighbours, which is the only per-passage
quantity in this that does not require knowing the subdivision.

## Calibrating on the whole signal chain: the ceiling, measured end to end

`scripts/measure-rig-ceiling.ts`, `src/engine/rig-profile.ts`,
`src/engine/fast/rearticulation.ts`.

The section above refused per-rig calibration on an AUC. AUC is not the product,
so the refusal deserved the blunt version of the question: if the recogniser
were told exactly what the signal chain does — profile pooled from every take in
the chain INCLUDING the one being scored, fully warmed before the first sample —
does it then analyse that chain accurately? That is the ceiling of the idea. No
deployed system can fit on the take it is about to score, so the number is an
upper bound and never an achievement.

### What was wired, and what was deliberately not

`EngineConfig.calibration` carries three multipliers, `UNCALIBRATED` (all ones)
by default, and `fast/rearticulation.ts` applies them to the five bars that are
levels on a scale the chain sets:

```
  sharpnessScale       rearticulationSharpness, newPitchSharpness
  heldSharpnessScale   restrumSharpness
  fluxRatioScale       restrumFluxRatio, ringOutFluxRatio
```

A multiplier of `floor / REFERENCE_FLOOR`, so a bar keeps its original
relationship to what the chain does when nothing was struck — the same
one-directional move `NoiseFloorTracker` makes for the amplitude gate. The
reference floors are the five 120bpm fixtures pooled, which is the audio every
one of those constants was swept against, so that chain's multipliers come out
at 1.001 and its numbers are unmoved. That is the first control.

`transient.fluxSensitivity` was left out on the evidence: it multiplies the
kernel's own running median, so it is already self-normalising and a rig scale
on top of it would be applied twice. The flux-RATIO family was wired only so it
could be refused separately, and it was: see the family table.

Nothing in `src/` ever sets a calibration. The library ships `UNCALIBRATED`, and
the control row below reproduces the shipped numbers exactly, per fixture.

### The answer

| variant | MISSED | named right | events split | extra Notes | strays |
|---|---|---|---|---|---|
| control, all ones (= shipped) | 32 | 371 | 99 / 459 | 107 | 10 |
| **CEILING, fit on the scored take** | **39** | **364** | **83** | **90** | 10 |
| cross-take within chain, honest | 40 | 362 | 84 | 91 | 10 |

No. Told exactly what the chain is, the recogniser loses seven played events and
names seven fewer correctly, in exchange for seventeen fewer duplicate Notes. By
this project's own stated asymmetry — a played note that never appears cannot be
recovered later, an extra one can, which is how `rearticulationRiseRatio` was
derived — that is a regression, not a gain. The eval's accuracy column moves the
same way the label count does, so nothing is being traded for a better name.

Per signal chain, which is where a rig effect would have to show:

| chain | takes | MISSED base -> ceiling | extras base -> ceiling |
|---|---|---|---|
| 120bpm original | 5 | 2 -> 2 | 13 -> 13 |
| LP DI | 4 | 6 -> 6 | 29 -> 28 |
| LP room mic | 4 | 11 -> 12 | 27 -> 24 |
| LP amp sim | 4 | 13 -> 19 | 38 -> 25 |

The multipliers the pooled profiles imply are 1.00 / 1.23 / 1.96 / 2.80 on
`sharpness`, so the whole effect lands on the two coloured paths, and almost all
of it on the amp sim. That is exactly where a rig story predicts it, and it is
still a loss.

### The honest number costs nothing extra

Cross-take — profile pooled from the OTHER three takes in the chain, scored on
the held-out one, rotated — lands within one event of the ceiling everywhere.
That is worth stating plainly because it is the opposite of the usual failure:
the gap between fitting on the take and not fitting on it is essentially zero,
so the chain floor really is estimable from other performances. The idea does
not fail for want of generalisation. It fails because what it generalises is not
worth having.

### It is not simply "raise the bars", and that is the only positive result

Raising a sharpness bar trades extras for misses on its own, so the calibration
has to be told apart from any global rise. `--controls` does that:

| variant | MISSED | extras |
|---|---|---|
| control | 32 | 107 |
| uniform x1.25 everywhere | 37 | 104 |
| uniform x1.50 | 43 | 100 |
| uniform x2.00 | 53 | 99 |
| uniform x2.50 | 60 | 94 |
| one profile over all 17 takes, no chains | 49 | 98 |
| **per-chain CEILING** | **39** | **90** |

The per-chain profile is off the uniform curve: at 90 extras a constant rise
costs about sixty labels and the chain-specific one costs thirty-nine. Pooling
all seventeen takes into one profile — the control that removes rig-specificity
and keeps the rescaling — is worse than both on both axes. So the chain
information is real and it is doing something. What it is doing is buying a
better exchange rate on a trade this project does not want to make.

### Which family carries it

| family scaled | MISSED | extras |
|---|---|---|
| `sharpness` only | 38 | 94 |
| `heldSharpness` only | 33 | 106 |
| flux ratios only | 33 | 103 |
| all three | 39 | 90 |

Essentially all of it is `sharpness`, the witness whose floor separated chains
best (sep 1.87). `heldSharpness`, which separated just as well (1.85), moves one
Note. The flux ratios move four, and their multipliers are 0.65-1.15 — near 1,
as a witness already divided by its own running median should be. No subset is
free: every extra removed costs a label somewhere.

### Why it cannot work, in one fixture pair

The amp-sim chain gets one multiplier, 2.80, and the four takes it is applied to
disagree about it:

```
  lead-line-amped-quarter-eighth-triplet    27 extras -> 18,  0 missed -> 0
  lead-line-amped-sixteenths-e-fsharp        6 extras ->  4, 13 missed -> 18
```

Same guitar, same session, same chain, same profile. On the triplet take the
raised bar removes nine duplicate Notes and costs nothing; on the sixteenths take
it costs five played events. The quantity that wants a different bar is the
PASSAGE, not the rig — which is what the leave-one-take-out collapse said before
a per-rig normaliser was ruled out, and this is that conclusion arriving from the
other direction, in Notes rather than in AUC.

### Incidentally confirmed

Pooling fixes the estimability problem the warm-up section flagged. A single
sixteenths take retains 183-225 hops belonging to no attack against the 200 a
floor requires; pooled per chain the four groups hold 2372-3789, so no chain
profile in this experiment is near the edge. The shortage is a property of one
dense take, not of the chain.

### Verdict

Per-rig calibration is finished as a direction. The ceiling — fit on test,
warmed by construction, the best any version of this could ever do — is a
regression on the measure that matters, and the honest cross-take version is a
hair worse than the ceiling rather than a fraction of it. Nothing is left to
recover by making the estimator better, because the estimator was not the
limitation.

The mechanism stays in the tree, off: `EngineConfig.calibration` defaults to
`UNCALIBRATED`, the 487 tests and the eval are bit-identical with it, and
`tests/engine/rig-profile.test.ts` pins that the default path is the same code
the library ships. It costs one multiply per bar at construction and it is the
apparatus any future attempt would need.

Falsifiable, and cheaply: a calibration that reaches 90 extra Notes at 32 missed
or fewer — that is, anywhere strictly inside the baseline on both axes — from a
profile pooled over a chain. `measure-rig-ceiling.ts` prints both columns, per
chain and per fixture, and the control row must reproduce 32 / 99 / 107 / 10
exactly or the run means nothing.

## Segmenting a region JOINTLY, by dynamic programming: measured, refuted

`scripts/measure-dp-segmentation.ts`. No engine change; the script wraps
`DeepLane.analyzeRegion` for the length of a run and restores it, so the
recognizer under measurement is the one the library ships.

Four directions closed before this one failed the same way: the accept/reject
decision at a single candidate boundary is not locally separable. The natural
next move is to stop deciding one boundary at a time — choose the whole
partition of a region at once, minimising

```
  sum over segments of (how badly this span is explained as ONE note)
    + price * (number of cuts)
```

by optimal partitioning: `best[x] = min over y of best[y] + cost(y,x) + price`,
back-pointers, O(N^2), the provable optimum rather than a greedy sweep. The
mechanism it is meant to exploit, on the dominant defect: a 190ms played event
that comes out as a ~130ms Note plus a ~70ms same-pitch tail. Both halves are
the same pitch and the tail is the head's own decay continuing, so the cut buys
almost no reduction in misfit and cannot pay its price; a genuine re-pick cannot
be explained by any single monotonic decay, so cutting at its envelope trough
buys a lot and pays easily. One rule, opposite answers, no threshold on flux.

### What was measured, over which regions, with which streams

253 regions — every region the deep lane actually analysed across the seventeen
takes, none refused, none too sparse — covering 454 of the 459 labels. The five
labels outside every region are unreachable by any segmentation rule and are
excluded from every row. 41.5 candidate boundary positions per region at
`deep.regionHopSamples: 1024` = 21.3ms, 6,643 distinct span costs per region,
7.9s of DP for a 22-price sweep over all 253 regions. Cost is not what makes
this idea expensive.

Three streams, each at the resolution where it is strong:

```
  envelope   fine RMS over the raw audio, 21ms window / 5.3ms hop
  pitch      the fast lane's own per-hop YIN estimates, by pitch class
  chroma     the 85ms deep readings
```

Per segment the misfit is `0.5 * decay-residual + 0.3 * pitch-instability +
0.2 * chroma-instability`, each term in [0,1], multiplied by the segment's
duration in seconds — so the price is one dimensionless constant in seconds of
misfit per cut. The decay residual is fitted from the span's PEAK forward, the
way `VoiceDecay` fits a Note, with a positive slope clamped flat; it is
normalised by ln(2), so "off the fitted curve by a factor of two on average" is
a fully unexplained span. `deep.minSegmentMs: 90` is deliberately not inherited
— the fragments this has to judge are 67-70ms and a partition that cannot
express them cannot be asked whether they are worth their price. The floor here
is 45ms.

Every row is scored by one rule: a segment start is a detection, a label is
found when a detection lands within 70ms of its onset, an unmatched detection is
an extra. The shipped recognizer's own Notes and the current greedy
`segmentRegion()` go through that identical scorer over those identical regions,
because a DP compared against a number produced a different way proves nothing.
Under it the shipped recognizer reads 63 missed / 125 extras and the greedy
region segmenter reads 71 / 611 — the segmenter over-proposes and the tracker
discards most of it, which is why the greedy row is not comparable to 107.

### The price curve — CEILING, price chosen fit-on-test on the whole corpus

| price | MISSED | found | extras | segments |
|---|---|---|---|---|
| 0.001 | 35 | 419 | 1476 | 1895 |
| 0.004 | 65 | 389 | 965 | 1354 |
| 0.006 | 71 | 383 | 823 | 1206 |
| 0.012 | 97 | 357 | 578 | 935 |
| 0.026 | 135 | 319 | 391 | 710 |
| 0.033 | 152 | 302 | 336 | 638 |
| 0.053 | 185 | 269 | 256 | 525 |
| 0.085 | 214 | 240 | 199 | 439 |
| 0.135 | 223 | 231 | 151 | 382 |
| 0.215 | 238 | 216 | 116 | 332 |
| 0.340 | 250 | 204 | 84 | 288 |
| 0.540 | 253 | 201 | 61 | 262 |

No point on it is strictly inside 32 missed and 107 extras on both axes. It is
not close, and the falsifier stated in advance is met. The curve is worse than
its own like-for-like controls at every matched level: at 383 found the greedy
rule spends 611 extras and the DP spends 823; the shipped recognizer reaches 391
found for 125 extras, which the DP does not approach at any price. At the top of
the range the DP has stopped cutting at all — 262 segments against 253 regions
is nine cuts in the whole corpus — so nothing is hiding beyond the sweep.

### Sensitivity to the cost function, and it does not rescue it

Each variant at its own best price, and the fewest labels it can miss while
holding extras under 107:

| cost | MISSED | extras | fewest missed under 107 extras |
|---|---|---|---|
| envelope only | 231 | 130 | 241 |
| pitch only | 135 | 196 | 249 |
| chroma only | 135 | 268 | 234 |
| envelope + pitch (.6/.4) | 138 | 360 | 250 |
| equal thirds | 138 | 305 | 246 |
| as chosen (.5/.3/.2) | 152 | 336 | 247 |

The spread across weightings is large in extras and small in the thing that
decides: no weighting gets under 234 missed labels at the baseline's extras
count. The result is insensitive to the choice in the only direction that would
have mattered.

### The decisive number: the mechanism, asked directly

The DP is not a better search — the partition it returns is optimal. Its whole
claim is that the QUANTITY separates. That is measurable without any price at
all: at every candidate boundary the greedy rule proposes, the misfit the cut
buys against its two neighbouring boundaries,
`cost(prev,next) - (cost(prev,here) + cost(here,next))`, split by whether a
label is annotated within 70ms. 342 on-label candidates, 473 off-label.

| cost | median on | median off | AUC |
|---|---|---|---|
| as chosen (.5/.3/.2) | 0.0198 | 0.0090 | 0.570 |
| **envelope only** | 0.0132 | 0.0117 | **0.469** |
| pitch only | 0.0224 | 0.0000 | 0.689 |
| chroma only | 0.0184 | 0.0060 | 0.713 |

The decay-residual term — the exact mechanism this direction rests on, the claim
that a same-pitch tail is its own head's decay and a re-pick is not — is at
chance. 0.469 over 815 candidates, computed from a 5.3ms envelope where time
resolution cannot be the excuse. Pitch and chroma reach 0.689 and 0.713, which
is the same band as the best single LOCAL witness already measured at 0.73 and
no better than it. Weighting the at-chance term at 0.5 is why the chosen cost
lands at 0.570, and that is a real finding about the cost rather than a slip:
the term the hypothesis was built on is the one carrying no information.

### Derivation and held out, reported anyway

Price derived on the five 120bpm takes at `3*missed + extras`, then applied
unchanged to the twelve 140bpm takes:

| set | MISSED | found | extras | segments |
|---|---|---|---|---|
| derivation five, price 0.540 | 32 | 43 | 22 | 65 |
| held-out twelve | 221 | 158 | 39 | 197 |
| held-out, greedy control | 67 | 312 | 447 | 759 |
| held-out, shipped Notes | 50 | 329 | 103 | 432 |

The derived price is the top of the swept range, which is itself the answer: on
the derivation takes the best thing this cost can do is never cut. Held out it
then finds 158 of 379 reachable labels. There is no gap to report between a real
gain and an apparent one, because there is no gain.

Per signal chain, held out, DP at the derived price against the two controls:

| chain | DP missed / extras | greedy | shipped |
|---|---|---|---|
| LP DI | 72 / 8 | 20 / 137 | 7 / 26 |
| LP room mic | 73 / 20 | 22 / 140 | 23 / 36 |
| LP amp sim | 76 / 11 | 25 / 170 | 20 / 41 |

The failure is uniform across the three chains, to within four labels. It is not
a rig effect and there is no path on which this works.

### Verdict

Joint segmentation by dynamic programming does not beat 32 missed / 107 extras,
at its fit-on-test ceiling or anywhere else. The best point on the ceiling curve
that holds extras under the baseline misses 234 labels where the recognizer
misses 32.

What is refuted is narrower than "global beats local", and worth stating
precisely, because the DP itself is not the thing that failed. Optimal
partitioning did exactly what it promises — the optimum is found, at 6,643 span
costs and 7.9s for the whole corpus across 22 prices, so the search is neither
approximate nor expensive. What failed is the cost. "How badly is this span
explained as ONE note" was supposed to be the quantity that answers the
same-pitch tail and the re-pick with one rule, and measured directly at the
boundaries in question its envelope half is at chance, while its spectral halves
reproduce the 0.73 the best single local witness already had. Making the
decision global does not create information that the local witnesses did not
have; it only spends it differently, and spending it in a partition is worse
than the greedy rule's spending because a partition must commit to covering the
whole region with segments while the tracker is free to discard proposals.

Falsifiable, and cheaply: a per-span misfit whose cut gain separates on-label
from off-label candidates above 0.80 AUC on the table above. Below that, no
price exists that turns it into a segmentation, and the sweep is a waste of the
run. `measure-dp-segmentation.ts --controls` must reproduce 63 / 125 for the
shipped Notes and 71 / 611 for the greedy segmenter, or the regions being
measured are not the ones the deep lane produces.

## Three candidate features from the onset literature, measured to their verdicts

The five converging negatives above (best single witness 0.73 AUC; the twelve
together collapsing 0.808 → 0.434 leave-one-take-out; per-rig calibration,
joint DP segmentation and the local-rate gate each measured to their ceiling
and refused) say the same thing: every existing witness is an energy-increase
detector in some disguise, and the same-pitch re-articulation decision needs
*different features*, not better logic over these. `docs/onset-features-prompt.md`
named three candidates with prior art and a falsifier each. All three were
built and measured in this pass. One falsifier passed, one split, one killed
its line cleanly. The baseline every number below is judged against: **32
missed / 99 events split, 107 extra Notes**.

### 1. The frequency-axis maximum filter substitutes for the time memory — and then moves the operating point instead of beating it

The onset kernel's reference is the per-bin maximum over the last three hops —
the *time* axis — because at fftSize 1024 the harmonics of a low E are 1.9
bins apart, unresolved, and beat: on a steady synthetic low E the
successive-frame flux swings as widely as a pick attack. But any time memory
makes the reference the loudest recent frame, which raises the bar a *quieter*
re-attack has to clear, and the quiet re-attack is the case the corpus fails.
SuperFlux (Böck & Widmer, DAFx-13) runs the max across *frequency* instead:
`diff = spec[t] − maxfilter_over_frequency(spec[t−1])`.

**Design choice.** The reference implementation takes a 3-bin max on a 24
band/octave triangular filterbank — a musically scaled tolerance. On our
linear FFT a fixed bin count is a fixed Hz tolerance, so the filter width here
scales with bin index instead: every bin's neighbourhood is the bins within
±S semitones, never less than ±1 bin (near DC a musical interval rounds to
zero bins, and the unresolved-harmonic sloshing lives between *adjacent*
bins). A filterbank was rejected because it would re-scale every downstream
constant and rebuild the arrival-band voting structure in the same change;
the per-bin width gets the musical tolerance without either.
`kernels/onset.ts` takes `maxFilterSemitones`; `transient.fluxMaxFilterSemitones`
carries it, **0 (off) by default**.

**The falsifier — passed decisively** (`scripts/measure-freqmax-ripple.ts`,
steady sawtooth low E, re-pick at 1.5s):

```
configuration                          steady p50   steady max   attack flux   worst/attack
time max, 3 frames (current)               0.0009       0.1167        1.7846          0.065
no memory, no freq max                     0.0016       0.1167        1.8182          0.064
freq max ±0.5 st, 1 frame                  0.0000       0.0104        1.0941          0.010
freq max ±1.0 st, 1 frame                  0.0000       0.0078        1.0695          0.007
freq max ±1.0 st, 2 frames                 0.0000       0.0078        1.0694          0.007
freq max ±1.0 st, 3 frames                 0.0000       0.0078        1.0669          0.007
```

With no time memory at all, the frequency max holds the worst steady hop an
order of magnitude below what the three-frame time max holds it at, and
adding time memory back changes nothing — the substitution is total. The
attack keeps ~60% of its flux, still two orders above the ripple. (Note the
documented alternate-hop swing reproduces here as a *slow* ripple: the beat
period at 82.41Hz is ~12.1ms against a 11.6ms hop, so the beat aliases across
many hops — which is also why three frames of time memory never fully
suppressed it; both configs share the same 0.1167 worst hop.)
`tests/onset.test.ts` now holds the steady-low-E and same-pitch-re-pick
properties under `referenceFrames: 1, maxFilterSemitones: 0.5`.

**At the kernel on the corpus** (`scripts/measure-freqmax-sweep.ts`, the
coverage-vs-off-label rule every kernel constant was derived by):

```
configuration                        derive covered   off-rate   held-out covered   off-rate
baseline: time max, 3 frames                62 / 78      1.27%          358 / 381      0.85%
freq ±0.5 st, 1 frame                       58 / 78      1.31%          361 / 381      0.67%
freq ±1.0 st, 1 frame                       57 / 78      1.16%          349 / 381      0.48%
freq ±0.5 st, 1 frame, floor 0.18           61 / 78      1.65%          367 / 381      0.94%
freq ±0.5 st, 1 frame, floor 0.14           62 / 78      2.49%          375 / 381      1.76%
```

By the derivation rule (highest coverage at an off-label rate no worse than
the incumbent) no frequency-max point beats the baseline — the derivation
loss is entirely `clean-lead-120bpm`. The held-out columns, read but never
chosen on, say the opposite: ±0.5 st covers *three more* labels at a *21%
lower* off-label rate. A reversal of that shape is what an incumbent tuned to
its own derivation set looks like from outside, and it is worth remembering
when this is next revisited.

**End to end**, filter on at ±0.5 st / one frame, everything downstream
untouched: **45 missed / 70 split / 77 extras** against 32 / 99 / 107. The
new misses live in `split made; successor paired with a neighbouring label`
(8 → 15) and in rearticulation rejections whose witness scale shrank
(`no-energy-not-sharp` 2 → 5): the short-reference flux runs smaller against
the higher reference, so `sharpness` and `fluxRatio` shrink — measured at the
78 derivation labels, to a median 0.849 of baseline. Rescaling the two bars
that read that scale (`rearticulationSharpness` 1.6 → 1.36,
`newPitchSharpness` 0.6 → 0.51) recovers only two: **43 missed / 71 split /
78 extras**. Lowering the kernel floor to 0.18 instead is *worse* (51 missed
/ 75 split / 83 extras) — more firing feeds the split churn it was supposed
to relieve.

**Verdict.** The mechanism is real and the substitution claim survives its
falsifier, but on this corpus the frequency max *moves the operating point*
(−29 extras for +11 missed at its best) rather than dominating, and the
project bar is that both axes count. Shipped as a config-gated capability,
off by default. The condition under which to revisit: any future change that
attacks the split-pairing and too-young losses directly would change the
trade's terms, and the held-out reversal above suggests the honest gap is
smaller than the derivation columns make it look.

### 2. Adaptive whitening fixes the take-scale problem and still cannot make the decision

Stowell & Plumbley (ICMC 2007): per bin, keep a running peak
`P[f] ← max(|X[f]|, m·P[f], floor)` and divide, so every bin occupies [0, 1]
regardless of roll-off and dynamics. If the 0.808 → 0.434 LOTO collapse is
take-dependent feature scale, whitened flux should not collapse.

Measured without touching the engine (`scripts/measure-whitening-separability.ts`:
identical decision-table population, whitened witnesses computed on the same
window and hop grid and joined by timestamp; `m` and floor swept on the five
derivation takes only):

```
model                                    in-sample   5-fold   leave-one-take-out
baseline: twelve witnesses                   0.808    0.758                0.434
whitened only, m=0.99 floor=0.01             0.723    0.688                0.608
whitened only, m=0.99 floor=0.001            0.702    0.674                0.543
twelve + whitened, m=0.99 floor=0.001        0.845    0.773                0.414
```

Three things are true at once:

- **The diagnosis is confirmed.** Whitened-only witnesses barely collapse
  (0.723 → 0.608 against 0.808 → 0.434): their scale genuinely survives a
  change of take, which is what the falsifier asked (LOTO materially above
  0.434 — passed).
- **Adding them to the twelve does not help** (0.414): the unstable features
  still poison a jointly fitted model. Fusion, if ever, must be at the
  decision level — consistent with the Holzapfel result the brief cites.
- **Stability is not separation.** Held out, fitted on derivation only, the
  whitened-only rule reads 0.683 AUC (twelve: 0.647; single sharpness:
  0.667), and at the derivation zero-label-cost threshold it keeps 309 of 310
  positives while admitting 237 of 254 false candidates. Wired in as a veto
  on decisions the tracker *acted* on, bar chosen on derivation at zero cost:
  across all twelve held-out takes it clears **2 false splits and costs 1
  true one**. That is the ledger answer, and it is nothing.

**Verdict.** The brief's caveat verbatim: a better-behaved feature that still
cannot make the distinction. Not wired into the engine. What survives is the
method: any future witness should be judged on its whitened form first, since
scale-stability is now demonstrated to be cheap to add and the un-whitened
LOTO number understates every candidate.

### 3. Cycle dissimilarity: the phase-reset argument does not survive contact with the decision population

The one candidate that is not an energy detector: a decaying string satisfies
`x[n] ≈ α·x[n−T]`, a pluck resets the relative phases, so normalised
cross-correlation at lag T (searched ±2 samples, T from the previous hop's
2048-window YIN, N = 2T ≤ 32ms — safely inside a 107ms sixteenth) should drop
at a re-pick whether it is louder, equal, or muted. Prior art: US 9,646,591
("in the absence of sufficient envelope follower amplitude changes, phase
changes become a critical detection criteria"), Zhou & Reiss 2007/2010.

The falsifier was stated before the run: if `D = 1 − r` does not clear the
best existing witness (0.73 AUC) on the *monophonic derivation* subset, stop.
Measured (`scripts/measure-cycle-dissimilarity.ts`; 93 monophonic derivation
rows, 35 positives; ten variants including the gain split `g`, `D·(1−g)` for
the muted-repick signature, one-hop-late windows, and a running-baseline
deviation):

```
witness                              monophonic derivation AUC
sharpness, same rows                                     0.721
dExcess (D − 5-hop baseline)                             0.579
dMax (worst of this hop, next hop)                       0.577
d0                                                       0.552
gain g                                                   0.537
D·(1−g)  (muted-repick signature)                        0.487
YIN aperiodicity (cmnd), this hop                        0.521
YIN aperiodicity, hop before                             0.519
```

Gating harder (not gliding, aperiodicity ≤ 0.25 before the attack — the
conditions the feature was *designed* for) reaches only dMax 0.628 against
sharpness's 0.703 on the same 59 rows. **The falsifier fired: 0.577 against
a bar of 0.73. The line stops.** YIN's own aperiodicity, added because it is
free and scale-bounded, is at chance too.

Why it fails here, stated as precisely as the data allows: every row in the
decision table is a hop where an energy witness already fired over a sounding
Note. The negatives are not clean decay — they are sustain churn, beating and
compressor pumping that *already look transient* to the flux kernel, and
cycle continuity breaks at those hops too. And the positives include re-picks
of a string that was still ringing, where the string keeps most of its state
through the pick — the phase is *not* fully reset, the patent's clean
"adjacent cycles are very similar" premise belongs to its hexaphonic,
per-string pickup, which never sees a neighbour's partials or a room. The
amplitude-invariance is real; the discontinuity it is invariant *about* is
simply present on both sides of this decision.

### Where this leaves the same-pitch decision

Three literature mechanisms, three honest verdicts: one substitutes perfectly
for a component we already had (and buys a different trade, not a better
one), one fixes the measured statistical defect without touching the decision
that mattered, one is refuted at its own chosen subset. The 0.73 ceiling on
this decision now has *eight* converging negatives against it, three of them
from feature families that are not energy detectors. The annotation-noise
fraction of that ceiling (Dixon 2006; non-percussive onsets carry high
annotator variance) is increasingly the live hypothesis: the next cheap
experiment is not another feature but a second, independent labelling pass
over a few takes to measure the human–human AUC on exactly these decisions.

## The label ceiling, measured: a second annotation pass over every contested moment

The previous section ended by naming the next experiment: not another feature,
but a second, independent labelling pass to bound how much of the 0.73 AUC
ceiling is annotation noise. That measurement now exists. The tooling is three
scripts — `build-relabel-kit.ts`, `machine-annotate-relabel.ts`,
`score-relabel.ts` — and the machine half of the measurement has been run to a
verdict. The human half is a listening kit, built and waiting.

### The kit

Every contested moment in the corpus, rendered as an anonymised 1.5s WAV an
annotator judges blind: the 32 missed labels (each carrying its ledger cause),
106 extra-Note boundaries (the start of every Note past the first under
`measure-splits.ts`' own ownership rule; one of the 107 deduplicated into a
neighbouring miss), and 110 decision-table rows within 70ms of a label where
the detector and the graded target disagree — 248 contested points, plus 54
uncontested controls (matched labels, clear of anything contested, seeded-PRNG
chosen) so an annotator cannot learn that everything is a trick question. The
moment under test is jittered ±150ms off snippet centre so its position never
encodes the claim; ids are opaque hashes; the manifest (id → fixture, time,
cause) is kept separate from the answer sheet and nothing in the kit reveals
what the detector or the shipped labels say. `fixtures/labels/` is untouched.

The answer sheet asks one question per snippet — does a NEW note start in the
middle third, and if so where (offsets in ms; several allowed) — and
`score-relabel.ts` grades any completed sheet at 25/50/70ms tolerances, split
by contested/control, point kind, derivation/held-out, signal path, and ledger
cause, with the implied ceiling computed as the annotator-oracle's AUC against
the shipped grading.

### Annotator M, and what its calibration already measured

The machine pass reads ONLY the anonymised audio. Its onset evidence is
deliberately not the engine's: superflux-style spectral flux at a 5ms hop with
±1-bin frequency tolerance, plus the 2-8kHz fine envelope at 1ms resolution
(`kernels/click.ts`). The decision rule in `docs/ceiling-click-tracker-prompt.md`
was stated in advance: an annotator must agree with the shipped labels on ≥95%
of CONTROL points (headline 50ms) or the pass is broken and must be fixed
before its contested answers are read.

Getting an annotator through that bar was itself a measurement:

- The first cut (adaptive flux bar at 1.5x the local median) passed controls —
  **96.3%** at 50ms, 100% at 70ms — but on full takes it marked 4-20x as many
  onsets as the take has played strokes (214 in the 24s of `clean-lead`'s 43).
  Flux alone hears vibrato churn, strum constituents and fret noise as onsets.
- Every precision gate tried against that — require a broadband envelope rise,
  require a compact 2-8kHz click, require both — failed the control bar
  (71-85%). Measured at the control strokes themselves: envelope-rise p5 is
  **0.80** (a twentieth of CLEAR strokes get quieter across their own onset),
  click-ratio p5 is **1.45**, flux-prominence p5 is **2.35** against a median
  of 18. **No corroboration gate keeps 95% of clear strokes on this material.**
  That is the engine's own recall/precision wall, measured from the other side
  with different features at a different timescale, and it is the single most
  clarifying number this pass produced.
- The final annotator is therefore graded, not gated: the liberal reading (all
  flux picks above the adaptive bar) is the primary answer and satisfies the
  control bar; every offset carries a corroboration tag (`s`/`w`), and the
  strict reading (corroborated only, ~87% of controls at 50ms — below the bar,
  a secondary bound) is reported alongside.

### The verdict, by the pre-stated rule

Control bar: **PASS, 96.3%** (52/54 at 50ms; 54/54 at 70ms). Timing where both
sides name a time: median +2ms, p90 +34ms. The contested numbers, liberal
reading:

| kind | n | agree@25 | agree@50 | agree@70 | annotator hears, labels lack | labels claim, annotator silent |
|---|---|---|---|---|---|---|
| miss | 32 | 69% | **91%** | **97%** | 0 | 1 |
| decision-missed-accept | 84 | 67% | 85% | 98% | 0 | 2 |
| decision-false-split | 26 | 62% | 81% | 100% | 0 | 0 |
| extra-note | 106 | 42% | **27%** | **48%** | **55** | 0 |
| control | 54 | 89% | 96% | 100% | 0 | 0 |

Two different answers, one per axis:

1. **The missed labels are real.** The independent pass confirms 29 of 32 at
   50ms and 31 of 32 at 70ms — including all eight `too young to be ended`
   losses at 25ms. Label noise is NOT what makes them missed; the pre-stated
   under-10% branch of the decision rule applies to this subset, the headroom
   on the miss side is real, and Task 1's consensus carve-out for the witness
   studies turns out to be empty: every derivation decision row survives
   (161 of 161), so the 0.73 bar stands ungraded-down.
2. **The extra-Note axis carries real annotation ambiguity.** At 55 of the 106
   extra-Note boundaries the machine pass hears an onset within 70ms where the
   shipped labels have none — and the strict corroborated reading barely moves
   that (64% vs 63% agreement at 50ms on contested points): these are not
   marginal flux ripples but corroborated signal events. Not concentrated on
   the room-mic path (DI 15, amp 15, mic 20, room 5), so the >30%-on-room-mic
   branch of the rule does not fire as written; what fires instead is its
   spirit on one axis: an "extra Note" at a moment where an independent
   annotator hears an articulation is not unambiguously the detector's error.
   Whether those 55 moments are unlabelled ghost/grace strokes and strum
   components (the labels annotate musical strokes, not articulation events)
   or the machine pass's residual liberality is exactly what the HUMAN pass
   exists to arbitrate, and machine-only cannot settle it.

The implied ceiling on the graded decision rows (annotator-oracle against the
shipped grading): 0.59-0.65 at 25-50ms — but read that with its confound: a
decision row's time is a hop-grid point up to 70ms from the label it graded,
so tolerance-level disagreement there is partly quantisation, and at 70ms the
decision-row population has no graded negatives at all. The clean statements
stay the two numbered ones above.

Human pass: rebuild with `npx tsx scripts/build-relabel-kit.ts`, listen per
`.cache/relabel/README.md` (20-30 minutes covers the two or three takes that
matter most — the extra-note points on the triplet and cowboy takes), score
with `npx tsx scripts/score-relabel.ts .cache/relabel/answers-<name>.csv`.

## The millisecond click, measured at its own timescale — and refuted at the decision

The one physical cue in the corpus no experiment had touched: a pick's 1-5ms
broadband click, measured by every existing witness only after dilution into a
23ms window on a 12ms grid. The hypothesis was temporal COMPACTNESS as the
churn-proof discriminator; the falsifier, stated before the run: the best
single compactness witness clears 0.73 AUC on the derivation decision rows and
does not collapse on the room-mic path, or the line closes with no rescue
variants beyond the named set.

`scripts/measure-click-separability.ts` follows the whitening study's pattern:
engine unchanged, decision-row population identical to the baseline study's,
witnesses computed from `kernels/click.ts` (causal 2-8kHz biquad cascade,
rectified, 1ms boxcar, decimated to a 0.5ms grid) and joined by hop timestamp,
with the click's true time searched over the hop's full ±12ms. The window rule
is enforced by masking rather than assertion-failure: adjacent-label onsets
are excluded from every surround ring (8-45ms each side of the peak, inside
±53ms — half a 107ms sixteenth; 10 sixteenths rows needed masking).

**The falsifier fired.** On the 161 derivation decision rows:

| witness | oriented AUC | direction |
|---|---|---|
| sharpness (the incumbent, same rows) | **0.728** | high |
| local kurtosis ±20ms | 0.586 | LOW — spikier at negatives |
| compact duration above half peak | 0.560 | HIGH — re-picks LONGER than churn |
| peak / surround-ring median | 0.538 | low |
| peak / pre-ring median | 0.538 | high |
| rise slope (peak / 3ms earlier) | 0.520 | low |

Every witness is at or near chance, and both compactness readings point the
WRONG way: at the accept/reject margin a re-pick's click band is no more
compact than the churn it lands on. The distributions say it plainly —
peak-to-surround medians 1.78 (re-picks) against 1.82 (churn).

**The measurement is not broken, and that is established inside the same
script.** A positive control runs the identical code paths on moments whose
answer is known — every label onset against a point 180ms into every
long-enough event — and there the click is plainly visible: peak-to-pre-ring
**0.838**, peak-to-surround 0.746. The cue is real against clean sustain and
dead at this decision, whose negatives are hops an energy witness already
fired on: compression pumping, strum components and fret noise put 2-8kHz
spikes at the negatives too, and — the same population lesson cycle
dissimilarity taught (DECISION-015) — a re-pick over a still-ringing string
is often gentler than what it interrupts. Two independent measurements in this
pass corroborate the mechanism: annotator M's control-stroke click-ratio p5 of
1.45 (clear strokes routinely have almost no click prominence, particularly
through the amp sim, median 2.24), and the per-path table, where the witness
family is weakest exactly where compression lives (amp sim 0.526-0.567) —
the trap the brief named, confirmed rather than averaged away. Room mic did
not collapse below the others (peakToPreRing 0.731 there), so hiss was not
what killed it; the decision population was.

Ninth converging negative on this decision. The one use the click band has
demonstrably survived is not discrimination but instrumentation: the fine
envelope localises a KNOWN onset well (the positive control, and annotator
M's offset refinement), so sub-hop boundary PLACEMENT remains open — untested
— even though click-as-witness is closed.

## The tracker harvest: the ledger's own window bug, and a repair measured to a one-extra loss

### Six of the eight "split-pairing" losses were never bookkeeping

`measure-downstream-ledger.ts` attributed a trace event to a missed label
whenever it fell within ±70ms. Six of the corpus's missed labels sit **55-77ms
after their neighbour** — rushed pairs, annotated closer together than the
window — so the neighbour's own correct boundary (+15-20ms late, correctly
paired by the matcher) was read as "split made; successor paired with a
neighbouring label" on the missed stroke. Traced concretely on the DI
sixteenths take: labels s19@5610 and s20@5673 are 63ms apart; the onsets at
5520 and 5627 are s18's and s19's own (+17ms each); s20 has no transient at
all — the kernel's `minIntervalMs` is 60ms and its post-attack reference is
still elevated where the second stroke of a rushed pair lands.

The fifth instance of the window-wider-than-the-spacing error class in this
project, and the first INSIDE the diagnostic that names causes. `classify`
now attributes an event to a label only when that label is the event's
nearest, and the corrected cause table redraws the map (MISSED unchanged at
32; this is attribution only):

| cause | was | is |
|---|---|---|
| no transient within the window | 4 | **10** |
| band-only transient | 1 | **4** |
| too young to be ended | 8 | 8 |
| split made; successor paired with a neighbouring label | 8 | **2** |
| absorbed, then paired with a neighbouring label | 3 | 1 |
| never announced / absorbed-then-never-announced | 4 | 4 |
| rejected (no-energy-not-sharp, gated) | 3 | 3 |
| no boundary here; neighbour's | 1 | 0 |

The brief's premise — "roughly 23 of 32 are attribution and timing, not
evidence" — was partly this artifact. The honest split is ~14 of 32 upstream
of the tracker (no transient + band-only, most of them rushed pairs inside
the kernel's dead time), 8 in the thrice-measured `too young` interaction,
and ~10 in assorted bookkeeping.

### Built, measured, reverted by the stated bar: announce credit for a stub the same attack opened

`NoteRecord.absorbedRenaming` discounts an absorbed step-split stub's span
from the announcement clock, on the argument that a step-split stub is the
PREVIOUS note still ringing while the estimator caught up. The trace at the
room-mic sixteenths s45 shows the case where that argument misfires: the
attack at 9387 opens n42 (trigger `attack`, burst 9387), the estimator reads
the new pitch 40ms later, the step split absorbs n42 into n43 — same
`burstAt`, this stroke's OWN attack still arriving, exactly the wording the
attack-split branch uses — and n43 then dies unannounced at the next stroke
with `announceSoundedMs` 53 against a real sounded span of 93.

The change: set `absorbedRenaming` only when the absorbed stub was NOT
attack-opened at the survivor's own burst. Measured end to end:

| | missed | split | extras |
|---|---|---|---|
| baseline | 32 | 99 | 107 |
| own-attack announce credit | **29** | 100 | **108** |

The three recovered labels are real (room-mic sixteenths s45, room-mic
triplet e14 and t8 — all confirmed by the annotation pass above). The +1
extra is the change exposing a pre-existing defect rather than creating one:
at e14/e15 a weak transient (sharpness 2.5) split n46 off at 17053, 53ms
before e15's real attack at 17120 (sharpness 10.0, four times sharper) —
which then hit the `settled` gate at 53ms < 55 by the same two milliseconds
the too-young section documents, so the premature boundary stood and the real
one was dropped. Announcing e14's true B4 put a second Note inside e14's
ownership span, +1 extra.

The pre-stated per-change bar — strictly improve one axis, no worse on the
other — reads 108 > 107 and the change is reverted, recorded here with its
mechanism intact. What it establishes for the next attempt: the announce
accounting IS wrong for own-attack stubs (three real labels prove it), and
the fix becomes shippable the moment the premature-weak-boundary shape it
exposes is repaired — a boundary opened on a transient several times weaker
than the attack that arrives inside the settle window is the natural
candidate for re-dating to the stronger attack, though that needs a
strength-ratio constant the derivation takes may not exercise, and the
too-young ground is thrice-burned (see "The `settled` bar is two milliseconds
off"). Not attempted blind here.

### Not re-run, and why

`minStableMs` variants (three documented failures, same shape each time), the
causal rate estimator (documented: oracle ceiling is 8 emitted Notes, the
causal estimate is biased into the costly band), and the retroactive
same-pitch merge without a new discriminator (documented: every bar that
removes extras eats sixteenths labels). The fragment-versus-its-two-
neighbours comparison remains the open version of the rate idea; nothing in
this pass touched it.
## A learned onset head, trained on external data: the bet, run to its falsifier

The eight converging negatives above say the same-pitch re-articulation
decision cannot be improved by better logic over 78 derivation events. The
standing answer in the field — Basic Pitch's ~17K parameters trained on large
labelled corpora — is a small learned function whose unlock is DATA, not
architecture. `docs/learned-onset-head-prompt.md` specified the experiment;
DECISION-016 amended the dependency constraint to admit fixed weights (≤ ~25K
parameters, plain TypeScript over `Float32Array`) so a win could actually
ship. The falsifier was stated before anything was trained: **the frozen
model must clear 0.73 AUC — the best existing single witness — on this
repo's derivation decision table, nothing tuned on those rows, or the bet
fails.** It failed. The numbers, and what was learned, follow.

### The setup, honestly capable of winning

The population rule is the decisive lesson of DECISION-015 applied: training
rows are not "onsets vs decay in the abstract" but the engine's OWN
`rearticulation` trace events, produced by driving the real
`RecognitionEngine` over GuitarSet (360 excerpts, six players, comping and
soloing; Zenodo 3371780), labelled by the exact target rule of the baseline
study's `collect()` — 70ms window, trace-order covered-check, per-string
`note_midi` onsets merged at 30ms to match this repo's strum-level labels.
EGDB, the closest-domain corpus, was unreachable (its official host is a
Google Drive folder; the environment's egress policy denies it) — recorded,
not substituted with synthesis. Both GuitarSet mono flavours were used (the
room mic, and the summed hexaphonic pickup as the DI-adjacent signal), each
through three deterministic per-take augmentation chains (`training/augment.ts`:
clean, amp-like drive+cab+compression, synthetic-room convolution), because
the corpus this must transfer to is electric heard three ways.

Yield: **248,993 decision rows, 174,379 positive (base rate 0.70), from
18.28 hours of augmented audio — 13.6K rows/hour** against this corpus's
~2.6K/hour and 725 rows total. A 343× larger population of exactly the
decision under study.

Features per row: a causal 9-hop × 60-band patch of the adaptively whitened
spectrogram (m = 0.99, floor = 0.01 — the DECISION-014 machinery, scale-free
in [0,1] by construction), ending AT the decision hop on the engine's own
grid; the twelve existing witnesses; four whitened flux readings. One
alignment fact mattered and is worth keeping: the engine's flux windows END
at hop boundaries (`readEndingAt`), while the whitening study's standalone
grid (windows STARTING at hop multiples) sits 5.33ms off it at 48kHz — a
silent train/serve skew if trained on. `training/features.ts` extracts on
the engine grid, through the same `src/engine/kernels/whitened-bands.ts`
class the engine would run live, and a bit-for-bit parity test held while
the runtime integration existed (commit d836ec9).

The model: 19,833 parameters — conv 3×3×8 / pool / conv 3×3×16 / pool /
dense 24 over the patch, dense 16 over the scalars, merged to a sigmoid —
trained in `training/train.ts` (hand-rolled Adam over `Float32Array`, a
finite-difference gradient check in CI reach, deterministic seeded runs).
Split grouped by PLAYER (04 and 05 held out), early stopping reading the
external validation AUC only; the derivation five appeared as a printed
curve and influenced nothing; the twelve 140bpm takes were never loaded by
anything under `training/`. Forward pass, measured: 190µs per decision —
under 2% of a core at the corpus's worst-case 83 decisions/second.

### What the external data taught, and what it did not

On its own domain the model is good, uniformly across every signal path it
was shown — external validation AUC at the early stop, players never trained
on:

```
overall           0.8820
mic-clean         0.8730      pickup-clean      0.8900
mic-amp           0.8384      pickup-amp        0.8616
mic-room          0.8966      pickup-room       0.9194
```

Frozen and scored on this repo's derivation decision table (161 rows, 59
positives — the same rows, same target, as every number in the ceiling
studies):

```
model                                  external val   derivation AUC   (bar 0.73; sharpness reads 0.7281 on the same rows)
full: patch + 12 witnesses + 4 wflux         0.8820           0.7157   FAILED
wflux: patch + 4 wflux only                  0.8215           0.6260   FAILED
none: patch only                             0.8175           0.6291   FAILED
```

The two ablations were pre-planned (the `--scalar-mode` flag predates any
result) and selection between variants read external validation only; every
derivation read taken is in the table above. The ablation prediction — that
the twelve witnesses' take-dependent scale would poison transfer, so
dropping them would cost a little external AUC and transfer better — was
**refuted on both ends**: removing them cost six points externally AND nine
points on the derivation table. The witnesses carry real, transferable
signal; the patch alone is weaker everywhere.

Falsifier 2's shape, for the full model:

```
take                                       rows   pos   AUC
chords-a-bm-g-d-2x-120bpm                    25    10   1.000
cowboy-chords-c-d-em-g-c-d-em-am-120bpm      28     9   0.901
power-chords-c-a-g-e-c-d-fsharp-e-120bpm     26     2   0.708
clean-lead-120bpm                            71    38   0.605
spicy-chords-cmaj9-g-am11                    11     0     -
pooled 0.7157; leave-one-take-out calibrated 0.5133
zero-label-cost operating point: 101 of 102 negatives admitted
```

Three things are true at once. The model does not collapse the way the
fitted twelve-witness model did (0.808 → 0.434): fitted on zero rows of this
corpus, it lands at 0.716 across an acoustic→electric domain change, which
is transfer the fitted models never had. Its failure is *localised*: chords
rank at 0.90–1.00 while `clean-lead-120bpm` — 44% of the table — reads
0.605. And its score LOCATIONS shift per take even where ranking is good:
recalibrating a single threshold across takes (the LOTO logistic over the
score alone) collapses the pooled figure to 0.513, and keeping every
derivation positive admits 101 of 102 negatives. Even had the ranking bar
been cleared, no usable operating point exists on this corpus today.

**Correction, same day.** An earlier revision of this paragraph called
`clean-lead-120bpm` "the dense same-pitch re-picking the whole problem is
about". That is false, and the subsection below ("The derivation set holds
eight instances…") measures what is actually there: the take is a rising
scale, 43 notes, **zero** consecutive same-pitch events. The per-take
ordering above therefore does not say what it looks like it says — the take
the model scores 1.000 on is the one holding every same-pitch instance in
the derivation set, and the take it scores 0.605 on holds none.

### Verdict, and the state of the ledger

**The falsifier fired: 0.7157 against a bar of 0.73, with the best
hand-built witness at 0.7281 on the same rows.** Per the protocol stated
before the run: written up, logged (DECISION-021), stopped. Nothing is
wired; the runtime integration built for the win condition was removed
again (the plumbing survives in this branch's history at bfce0ad); the
engine is bit-identical to baseline — eval PASS, ledger 32 missed / 99
split / 107 extras, 494 tests, `npm pack` contents unchanged. **The twelve
140bpm held-out takes were never read** — not in training, not in
validation, not in any falsifier — so the once-only held-out read remains
unspent for a future attempt that clears the derivation bar first.

What survives for that attempt: the full pipeline under `training/`
(extraction, augmentation, trainer, falsifier scoring — deterministic and
committed), the whitened band kernel in `src/engine/kernels/`, the engine
hop-grid alignment fact, and a trained baseline (rebuild with
`bun training/train.ts --rows training/out/rows --corpus training/out/corpus`)
whose external number says the DECISION is learnable — six players, six
signal paths, 0.88 — while its derivation number says GuitarSet-plus-
augmentation is not yet this corpus. The two named routes forward, in order
of expected value per hour: **closer-domain training data** (EGDB DI when
the egress policy allows it, or a few minutes of self-recorded electric
takes labelled the way the fixtures are — the augmentation chains did not
close the clean-electric-lead gap and more of the same GuitarSet will not
either), and the **second independent labelling pass** the previous section
already argued for: `clean-lead-120bpm` at 0.605 under a model that ranks
chord re-articulations near-perfectly is also consistent with the
annotation-noise fraction of the ceiling living exactly there.

### The per-take ordering is mostly branch composition, and two of its cells are not measurements

The per-take table above invites a musical reading — "better on chords than
on power chords" — and this project has produced a false finding that way at
least four times. Bootstrapped (2000 draws, resampling rows within take,
same frozen reads):

```
take                                       rows  pos  neg  pairs   AUC   [95% CI]
chords-a-bm-g-d-2x-120bpm                    25   10   15    150  1.000  [1.000, 1.000]
cowboy-chords-c-d-em-g-c-d-em-am-120bpm      28    9   19    171  0.901  [0.750, 1.000]
power-chords-c-a-g-e-c-d-fsharp-e-120bpm     26    2   24     48  0.708  [0.480, 0.913]
clean-lead-120bpm                            71   38   33   1254  0.605  [0.469, 0.733]
spicy-chords-cmaj9-g-am11                    11    0   11     -      -
```

**The power-chords cell is 48 pairs and its interval spans chance to
near-perfect: it is not a measurement**, and neither is `spicy-chords`, which
has no positives at all. Nothing about power chords as a voicing can be read
from it. What does survive is the contrast the section above rests on:
`cowboy` [0.750, 1.000] and `clean-lead` [0.469, 0.733] just fail to
overlap, and `chords-a-bm-g-d` is 1.000 in every draw.

The takes differ far more in WHICH CASCADE BRANCH produced their rows than in
anything musical. Power chords are 15 of 26 rows `chord-past-muted-window`
with 1 positive; `spicy-chords` is 6 of 11 the same branch with none. Both
takes are ones where the tracker already finds its boundaries by other means,
so almost nothing in them is load-bearing for this decision — which is why
they have two positives between them, not because a power chord is hard.

### The fusion scope capped the ledger upside at six labels, before any model quality

Grouping all 161 derivation rows by the branch that decided them, against the
scope the decision-level fusion was given (`rearticulation.ts`, commit
bfce0ad):

```
branch                        rows  pos   the learned witness could...
chord-past-muted-window         36    5   nothing — guard, out of reach
envelope-rise                   26    6   veto
sharpness                       24   15   veto
no-energy-not-sharp             15    3   override to accept
chord-decay-excess              13    8   nothing — strong-evidence accept
gated                           10    7   nothing — sub-gate, no Note may open
ring-out-not-sharp              10    2   override to accept
chord-sharpness                  9    7   veto
ring-out-below-floor             8    5   nothing — guard, out of reach
chord-not-sharp                  5    1   override to accept
glide-rise                       3    0   nothing — guard, out of reach
new-pitch                        2    0   nothing — strong-evidence accept
```

**Six of the 59 derivation positives sit in the accept-override pool.**
Twenty-five sit behind branches the fusion deliberately kept out of the
witness's reach — seven of them `gated`, where the fast lane refuses to act
on sub-gate audio at all (a different question, already measured elsewhere),
five behind `ring-out-below-floor` and five behind `chord-past-muted-window`,
each of which was measured into place for reasons recorded above. The veto
side is larger: 31 negatives sit in accept branches a veto could suppress,
against 28 positives it could destroy.

So even a PERFECT learned witness, under the scope it was given, could have
recovered at most six derivation labels — and falsifier 3, the ledger run,
was never going to see a large missed-label win no matter how good the model
was. That is a design finding independent of this model's failure, and it is
the first thing to fix in any next attempt: decide the scope from where the
positives actually live, and state the reachable ceiling BEFORE training,
not after. Widening it is not free — every branch listed as out of reach is a
guard some earlier experiment put there — but a fusion whose reachable upside
is six labels should be recognised as such while it is still cheap to change.

## The derivation set holds eight instances of the problem the derivation set is used to solve

Counting consecutive labelled events that carry the SAME pitch or chord name
— the literal definition of the decision eight experiments have been aimed
at — across every fixture:

```
                                                    events   same-pitch repeats   median gap
DERIVATION (all tuning happens here)
  chords-a-bm-g-d-2x-120bpm                             16                    7        506ms
  clean-lead-120bpm                                     43                    0        167ms
  cowboy-chords-c-d-em-g-c-d-em-am-120bpm                8                    0       2027ms
  power-chords-c-a-g-e-c-d-fsharp-e-120bpm               8                    0       2000ms
  spicy-chords-cmaj9-g-am11                              3                    0       4610ms
                                                                        TOTAL 7

HELD OUT (scored, never fitted)
  lead-line-sixteenths-e-fsharp-140bpm      x3          48                   36        105ms
  power-chords-b-a-g-fsharp-b-a-g-e-140bpm  x3          16                    8        861ms
  lead-line-quarter-eighth-triplet-140bpm   x3          55                    2        209ms
  cowboy-chords-d-em-g-c-2x-140bpm          x3           8                    0       1727ms
                                                                      TOTAL 138
```

**Seven same-pitch repeats in the derivation set, and all seven in one take.**
Against 138 in the held-out set, 108 of them in the three sixteenths takes
where the same E5 is picked four times at 82–144ms spacing.

Carried through to the decision table the ceiling studies actually fit on —
labelling each positive by whether its target label repeats the pitch of the
label before it:

```
take                                       rows   pos   same-pitch re-artic.   new pitch arriving
chords-a-bm-g-d-2x-120bpm                    25    10                      8                   2
clean-lead-120bpm                            71    38                      0                  38
cowboy-chords-c-d-em-g-c-d-em-am-120bpm      28     9                      0                   9
power-chords-c-a-g-e-c-d-fsharp-e-120bpm     26     2                      0                   2
spicy-chords-cmaj9-g-am11                    11     0                      0                   0
TOTAL                                       161    59                      8                  51
```

**Eight of 59 derivation positives — 14% — are same-pitch re-articulations.**
The other 51 are a new pitch arriving over a Note that has not finished
ringing, which the engine routes through the same branch (an attack over a
sounding Note) but which is a different question with different evidence
available: the pitch has changed, and something downstream can eventually
see that. On `clean-lead-120bpm` the `new-pitch` branch nonetheless fires
only once in 71 rows, because at the decision hop YIN has not yet confirmed
the arriving pitch — so the cascade answers a same-pitch question about an
event that is not one.

Three consequences, in increasing order of how much they should change what
happens next.

**The ceiling number is mis-titled.** "Best single witness 0.728 AUC on the
same-pitch re-articulation decision" is, on inspection, 0.728 on a
population that is 86% new-pitch arrivals. Every study since DECISION-009
that reported a derivation AUC — including this one's falsifier 1 — measured
that mixture. The numbers are not wrong; their name is.

**The leave-one-take-out collapse has a simpler available explanation.**
With all seven derivation same-pitch instances inside
`chords-a-bm-g-d-2x-120bpm`, the fold that holds that take out removes the
phenomenon from the training half entirely, and the folds that keep it in
have no held-out instance to be scored on. A 0.808 → 0.434 collapse under
those conditions is what a correct procedure looks like on a set that cannot
support it — which does not make the fitted model good, but does mean the
collapse is weak evidence for "the witnesses carry take-dependent scale" and
strong evidence for "there is nothing here to fit".

**The derivation set cannot support this problem, and no amount of cleverness
will change that.** Eight instances will not distinguish between competing
hypotheses about a decision this subtle, whatever the feature. This is the
most likely single explanation for the shape of the whole record above:
eight experiments tuned against eight examples and graded against 138.

The cheapest fix is not a feature, a model, or a labelling pass over
existing audio. It is **new derivation material containing the case**: a few
minutes of deliberate same-pitch re-picking — varied velocity, muted and
open, at sixteenth spacing and slower — recorded through the three signal
paths this corpus already uses, labelled by ear, and added to the derivation
side of the split. That would move the tuning set from 8 instances to some
hundreds, and it is the precondition for taking any further reading of the
0.73 ceiling seriously, including a re-run of the learned head on data whose
target population is actually the target.

## The retired `src/core/` lineage, scored on the held-out corpus

The branch cleanup of 2026-09-07 had one open question worth measuring rather
than asserting: `claude/tuninator-code-review-q5yzz2` carried a second, fully
independent detector — the pre-rewrite `src/core/` tree, developed past the
fork point with a four-estimator pitch front end (YIN, MPM, SWIPE-prime, an
attack-aware estimator) fused by weighted vote. It is the only branch in the
repository that ever contained a competing implementation of note detection.
The question was whether it detects better than what shipped.

It could not be answered from either branch's own numbers. **That branch never
had the held-out corpus**: its `fixtures/` carried the five derivation takes
only, and `fixtures/eval.config.json` had five entries. Every number ever
reported for it — including the 80.8% in its handoff — was measured on the
material it was tuned against.

### Method

The comparison was run on identical ground truth. The twelve held-out takes,
their labels, and the seventeen-entry `eval.config.json` were copied from
`main` into a detached worktree of `053526b`; the five label files the two
trees share are byte-identical, so no ground truth was reconciled, edited or
invented. Both detectors then ran their own `scripts/eval.ts` over all 459
labelled events.

### Result

```
                    labels  matched  missed   fp  |  exact   pitchClass
main (shipping)
  DERIVATION            78       76       2    8  |  78.9%        90.1%
  HELD OUT             381      351      30   84  |  84.7%        88.7%
retired src/core/
  DERIVATION            78       74       4   11  |  85.1%        93.2%
  HELD OUT             381      288      93   38  |  69.7%        71.1%
```

On the five takes it was tuned on, the retired detector is the better one: it
wins exact accuracy on four of the five, and its derivation pitch-class figure
(93.2%) is three points above the shipping engine's. On the 381 events it had
never seen, it finds **63 fewer of them** (288 vs 351) and its exact accuracy
falls 15 points. The gap is not uniform — it is a rig-generalisation failure.
Both amp-sim takes collapse to **0.0% exact** (`cowboy-chords-amped` 3 of 8
matched, `power-chords-amped` 8 of 16), and the hardest lead take in the corpus,
`lead-line-sixteenths`, drops to 16 of 48 against the shipping engine's 39.
Under the shared thresholds it fails ten fixtures including two marked
`required`; the shipping engine passes every required one.

Read on the standing two-axis bar, the shipping engine is not simply trading
extras for recall: 30 missed + 84 extra against 93 missed + 38 extra is fewer
total errors as well as far better labels. The retired detector's one genuine
advantage is its extras axis — 38 held-out false positives against 84 — and
that number is worth remembering, because it is the axis the shipping engine is
weakest on and the one the ledger work keeps returning to.

### Why this is the derivation-discipline warning, not a surprise

This is the split doing exactly the job §3 of `AGENTS.md` claims for it. A
detector tuned on 78 events, scored only on those 78 events, looked like the
better one by every number its own branch could produce — and the same detector
read 15 points worse the moment it met four performances through three signal
paths it had never been fitted to. The twelve held-out takes are the only
reason the question has an answer at all. Nothing about the retired lineage's
design was refuted here; what was refuted is the evidence that made it look
competitive, and that evidence was circular in exactly the documented way.

The lineage's own most valuable finding — that a still-ringing note dominates
the one that follows it, so a monophonic estimator reporting the loudest
periodicity is correct and still scored wrong — is not refuted by any of this.
It is the finding the current architecture was built to answer, and it is kept
in `docs/archive/detection-rearchitecture-handoff.md`.

## Forward absorption: the instruments were wrong, then the mechanism was refuted

The standing conclusion was that "the defect behind the largest block of splits
is a same-pitch boundary inside one event, not a name arriving late", and that
absorption reaches backward only. Both halves were tested against the 120bpm
same-pitch material (DECISION-026, 1,131 events across eight fixtures). The
first half is right and was being **under-reported by a factor of six**. The
second is right, and the mechanism that would fix it is refuted.

### The split-shape classifier could not see the shape it was built to find

`measure-split-shape.ts` reported **18** `same pitch twice` splits corpus-wide,
against 102 `named as before`. That reading is wrong, for two independent
reasons, and both are the error class this file already records four times: a
rule that was correct for the material it was written against.

**The name tests were ordered previous-name first.**

```
offset < -45ms            -> predecessor's own
name === previous.label   -> named as before      <- reached first
name === label.label      -> same pitch twice     <- unreachable when they coincide
```

On same-pitch material `previous.label === label.label`, so every split whose
leader began here and was correctly named fell into the naming bucket. On
`same-pitch-eighths-a3-120bpm-amped` — a take where all 184 labels are A3 — 49
of 50 splits sit on a same-pitch label pair, and the take reported **one**
`same pitch twice`. The categories' own definitions settle the order: `named as
before` is a claim that the NAME is wrong, `same pitch twice` that the BOUNDARY
is. When the names coincide the name is not wrong. Reordered, with an
`ambiguous` column counting where the two coincide:

| shape | before | after |
|---|---|---|
| predecessor's own | 146 | 146 |
| named as before | 102 | **7** |
| same pitch twice | **18** | **113** |
| named as neither | 28 | 28 |

**`predecessor's own` uses a 45ms window against labels carrying up to 65ms of
offset.** The amp-sim renders' labels were calibrated on the DI render and
applied unchanged (`docs/SAME-PITCH-MATERIAL.md`), and `verify-fixtures.ts` puts
their median offset at −35, +65, +25 and +45ms. Measured leader offsets on the
four amped takes run median −42, −30, −38 and −25ms against that −45ms bar: the
bucket boundary sits inside the label set's own placement error, so on these
takes the column separates nothing. A leader that begins "before" a label which
itself sits late is that label's own Note. The column is now documented as an
upper bound rather than retuned, because the labels are read-only.

### An instrument that uses no label onset at all

`measure-tail-fragments.ts` (new) classifies each Note past the first by the
**label's** pitch class — ground truth — and the gap to the Note before it.
Neither test reads a label onset, so a systematically late label set cannot move
the count.

```
  TOTAL                     split 294   extras 318
    same pitch (contiguous)   294
    detached                    0
    other pitch                24
    median shortest Note     93ms      median longest    227ms
```

**294 of 318 extra Notes are same-pitch and contiguous with their neighbour, and
not one is detached.** On the six same-pitch fixtures it is 175 of 175 — every
extra Note, without exception. The defect is exactly what the standing
conclusion said it was; only the instrument disagreed.

One number there rules out the cheap fixes. The median shortest Note in a split
event is **93ms**, against `tracking.minStableMs` 55 and `deep.minSegmentMs` 90.
These fragments are not sub-threshold blips that a bar could be raised past —
they are above every suppression threshold the engine has, and the median
longest is only 227ms, so the two Notes are of comparable size. The "~130ms Note
then a ~70ms tail" shape quoted from the amped triplet take is one instance, not
the population.

### There is no forward path, confirmed by reading

- `absorbArticulationFragment()` moves the survivor's **start** back onto a
  predecessor stub. Backward.
- `absorbAttackFragments()` walks `closing`/`ended` for candidates ending at or
  before the survivor's start. Backward — and gated on `justNamed`, which
  requires `harmonyLabel !== null`, so on monophonic lead material it is never
  reached at all.
- `carveAfter()`, `splitAtSegments()`, `insertFromSegment()` are additive: they
  create Notes, never retract one.
- `mergeWithinSegment()` is the only mechanism that extends a survivor's **end**
  over a following Note, and it is gated behind `deep.regionMerge`, false.

So an announced Note cannot today swallow a following same-pitch fragment. That
absence is the defect's proximate cause.

### Which path opens the fragment

Over the 294 same-pitch extras, from the tracker's own trace:

```
  opened by    attack 154    pitchChange 133    (no trace) 7
  accepted re-articulation at that start:
    sharpness 195   envelope-rise 38   none 30   new-pitch 23
    ring-out-sharpness 5   chord-decay-excess 3
```

`sharpness` — `rearticulationSharpness`, the prospective fast-lane decision with
the measured 0.73 AUC ceiling — accounts for two thirds. The other half of the
population is opened by a pitch step with no attack behind it at all.

### `regionMerge`, re-opened on 20x the material, and refuted

The existing negative on `deep.regionMerge` was taken on 78 derivation events:
false positives 6 → 10, fragmentation 11/78 → 12/78. Re-run on the full 1,595-
event corpus it is far worse than that comment suggests. **Falsifier stated in
advance: missed labels must not rise above 161, and splits and extras must both
fall.**

| | baseline | `regionMerge` | + absorb only non-attack Notes |
|---|---|---|---|
| split events | 336 | 234 | 328 |
| extra Notes | 403 | 264 | 389 |
| same-pitch contiguous extras | 294 | 165 | 278 |
| **missed labels** | **161** | **383** | **175** |
| eval informational failures | 1 | 4 | 2 |

Enabled, it buys 139 fewer extra Notes for **222 lost played notes**. The ledger
names the mechanism exactly: `opened but never emitted` goes 0 → **184** —
`mergeWithinSegment` sets `merged` on the absorbed Notes and `projectEmissions`
drops them, so 184 notes somebody played are opened by the tracker and never
reach the consumer. All three sixteenths takes lose their pitch-class gate,
which is the 107ms subdivision against 85ms windows: "the region found one event
here" is not a claim those windows can make at that spacing.

The second column is the interesting one. Restricting the merge to absorb only
Notes whose `trigger` is not `"attack"` — a discriminator already recorded, no
new constant, and precisely the retrospective evidence the fragment's own
history offers — cuts the losses from 222 to 14. It does not rescue the
direction: it now trades **14 extra Notes for 14 missed labels, one for one**,
and the per-fixture breakdown shows the two happening in the same places.

```
  fixture                                        split      extras     missed
  same-pitch-eighths-sixteenths-e5-120bpm-di     21 -> 19   21 -> 19   21 -> 24
  same-pitch-eighths-sixteenths-e5-120bpm-amped  29 -> 27   37 -> 34   16 -> 20
  same-pitch-eighths-a3-120bpm-amped             56 -> 55   60 -> 59    9 -> 12
  lead-line-amped-sixteenths-e-fsharp-140bpm      4 -> 3     6 -> 5    13 -> 15
  lead-line-di-sixteenths-e-fsharp-140bpm         —          —          6 -> 8
```

It also introduces an informational gate failure on
`lead-line-amped-sixteenths-e-fsharp-140bpm` (pitch class) that baseline does
not have. Both variants reverted; `src/` is unchanged by this pass.

### The listening kit could not be re-scored, and nothing here rests on it

The brief for this pass asks that the second-annotation figures be re-scored
before being relied on — the 6/6 agreement on extra-note points, the 0.875/0.938
implied ceiling, the control bar at n=2. **They could not be.** The kit writes
everything under `.cache/relabel/` and `build-relabel-kit.ts` says in its header
that those outputs are never committed, so the partially-filled answer sheet
exists on the owner's machine and not in the repository;
`npx tsx scripts/score-relabel.ts` has no input here.

That is recorded rather than worked around because the honest consequence is
worth stating: **none of the conclusions above use those figures.** Every number
in this section comes from the corpus and the tracker's own trace.

**And the two halves of that kit disagree on precisely this axis, which the
brief does not say.** What is committed to this repository is the MACHINE pass,
and "The label ceiling, measured" above reports it hearing an onset at **55 of
106** extra-Note boundaries where the shipped labels have none — closing that
the strict corroborated reading barely moves the figure, that it is not
concentrated on any one signal path, and that "an 'extra Note' at a moment where
an independent annotator hears an articulation is not unambiguously the
detector's error", which "machine-only cannot settle". The human figures the
brief quotes point the other way — 6 of 6 agreeing with the shipped labels, zero
`ann+ lab-` — and they are **n=6 on a control bar of n=2**, recorded in the
brief's prose and nowhere else in this tree. The section above still describes
the human half as "built and waiting"; whoever ran the partial pass did not
commit its results, so there is no answer sheet and no updated table to check
them against.

| | extra-note points | annotator hears, labels lack |
|---|---|---|
| machine pass (committed, scored) | 106 | **55** |
| human pilot (brief prose only) | 6 | **0** |

The direction of that unresolved disagreement matters here, and it runs against
forward absorption rather than for it. The negative above is measured against
LABELS — a miss is a label with no Note — so labels undercounting cannot
manufacture one, and the 161 → 383 and 161 → 175 results stand whichever
annotator is right. But if the machine pass is even partly right, some fraction
of the 294 same-pitch extras are articulations somebody played that the labels
do not carry, and absorbing those costs real notes the miss count never sees.
The uncertainty makes forward absorption look better than it is, not worse.

Do not cite either half as corroboration without re-running it, and do not cite
the human figures at all until they are committed.

### What this establishes

The brief asked whether the **retrospective** question ("that fragment already
happened — with its full duration, its decay, and whether it carried its own
attack witness, was it one?") sits on the better side of the 0.73 AUC ceiling
that eight experiments put on the **prospective** one. On this evidence it does
not. The most conservative retrospective rule available — absorb only where the
fast lane witnessed no fresh energy whatsoever, over a span the region lane
positively called one event — still cannot tell which of two same-pitch Notes
the player did not play. It gives back a real note for every phantom it removes.

That is a stronger statement than "regionMerge does not pay for itself", and it
is worth not re-deriving: the extra evidence a fragment's own history carries is
not the missing ingredient. The signal-path result from DECISION-026 says where
the missing ingredient is instead — split rates go 8% → 71%, 3% → 30% and 7% →
50% between the DI and amped renders of the *same performance*, so whatever
separates a real re-pick from a spurious boundary survives a direct input and
collapses under compression. A witness that survives compression is the open
problem, and it is an onset-feature question, not a segmentation-bookkeeping one.

## The envelope dip: the best witness yet, and still not enough

The previous section closed forward absorption by measuring that the deep
lane's retraction destroys real notes. This one asks the other half of the
question — is there a witness that separates a real re-pick from an invented
boundary at all — and answers it with a number that is both the best this
project has measured and still insufficient, for a reason that is arithmetic
rather than acoustic.

The prompt for it was the owner's, looking at his own waveforms: the notes are
plainly separate to the eye, even on the amp-sim renders and even at sixteenth
spacing, so what is the recognizer failing to see?

### What the recognizer can see at the moment it decides

Every witness available to the re-articulation decision, scored over 1,103
accepted articulations landing within 70ms of a label and 229 landing nowhere
near one:

```
  witness                 AUC    median real   median spurious
  sharpness               0.698          5.13             3.19
  fluxRatio               0.695          2.05             1.39
  heldSharpness           0.583          2.01             1.54
  heldFluxRatio           0.569          1.68             1.41
  troughRatio             0.525          1.33             1.22
  riseRatio               0.506          1.11             1.11
  fellFraction            0.398          0.86             0.94
```

**The best witness available is the one already in use**, `sharpness`, at 0.698
— under this project's standing 0.73 bar. That single table explains every
negative below: any gate built from these is reshuffling a 0.70 discriminator.

The envelope family reads as noise, and that is the informative part rather
than a disappointment. Every reading on that record is taken AT the transient,
by which point the new energy has arrived. None of them can see whether
anything fell beforehand, which is precisely the question the eye answers from
a waveform.

### The dip, measured on the audio rather than on the tracker

A plain RMS envelope of the raw samples, with no engine state involved: at each
boundary, `min(RMS)` over the span just before it against `max(RMS)` over the
span before that.

```
  real re-picks    n=1570   median 0.350
  spurious splits  n=106    median 0.763
  AUC 0.763 corpus-wide, 0.743 on the 120bpm same-pitch material
```

Above the bar, and better than anything the engine computes. **The evidence the
owner was pointing at is real and it is in the audio.**

It is also robust in a way that matters, because three separate things were
expected to break it and none did.

**Window length does not matter.** Holding overlap fixed at 4x and varying only
the RMS window, on the same material:

```
   5ms 0.768    10ms 0.771    20ms 0.797    40ms 0.801    85ms 0.773
```

Flat across a seventeenfold range. This refutes a plausible-sounding diagnosis
that was made here before it was measured: that the deep lane is blind because
it reads its envelope through the 85.3ms window the 4096-point FFT needs for
pitch, and that a finer envelope would fix it. It would not. An 85ms envelope
separates as well as a 5ms one.

**Overlap does not rescue a long window, and does not need to.** The deep lane
runs 4096-sample windows at a 1024-sample hop. Overlap yields more samples of a
smeared curve rather than a less smeared one — the minimum across overlapping
85ms windows spanning a 40ms gap is still dominated by the notes bracketing it.
That reasoning is correct as far as it goes and turns out not to be the binding
constraint, per the table above.

**Anchoring beats windowing offline and loses in the pipeline.** Anchored on the
preceding onset rather than a fixed window, separability rises to 0.797. Built
into the engine it LOST eleven held-out notes, because offline the anchor was a
LABEL and in the engine it can only be a detected attack — and on the amp-sim
takes the kernel fires several transients per pick, so every phantom re-anchored
the span. This is the archived lineage's "a bench ranking is not a pipeline
ranking" in its purest form: the offline figure was reading ground truth.

### Seven configurations, one exchange rate

Baseline: 336 events split, 403 extra Notes, 161 missed labels.

| gate | splits | extras | missed |
|---|---|---|---|
| baseline | 336 | 403 | **161** |
| `regionMerge` on | 234 | 264 | **383** |
| `regionMerge`, non-attack Notes only | 328 | 389 | **175** |
| flux-ratio witness at 1.3 | 263 | 299 | **255** |
| dip, windowed, bar 0.99 | 324 | 386 | **173** |
| dip, windowed, age-gated | 335 | 402 | **164** |
| dip, short windows | 314 | 364 | **195** |
| dip, anchored on accepted articulations | 63 held-out splits | — | 39 held-out misses |

Every one of them trades roughly one real note per phantom removed. The
derivation sweep is flat — 10 split and 10 extras at every value of every
constant tried — so none of these could be honestly derived there either; the
old derivation set holds three instances of the phenomenon.

One configuration came close enough to be worth recording precisely. The
windowed dip at a bar of 0.99 leaves derivation misses at 2 and held-out misses
at 30, both unchanged, while taking held-out splits from 73 to 65 — a clean win
on hand-labelled data. All twelve of its added misses fall on the 120bpm
same-pitch material, whose labels are generated. It was still not shipped,
because five of those twelve are on a DIRECT take with the better labels, and
the ledger attributes them to the new gate by name: `rejected: no-dip` 0 -> 5 on
`same-pitch-eighths-sixteenths-e5-120bpm-di`. Sixteenths at 120bpm are 125ms
apart against a 240ms reach — the window-versus-spacing error, committed inside
the attempted repair. Age-gating the test so it only applies to notes older than
its own span removes the harm and the benefit together: splits 336 -> 335.

### Why 0.78 is not enough, which is arithmetic

At this decision there are roughly five real re-picks for every invented
boundary. A witness at 0.78 AUC still has heavily overlapping distributions —
real p75 0.684 against spurious median 0.763 — so at that prior, a threshold
catching one phantom catches about one real note. Reaching a favourable trade
needs something near 0.95, not a better-placed bar on a 0.78 reading.

**So the per-boundary threshold family is exhausted, and that is the finding.**
Not "this witness is bad": the witness is the best one measured here and it is
above the bar. The shape of the problem is wrong for it. What a listener uses on
this material is not one number at one boundary — it is four evenly spaced
events carrying the same envelope shape, which is a claim about a SEQUENCE. The
two nearest things tried in this repository, joint region segmentation by
dynamic programming and a local-rate gate, were both measured and rejected, and
neither is a full sequence decoder over the envelope. That is where the next
attempt belongs, and it should not begin by re-deriving the seven rows above.

## The re-timed labels, checked from the other render

`fixtures/labels/**` was edited twice on 2026-09-14 on the owner's instruction:
`b5cf94b` applied nine corrections from his own listening pass over fifteen
disputed points, and `7a216fe` re-timed the two gridded DI sections
(`same-pitch-eighths-a3-120bpm-di`, `same-pitch-eighths-sixteenths-e5-120bpm-di`)
automatically with `scripts/retime-gridded-labels.ts` — roughly 330 labels moved
on envelope evidence. `docs/validate-relabelled-material-prompt.md` asked for an
adversarial check of the second pass, assuming it unsound until shown otherwise,
with `src/` untouched and no detector output consulted. **Verdict: the
re-timing holds on three of its four sections by evidence it never saw, is
unverifiable but not worse on the fourth, and is kept.** The nine ear
corrections stand throughout. Nothing under `fixtures/` changed in this pass.

### Why the re-timing's own 6/6 could not count

The script checks itself against six picks the owner confirmed by ear and
reports 6/6 within 30ms. Four of those six are values it is forbidden to move
(`LOCKED`), so it cannot fail them; only `s1662` (25.572s) and `s1698` (30.075s)
test anything, and both were already within 3ms on the grid. Everything below
is built to avoid that property.

### What was reproduced first

- Running the script on the `b5cf94b` labels (from git, never through the
  working tree) reproduces `7a216fe` **byte for byte** on both files. The
  commit is what the script produces; there is no hand edit hiding in it.
- Structural: all eight same-pitch and held-then-picked files strictly ordered,
  no `endMs > next.startMs`, no `endMs <= startMs`; contiguity preserved
  (182/182 and 190/190 `endMs == next.startMs` on the two re-timed files).
  Counts 183/183/191/190/72/72/120/120 as required. All eight locked values
  intact, all five removed ids absent.
- The lock does work: unlocked, the script proposes 19.745s for `s1615` over
  the owner's 19.613s, exactly as the commit message says it once did.
- `npm run eval` PASS, zero required failures, the one pre-existing
  informational failure (`power-chords-b-a-g-fsharp-b-a-g-e-140bpm`);
  `clean-lead-120bpm` gated pitch class 92.9%.
- The neighbour-yield rule dropped exactly one proposal (`s1614` → 19.618s).

### The two renders are 2.5ms apart, not 20–90ms

The brief records two earlier offset measurements that disagreed (envelope
correlation 9/12/25/56ms; onset matching 80/10/90/80ms). Cross-correlating a
plain onset-strength function (half-wave-rectified log-RMS rise, 10ms window,
2.5ms hop, no shared code with `src/engine/**`) between the DI and amped
renders over the whole file, ±400ms:

| take | lag | r at peak | runner-up (>30ms away) |
|---|---|---|---|
| `eighths-sixteenths-e5` | **2.5ms** | 0.545 (0.637 HF-weighted) | 0.257 at 240ms |
| `eighths-a3` | **2.5ms** | 0.243 (0.223) | 0.065 at 258ms |
| `quarters` (control) | 2.5ms (−17.5 HF) | 0.232 (0.294) | 0.118 at −30ms |

Per-section lags agree (2.5/2.5, 2.5/7.5ms). The onset-function peaks of the
two e5 renders coincide to ≤5ms pick by pick, and the owner's own ear gave the
*same* time on both renders for three picks (25.572, 30.075, 31.344s). The
renders are one performance, time-aligned to within one hop. Both earlier
methods were wrong, and the 240–258ms runner-ups are the eighth-note period —
the trap an onset-matching method with a window wider than the spacing falls
into.

### Cross-render: do the re-timed DI labels sit on picks in the amped audio?

For each label set, each label (+2.5ms) is scored against the amped render two
ways: the nearest amped onset-function peak within ±62ms (half a sixteenth,
further bounded at the midpoints to the neighbouring labels), and the
onset-function maximum within ±12.5ms of the label ("OSF@label"), against the
same statistic at uniformly spaced points across the section ("chance"). Three
label sets: the DI grid+ear (`b5cf94b`), the re-timed DI (`7a216fe`), and the
amped file's own untouched labels. Broadband OSF; HF-weighted in parentheses.

| e5 section | label set | within 25ms of an amped peak | \|Δ\| median / p90 | OSF@label | chance |
|---|---|---|---|---|---|
| eighths (64) | DI grid+ear | 57 | 13 / 30 | 0.84 (0.86) | 0.07 (0.11) |
| eighths (64) | **DI re-timed** | 59 | 8 / 26 | 0.67 (0.81) | |
| eighths (64) | amped's own | 61 | 10 / 20 | 0.79 (0.81) | |
| sixteenths (127) | DI grid+ear | 118 | 10 / 25 | 0.18 (0.30) | 0.10 (0.17) |
| sixteenths (127) | **DI re-timed** | **124** | 10 / **21** | **0.49 (0.66)** | |
| sixteenths (126) | amped's own | 111 | 13 / 28 | 0.12 (0.25) | |

With the peak floor raised from 0.05 to 0.2 of the section's 95th percentile
(fewer, stronger peaks): sixteenths within-25ms goes grid 99, re-timed **115**,
amped's own 87. The control — `quarters`' measured labels against its amped
render — scores 67/72 within 25ms and OSF@label 0.20 against chance 0.04, so
this is what "labels on picks" looks like on this instrument. In the e5
sixteenth section the re-timed labels sit on 2.7× the amped onset energy the
grid did (0.49 vs 0.18, chance 0.10); in the eighths section the grid was
already on the picks and the re-timing changes little (both ≈0.8, chance 0.07).
**This is evidence from audio the re-timing never read.**

On `a3` the check has no power: OSF@label is at chance for every label set in
both sections (0.05–0.13 against 0.07), the render correlation is 0.24, and
`verify-fixtures.ts` finds an attack for 2 of the 183 amped labels. The A3
amp-sim render is too compressed for a crude onset function to see picks. What
the same instrument says on the DI audio (semi-circular for the re-timed set,
which came from a different DI envelope statistic): a3 eighths within-25ms
50 → 68 of 72, sixteenths 63 → 94 of 111.

### `verify-fixtures.ts`: the concern count is blind here, the offsets are not

Concern counts barely moved (a3-di 60 → 59, e5-di 47 → 47 on the `b5cf94b`
baseline; the brief's 61/48 are the pre-ear figures) and the re-timing commit
called the verifier "a crude instrument". The dismissal reaches the right
conclusion for the wrong reason. A label earns an onset concern only when *no*
energy rise exists inside a search bounded at the midpoints to its neighbours —
±62.5ms at sixteenth spacing — and no move in this pass exceeds 90ms, so **the
count cannot see a move smaller than the window by construction.** The
verifier's per-label `nearestAttackDeltaMs` can, and it uses a different
window (20ms/10ms hop), a different rule (1.35× rise over a 60ms baseline) and
none of the re-timer's prominence logic. Verifier attack offset, p10..p90,
`b5cf94b` → `7a216fe`:

| section | labels with an attack found | p10..p90 before | p10..p90 after | \|Δ\|≥40ms before → after |
|---|---|---|---|---|
| a3 eighths | 69/72 | −40..+40 | −33..−10 | 22 → 0 |
| a3 sixteenths | 54 → 55 of 111 | −50..+50 | −28..−5 | 32 → 0 |
| e5 eighths | 64/64 | −20..+20 | −18..−8 | 1 → 1 |
| e5 sixteenths | 80/127 | −30..+30 | −18..0 | 10 → 1 |

The spread tightens three- to four-fold on every section and lands on a
constant −13 to −20ms: the re-timed labels sit at the RMS *peak*, the verifier
fires at the *rise*, and that lag is uniform where before it was scattered.
Per-label "closer/farther" counts (e.g. e5 sixteenths 49 closer, 27 farther)
are inflated by that constant and are not the right reading. On `a3-di` the
verifier's unsupported list (span never above the engine's gate) went from
eleven labels to six.

### Inter-onset intervals against a human reference

A grid has zero spread by construction. A human does not. `quarters-di` and
`held-then-picked-di` carry measured one-to-one onsets and are the reference
for how this player's intervals scatter.

| series | n | nominal | SD | MAD | within ±20 / ±40ms |
|---|---|---|---|---|---|
| **human:** `quarters-di` | 71 | 500 | 16.5 | 10 | 85% / 99% |
| **human:** `held-then-picked-di`, quarter-note IOIs | 95 | 500 | 20.1 | 10 | 83% / 94% |
| e5 eighths, grid+ear | 63 | 250 | 0.0 | 0 | 100% |
| e5 eighths, re-timed | 63 | 250 | 21.5 | 12 | 75% / 90% |
| e5 sixteenths, re-timed, both ends moved | 104 | 125 | **22.0** | 13 | 82% / 98% |
| e5 sixteenths, re-timed, ≥1 end still on grid | 22 | 125 | 38.6 | 20 | 55% / 82% |
| a3 eighths, re-timed | 71 | 250 | 21.3 | 14 | 62% / 93% |
| a3 sixteenths, re-timed, both ends moved | 46 | 125 | 35.8 | 16 | 70% / 87% |
| a3 sixteenths, re-timed, ≥1 end still on grid | 64 | 125 | 45.2 | 40 | 23% / 47% |

The re-timed e5 sections and the a3 eighths scatter like the human reference
(SD 21–22ms against 16–20; MAD 12–14 against 10): not tighter than a player,
which would have meant snapping to something periodic, and not wildly looser,
which would have meant losing the beat. The a3 sixteenth section does not: 22
of its 110 intervals are under 85ms and 17 are over 175ms, in 22 adjacent
short/long pairs, and **every one of the 39 involves one of the 33 labels the
re-timing left on the grid.** That is the interleaving the brief warned about,
quantified.

### The ear points, leave-one-out

Unlocking one owner-confirmed label at a time and reading the script's
proposal for it is a genuine accuracy measurement at six points; the 6/6 above
is not.

| label | owner's ear | proposal, unlocked | Δ |
|---|---|---|---|
| a3 `s1627` | 23275 | 23280 | +5 |
| e5 `s1662` | 25572 | 25583 | +10.5 |
| e5 `s1684` | 28339 | 28345 | +6 |
| e5 `s1698` | 30075 | 30075 | 0 |
| e5 `s16108` | 31344 | 31348 | +3.5 |
| e5 `s1615` | 19613 | **19745** | **+132** |

Five of six within 11ms. The sixth is a whole sixteenth off, and the
neighbourhood explains it. Peaks in both renders between 19.0 and 20.1s sit at
19042, 19275, 19370 (weak), 19513, 19617 (weak, prominence 1.2), 19750, 19837
(weak), 19978, 20090 — nine picks, alternating strong and weak, for the nine
labels `s1610`–`s1618`. Counted in order, the pick at 19617 is `s1614`'s and
19750 is `s1615`'s, which is exactly what the unlocked script proposed. The
owner reported a *time* (19.613s, correct — he heard the weak pick the envelope
barely registers); the lock enforces an *id*, `s1615`, that the ear never
asserted. With the lock, the yield rule then freezes `s1614` on its grid
position, 38ms before the real pick at 19613, and the pick at 19750 carries no
label at all. The same 38ms pair exists in `b5cf94b`, where the correction was
applied to `s1615` without revisiting `s1614`; `7a216fe` preserved it rather
than created it. It is the one place the lock made the labels worse than the
unlocked method would have, and it needs the owner to say which sixteenth the
19.613s pick is, not a re-run.

### The A3 sixteenth section, specifically

- The re-timer located 78 of 111 picks. A plain onset function on the DI finds
  84–89 events in the section at a sane floor (74 at a strict one), against 111
  labels: roughly a third of this player's off-beat sixteenths on A3 are too
  quiet for any envelope method, and the labels for those stay on the grid,
  up to ±65ms from where the pick would be by interpolation. The 33 are `s166
  s1611 s1614 s1618 s1623 s1625 s1627 s1630 s1636 s1638 s1641 s1643 s1646
  s1648 s1650 s1652 s1658 s1659 s1663 s1667 s1675 s1677 s1679 s1681 s1683
  s1685 s1687 s1690 s1693 s1696 s1697 s1699 s16107` (the four unmoved eighths
  are `e823 e834 e842 e870`; on e5, `e817 e824 e831 e833 e844 e856 e864` and
  `s164 s169 s1614 s1615 s1669 s1670 s1678 s1684 s1694 s1696 s1698 s16108`).
- Where a pick is missing the alignment's skip choice can be an exact tie. At
  `s1652`–`s1654` (grid 26355/26480/26605; picks 26285, 26420, 26540, then a
  240ms gap to 26780) the two assignments cost 265 each; the script skipped
  `s1652`, the count-consistent reading skips `s1654`. Both label the same
  real picks — only the phantom's position differs — so this is not a cascade,
  but it is a coin toss the method cannot call.
- The section has pick-like events with no label at both ends, in the grid and
  the re-timed set alike: 19.89s (prominence 5.3, between `e872` at 19.760 and
  `s161` at 20.020, 130ms from each) and 33.96s (prominence 6.5, 145ms after the
  last label). With `s1692` removed by ear the section holds 111 labels; the
  audio shows 112–113 pick-like events. Whether the take ends at 33.815s or
  33.960s, and whether the sixteenths begin a pickup early, is the player's to
  say.
- Around the removed `s1692` (31.355s) the DI shows a weak rise at 31.357s
  (0.29 against ≈3.3 for the strong picks) and nothing at all near 31.16s; the
  ear's "no pick" is consistent with the audio. Around e5's removed `s1628`
  (21.325s) the DI shows a weak event at 21.302s of the same strength (0.88) as
  the events at 21.050s and 21.552s that the re-timing *did* label (`s1626`,
  `s1630`). The ear outranks the envelope; the owner may still want to hear
  those three off-beats as a set.

Per label, nothing in this section got worse: 78 labels moved onto DI events
(median |Δ| 43ms, p90 62, none beyond 68) and 33 stayed where they were. As a
*sequence* it is now non-physical, and no instrument available here can verify
it from the other render. It is flagged, not reverted: a wholesale revert would
discard the three verified sections to protect a fourth that a revert would not
improve.

### The amped labels were never the DI timings

`docs/SAME-PITCH-MATERIAL.md` said the amped renders carry the DI timings. For
the two fast takes they do not, and never did: each render's grid was anchored
on its *own* first envelope rise, which fires late on the compressed signal, so
the amped grids sit **195ms (A3) and 225ms (E5) after the DI grids** while the
audio is aligned to 2.5ms. The owner's corrections show it directly: the same
physical pick at 31.344s is `s16108` in `e5-di` and `s16106` in `e5-amped`; the
same phantom at 21.3s is `s1628` in DI and `s1626` in amped. Consequences:

- The brief's fourth declared weakness — that the DI removal at 34.050 should
  carry to `e5-di`, and so on — transfers by id, which is invalid here. There is
  no `e5-di` label at 34.050 to remove (its last is 33.810, and the amped
  `s16128` at 34.050 the owner removed sat *after* the last pick of the
  performance precisely because that grid runs 225ms late).
- In the sixteenth sections the amped files' own labels sit at chance on their
  own audio (OSF@label 0.12 against 0.10; 87 of 126 within 25ms of a strong
  peak against 115 for the re-timed DI labels +2.5ms). The amped eighth labels
  are on picks. The natural repair is to carry the re-timed DI *times*, not
  ids, across at +2.5ms — a label edit, so the owner's call.
- `quarters` really is identical on both renders (0 of 72 differ);
  `held-then-picked`'s amped labels differ from its DI labels by a median 15ms
  (max 26).

### What this leaves for the owner

1. Which sixteenth the 19.613s pick is (`s1614` by count), and with it the
   phantom at 19.575 and the unlabelled pick at 19.750.
2. Whether `a3`'s sixteenths begin at 19.89s and end at 33.96s (111 labels
   against 112–113 events).
3. Whether to carry the re-timed DI times to the amped files at +2.5ms.
4. The three weak off-beats at 21.050 / 21.302 / 21.552s in `e5-di`, two of
   which are labelled and one of which he removed.

**Resolved the same day, by ear.** The owner listened to the four DI sections
named above and gave every pick attack he heard (37 times in all). Applied
verbatim: on `e5-di`, `s1610`–`s1620` and `s1626`–`s1632` take his times,
which puts the 19.614s pick on `s1614` and 19.744s on `s1615` exactly as the
count said, and `s1628` is restored at 21.297s, a pick he now hears 28ms before
the grid position he had judged empty. On `a3-di`, `e869`, `e871`, `e872`,
`s161`–`s167` and `s16108`–`s16112` take his times; both section-end events are
real picks and are now labelled (`s160` at 19.875s, `s16113` at 33.955s, the
latter "slight"); `e870` (grid 19.230s) had no pick under it and is removed;
and two very weak picks at 19.131s and 19.599s are deliberately *not*
labelled — he calls them bad playing and says missing them is fine, and a
label here is by definition an event the recognizer must find. Of the 31 labels
he timed that the re-timing had moved, the re-timing was within 5ms of his ear
on 21, within 15ms on 29, and 25ms out on one (`s16110`). Counts are now 192
(`e5-di`) and 184 (`a3-di`). Items 1, 2 and 4 above are closed; item 3 (the
amped files) is deferred on his instruction, and the remaining DI work is the
A3 sixteenth section's 33 unmoved labels, which the same listening method can
settle in seven time windows.

Every window used here was checked against the material's spacing before being
trusted: the nearest-peak search is bounded at ±62ms and at the midpoints to
the neighbouring labels, the onset function's peak-separation is 20ms, and its
window 10ms — all under the 125ms sixteenth. Numbers in this section come from
scratch scripts kept outside the tree; the repository scripts they were built
on are `verify-fixtures.ts` (run with the `b5cf94b` labels substituted in
memory, the tree untouched) and `retime-gridded-labels.ts` (run against the
`b5cf94b` labels with output redirected away from `fixtures/`).

## A tail fragment is short FOR THE PACE: the first gate that costs nothing

DECISION-028 closed the per-boundary threshold family and named what it thought
came next: "what a listener uses on this material is not one number at one
boundary — it is four evenly spaced events carrying the same envelope shape,
which is a claim about a SEQUENCE." This is that claim, built, measured and
shipped. It is the first change in this line that removes phantom Notes at
**zero cost in played ones**.

### The measurement that reopened it

`measure-restrike-oracle.ts` had already found the discriminator and then hidden
it. Its candidates had to end "by a pitch step", and on the same-pitch material
— where 294 of the corpus's 318 same-pitch contiguous extras live — the next
event is the SAME pitch, so almost none qualified: 218 candidates against a
corpus carrying 407 extra Notes. `measure-rate-relative-merge.ts` widens the set
to every Note opened by an accepted, settled, same-pitch re-articulation, which
is 1,237 decisions, 408 of them spurious.

On that population the discriminator is much stronger than anything previously
measured here:

```
  fragment span / true local interval   AUC 0.905
  fragment span alone (control)         AUC 0.788
  pair span / true local interval       AUC 0.867
  boundary age / true local interval    AUC 0.666
  dipRatio at the boundary              AUC 0.616
```

For scale, the whole of DECISION-028 ran on witnesses topping out at 0.698, and
its best new one, the envelope dip, reached 0.763. The reason the rate matters
is visible in the raw distributions: the spurious fragments sit at a median 1.01
of a local interval when you measure the PAIR they form with their predecessor,
and the real ones at 1.98. One played note split in two, against two played
notes. The corresponding absolute numbers do not separate at all — the median
spurious fragment is 93ms and a real sixteenth at 140bpm is 107ms, which is why
a bar of 80ms costs 77 played notes and one of 100ms costs 173.

### The estimator is the binding constraint, and the failure is one-directional

Replacing the true rate with one the engine could actually hold — the median of
the last eight gaps between Note openings — drops the same test from 0.905 to
0.805, barely above the no-rate control. That gap is the circularity: a phantom
INSERTS an onset, which splits one true interval into two short ones, so the
estimate is corrupted by exactly the errors it exists to correct.

Three repairs were measured and only the last matters.

| repair | result |
|---|---|
| upper percentile of the recent gaps | AUC 0.805 -> 0.829; bias fixed (reads fast on 396 of 1171 rather than 753); end-to-end trade no better |
| autocorrelation of the audio envelope | **failed**: envelope/true spreads 0.31 (p25) to 2.02 (p75), octave errors both ways, AUC 0.622 |
| two-pass — strict merge, re-read the rate from survivors | +2 missed for -32 false positives; no better than one pass |

The audio-side estimator is worth recording as a negative, because it is the
obvious idea: read the pace from the signal, where no segmentation error can
reach it. `docs/SAME-PITCH-MATERIAL.md` already says why it cannot be trusted —
"in the E5 take the strongest envelope periodicity sits at the note period,
while in the A3 take it sits at twice it, on the accent" — and taking the
shortest qualifying lag rather than the strongest did not rescue it.

What does make the estimator safe is an asymmetry rather than an accuracy. A
missed onset merges two intervals and can only make a gap LONGER; a phantom
splits one and can only make it SHORTER. The bar is a FRACTION of the interval,
so a long reading raises it and suppresses real notes while a short reading
merely does less. Only one of the two errors is dangerous.

### The second witness is what makes it free

The rate test alone, at every bar worth having, costs one played note on
`lead-line-di-sixteenths` — hand-labelled held-out data at 107ms spacing, where
a real note and a fragment are genuinely the same length. Adding the envelope
dip as a second, INDEPENDENT condition — one reads time, the other energy —
removes that cost entirely:

```
  DERIVATION (bar chosen here)                     HELD OUT (reported after)
  fragment/rate <= 0.30 AND dip >= 0.85   +0 missed, -27 fp     +0 missed, -3 fp
  fragment/rate <= 0.35 AND dip >= 0.85   +0 missed, -35 fp     +0 missed, -4 fp
  fragment/rate <= 0.40 AND dip >= 0.85   +2 missed, -40 fp     +0 missed, -4 fp
```

0.35 is the last bar that costs nothing on derivation; 0.40 costs two. The dip
bar of 0.85 is deliberately high — at 0.5 the rule fires four times as often and
takes labels with it at every span bar tried.

### Shipped as an announce bar, not a retraction

The fragment's own span is only known once it has ended, so the obvious
implementation is a deep-lane retraction: announce the Note, then withdraw it
with `structuralRevision` / `relation: "absorbed"`. Measured against the far
simpler alternative — never announce it at all, and let `end()` discard it as a
Note that failed its bar, which is machinery that already exists — the two give
**identical** numbers (DERIV +0 missed / -35 fp; HELD-OUT +0 / -4). So the
simple one ships. A suspected fragment is announced only once it has outlasted
`tracking.rateFragmentSpanFraction` of the local interval; latency is paid only
on a boundary that is doubtful in both witnesses at once, and at sixteenth
spacing the computed bar falls below `minStableMs` and the rule is inert.

### The bench lied, twice, and the pipeline caught it

Worth recording in full, because this repository has now hit "a bench ranking is
not a pipeline ranking" five times and two of them are in this entry.

The offline simulation predicted -43 emitted Notes and zero missed labels. The
first engine build gave **-25 extras and a NEW informational failure**, on
`lead-line-amped-sixteenths`'s pitch-class gate. Simulating a merge on a
detection list assumes the rest of the pipeline is unchanged, and it is not:
refusing to announce a Note changes what the tracker has open, what the deep
lane re-segments, and what absorbs what.

Diagnosis by instrument rather than by hypothesis, after two guesses had already
failed. The suppressed Note was `n3` on that take: 147ms long, real, and killed
by a bar of 175ms. 175 is `0.35 x 500`, and 500 was the estimator's FALLBACK —
a whole note at 120bpm, applied at 3.7s into a take playing 107ms sixteenths,
before any gap had been measured. Every percentile of the estimator failed
identically because at the start of a take none of them has a gap to read. **The
fix is to abstain**: the rule's claim is "shorter than a note at the pace
currently being played", and with no pace measured there is no such claim, so
`localIoiMs` returns null and the bar is left alone. Removing that one fallback
took the corpus from 320 splits with a regression to 318 with none.

### End to end

Measured with the labels as of the same day's listening pass, `npm run eval`
PASS with the single pre-existing informational failure
(`power-chords-b-a-g-fsharp-b-a-g-e-140bpm`), 499 tests passing, and
`fixtures/` untouched.

| | before | after |
|---|---|---|
| missed labels | 159 | **159** |
| false positives | 346 | **314** |
| events split | 339 | **318** |
| extra Notes | 407 | **379** |
| detections | 1779 | 1747 |
| `clean-lead` gated pitch class | 92.9% | 92.9% |

Per fixture, where it moved: `held-then-picked-amped` 61 -> 48 split and 78 ->
60 extras, `same-pitch-eighths-sixteenths-e5-amped` 30 -> 26 and 38 -> 34,
`same-pitch-eighths-a3-amped` 56 -> 55, `same-pitch-quarters-amped` 51 -> 50,
`lead-line-amped-quarter-eighth-triplet` 26 -> 25, `lead-line-mic-quarter-eighth-triplet`
14 -> 13. Nothing regressed on any fixture.

The envelope dip from DECISION-028 ships as a WITNESS here while the gate that
decision rejected does not: `AttackEvidence.dipRatio` is now load-bearing, and
the `rearticulationDipRatio` bar that scored one-real-note-per-phantom on its
own is removed rather than left inert.

### The ceiling of this lever, measured on top of the shipped change

Asked afterwards, because the obvious next move is a better tempo estimator and
it is worth knowing what one could buy. The rate was replaced with the oracle —
the median gap between the LABELS around each candidate, which no causal
detector can have — and the same gate re-run over the corpus as it now stands.
Derivation false positives, against the post-change baseline of 232:

| gate | derivation fp | derivation missed |
|---|---|---|
| shipped, estimated rate, span 0.35, dip 0.85 | **-35** | **+0** |
| ORACLE rate, span 0.35, dip 0.85 | -49 | +3 |
| ORACLE rate, span 0.50, dip 0.85 | -72 | +5 |
| ORACLE rate, span 0.70, dip 0.85 | -84 | +37 |
| ORACLE rate, span 0.50, no dip condition | -172 | +24 |
| ORACLE rate, span 0.90, no dip condition | -193 | +365 |

**A perfect clock is worth about twice the reach and it is no longer free.** The
last row bounds the whole lever: even removing every fragment short for the pace
caps out near -193 on derivation, and the cost curve is vertical long before it.
Tempo estimation is therefore not where the remaining phantoms are, and a future
attempt should not start by building a better one.

What the same run says is where they are: on this population fragment span over
the true rate scores **0.926** AUC and the dip that gates it scores **0.636**. A
gate is as wide as its weaker half, and every boundary witness this project has
measured sits at or below 0.70. **The second witness is the binding constraint,
not the clock.**

### Three ways to read the rhythm instead, all measured, none kept

Prompted by the owner, who asked whether the recent-note-duration estimate could
be biased better, and observed that fast notes come in groups so a lone very
short note before a long one is musically implausible. All three were measured
on the same 1,237 candidates, on top of the shipped change.

**The gap shape.** For each candidate, the gap to the Note before it against the
gap to the Note after it. This needs no rate estimate at all, which is why it
was worth trying: the estimator is the binding constraint on everything else
here. The distributions confirm the picture and correct its direction — the
phantom is the TAIL of a played note, not its head, so it sits LATE in the note
it was cut from:

```
  gapAfter / gapBefore    spurious  median 0.36   matched  median 1.00
  AUC 0.779, with no clock anywhere in it
```

Better than the dip (0.636) and close to the causal rate test (0.826). It is
nonetheless **the same quantity already in the table above** under another name:
a tail fragment ends where the next Note begins, so its `gapAfter` IS its span,
and `gapAfter / gapBefore` is `fragment / predecessor span`, measured at exactly
0.779. End to end it is dominated — `<= 0.40` with the dip removes 28 derivation
false positives for **+7 missed labels**, against 35 for zero. OR-ing it onto the
shipped gate is strictly worse than the shipped gate alone.

**The run length.** How many consecutive gaps around this one are the same
length, within 40%. The owner's "more than three of them" stated as a feature.
AUC 0.686, and unusable: spurious runs have a median length of 1 and so do the
first quartile of REAL notes. Chords and slow passages make a real note isolated
by construction, so `runLength < 2` takes 145 played notes off the derivation
set.

**A different percentile of the recent gaps.** p75 and p90 rank better than the
median (0.837 and 0.851 against 0.826), and the bench said p90 with the span bar
re-chosen to 0.20 was worth seven more derivation false positives for free. **In
the pipeline it is worse**: false positives 323 against 314 and extra Notes 386
against 379, because p90 reads about 1.13x the median and 0.20 x 1.13 is
stricter than the shipped 0.35, not looser. Every p90 bar loose enough to beat
the shipped one costs played notes. The median at 0.35 stands.

That is the third time in this one entry that the offline simulation disagreed
with the engine. The rule is now explicit: **on this decision, a bench number is
a hypothesis and only `npm run eval` plus `measure-splits.ts` settle it.**

### Restricting the gate to monophonic Notes: measured, and refused

The owner asked whether the deep lane should recognise obvious polyphony and
keep this gate off chord material, on the reasoning that a strum spreads six
strings over tens of milliseconds so a short span there can be a legitimate
partial rather than a tail. The premise is sound and the corpus backs it: about
107 chord labels against 1,485 single-note ones, so the bar is essentially
underived on strummed material.

The tracker already has the flag. `contextHarmonic` is a smoothed harmonic
estimate, `record.polyphonic` is it thresholded at 0.5, and
`fast/rearticulation.ts` already branches the re-articulation decision on it
into a separate chord path that deliberately never falls through. So the change
was one condition: do not raise the bar on a polyphonic Note.

**It was expected to be a no-op and it is a regression.**

| | shipped | monophonic-only |
|---|---|---|
| missed labels | 159 | 159 |
| false positives | **314** | 319 |
| events split | **318** | 322 |
| extra Notes | **379** | 383 |

It also fails at its own purpose, which is the informative half. Firings on the
chord takes fall 31 to 17, but **discards on the chord takes go 9 to 9 — not one
of the cases the restriction exists to prevent is prevented.** Those nine sit at
moments the tracker does not read as harmonic: a power chord is a dyad, and a
strum that has decayed to one ringing string is monophonic by this estimate.

Every one of the five lost discards is on `held-then-picked-six-strings-120bpm-amped`
(58 firings / 25 discards down to 45 / 20), which is monophonic by construction —
one string plucked at a time. So the flag reads polyphonic on distorted
single-note material, which is the same compression-and-distortion problem that
makes that take the worst in the corpus.

**The measured statement is therefore about the flag, not about the idea:**
`polyphonic` is a room-context estimate, and at this decision it is wrong in both
directions — silent on the chord cases that want it and firing on the distorted
monophonic ones that do not. Reverted; the shipped gate is unchanged at 159 /
314 / 379.

The idea is not dead, only this implementation of it. A per-Note claim would be
the thing to try instead of a room-context one: `harmonyBloomed` on the
PREDECESSOR records that the Note shedding the fragment actually proved itself a
chord, which is a much stronger statement than "the room has been harmonic
lately". That is untested, and it belongs with the separate chord question
below.

### What this does not do

The amp-sim takes still carry most of the defect — `held-then-picked-amped` is
48 of 120 events split after this, against 8 of 120 on the direct render of the
same performance. The rule removes the fragments that are short for the pace and
sit on a boundary with no gap under it; it says nothing about a fragment that is
a full note long, and DECISION-026's headline gap between signal paths is
unchanged in kind. What has changed is that the sequence framing is no longer a
hypothesis: it is measured at 0.905 against 0.698 for everything read at the
boundary, and the first gate built on it costs nothing.

## Rhythm features at the boundary: the learned-model gate, and it fails

DECISION-030 shipped a rate-relative fragment bar and measured its leading
feature at 0.926 AUC against a true clock — far above the 0.698 every witness
read AT the boundary tops out at. The obvious follow-up is a learned model, and
DECISION-021 already spent a conv net on this decision and lost. So before
training anything a second time, the cheap gate: **offer the same rhythm
features to a plain logistic regression on the existing decision table and see
whether they move cross-take generalisation.** A regression is the floor. If the
information does not show up there, no network over the same inputs will find
it.

The falsifier was stated before running: leave-one-take-out AUC must clear
0.702 (the best single witness in-sample) by more than the spread across folds,
AND at a threshold costing zero labels it must remove materially more than the
0 of 635 false positives that everything currently removes.

**Both clauses fail.** The result is negative and nothing is wired.

### The runs

Derivation, 1,627 rows / 992 positives / 13 takes, L2 logistic regression at
lambda 0.01. Group **P** is PROSPECTIVE — available at the instant the decision
is made: the local note rate, `soundedMs` over that rate, the last gap over that
rate, and the coefficient of variation of the last eight gaps. Group **R** is
RETROSPECTIVE — time from the decision to the next Note boundary, raw and over
the rate, defined for accepted and rejected rows alike.

| configuration | cols | in-sample | 5-fold | **LOTO** | FP at zero label cost |
|---|---|---|---|---|---|
| twelve witnesses (control) | 12 | 0.717 | 0.711 | **0.593** | 635 / 635 |
| twelve + P | 17 | 0.741 | 0.733 | **0.603** | 633 / 635 |
| twelve + R | 15 | 0.721 | 0.712 | **0.592** | 635 / 635 |
| twelve + P + R | 19 | 0.742 | 0.733 | **0.603** | 633 / 635 |
| P alone | 5 | 0.626 | 0.622 | **0.539** | 634 / 635 |
| R alone | 3 | 0.583 | 0.584 | **0.431** | 634 / 635 |

Clearing the bar would need 0.828. The best configuration reaches 0.603, which
misses by 0.099 before any margin is asked of it. Two false positives of 635
become removable, 0.3%. A lambda sweep changes nothing (LOTO 0.603 / 0.602 /
0.574 / 0.399 at 0.01 / 0.1 / 1 / 10).

What DID move is in-sample 0.717 -> 0.742 and pooled 5-fold 0.711 -> 0.733, and
pooled held-out 0.723 -> 0.749. All three pool across takes, which is precisely
the within-take scale memorisation this table exists to expose. None of it
reaches LOTO. Every configuration still accepts all 254 held-out negatives at
the zero-label operating point.

### The retrospective group is the WEAKER one, which was not the expectation

The brief said in advance that "P fails but R passes" would be a positive
result, because it would mean the evidence does not exist when the fast lane
must decide and a retraction-based design is required. That did not happen. R
moves LOTO by −0.001 and scores 0.431 alone, worse than chance out-of-take. The
fitted model gives `nextBoundaryOverIoi` a weight of −0.01, i.e. it discards it.
**There is no case here for announcing and retracting.**

The one way R could have been fake was checked and ruled out: a split's own
`opened` lands at the burst, at or before the deciding hop, so a naive
definition would read ~0 on every accept and merely re-encode `accepted`.
Excluded by trace order and timestamp, accepted rows read a median 147ms and
rejected 267ms, so the feature is defined and non-degenerate on both halves.

### Per feature, and what carries the little there is

| feature | group | oriented AUC | rows present |
|---|---|---|---|
| `soundedOverIoi` | P | **0.708** | 1496 |
| `gapCv8` | P | 0.601 | 1399 |
| `localIoiMs` | P | 0.578 | 1496 |
| `nextBoundaryMs` | R | 0.573 | 1627 |
| `nextBoundaryOverIoi` | R | 0.533 | 1496 |
| `gapBeforeOverIoi` | P | 0.525 | 1496 |

`soundedOverIoi` is the only new feature to beat any existing witness.
Pace-normalising `soundedMs` takes it 0.646 -> 0.708, a real +0.062 — the
DECISION-030 framing working exactly as advertised — but it correlates 0.794
with raw `soundedMs` and still only ties `fluxRatio` at 0.702. In the exhaustive
sweep over all 171 pairs the best is now `fluxRatio` + `localIoiMs` at 0.687
LOTO, ahead of the previous best pair at 0.679, and still under `fluxRatio`
alone in sample.

### Where the rate abstains is where it was most needed

`localIoiMs` is missing on 131 of 1,627 derivation rows (8.0%) and 79 of 564
held out (14.0%), and the missingness is wildly take-dependent:

```
  cowboy-chords-c-d-em-g-c-d-em-am-120bpm   20 of 28 rows (71%)
  the three 140bpm cowboy takes             59-64%
  power-chords-c-a-g-e-c-d-fsharp-e-120bpm  62%
  the eight same-pitch takes                0.4-1.3%
```

On sparse chord material the openings are far enough apart that the 1,500ms
reset keeps firing and no rate exists. That is the correct behaviour — no pace
measured, no claim made, which is the fix DECISION-030 had to make — but it
means **Group P abstains on exactly the material where the existing witnesses
are weakest.** Adding P also *hurts* `held-then-picked-amped`, 0.479 -> 0.463,
the largest negative-heavy take in the set. Four of twelve folds sit below 0.52
in every configuration.

### The real finding: two benches in this repository measure different things

This is the part worth carrying forward, and it was not what the experiment was
looking for.

`measure-rate-relative-merge.ts` scores the rate feature at 0.826. On this
table the same idea reads 0.533. The estimate is not the reason. Scored on the
rate study's OWN sub-population — accepted, settled, same-pitch, 1,038
derivation rows, where `nextBoundaryMs` IS the child Note's span — the same
feature on the same rows gives:

```
  against the rate study's target    0.805   (span alone 0.796)
  against this table's target        0.526
```

The first reproduces the rate study's 0.81 / 0.79 almost exactly, so the feature
and the estimator are fine. **The two targets are different questions, and they
disagree on 278 of 1,038 rows — 26.8%.**

- This table asks a BOUNDARY-shaped question: does an uncovered label begin
  within 70ms of this decision, so should the split have been made?
- The rate study asks an OUTCOME-shaped question: did the matcher pair the Note
  this split created with a label, so is this emitted Note surplus?

162 rows have a boundary that was right while the child went unpaired; 116 have
a boundary that was wrong while the child got the label. Both files describe
themselves as being about the same-pitch re-articulation decision.

**Which one is correct depends on what is being decided, and the shipped gate
operates on the outcome-shaped one.** A consumer scoring one target per pick
pays for surplus Notes, not for boundaries. So:

- For a question about surplus Notes, the outcome-shaped target is the right
  one and this decision table is the wrong instrument.
- For a question about segmentation, the boundary-shaped target is right.
- **DECISION-021's rejection of the learned onset head was measured against the
  boundary-shaped target**, on 161 rows with 59 positives. That verdict stands
  for the question it asked. It is not evidence about a model trained and judged
  on surplus Notes, which is a different experiment that has never been run.

That is the fifth instance of "a bench ranking is not a pipeline ranking" in
this document, and the sharpest: not a bench disagreeing with the engine, but
two benches disagreeing with each other about the ground truth for a quarter of
their shared rows.

## Lessons carried over from the retired lineage

DECISION-023 closed the pre-rewrite `src/core/` lineage on its held-out numbers.
Its *methodology* notes are a different matter: they were paid for in hours, and
three of the four failures below are live risks in this tree, which has its own
benches, its own offline decoder and its own one-to-one matcher. They are lifted
out of `docs/archive/detection-rearchitecture-handoff.md` (§7–§9) because that
directory is explicitly not read as guidance.

**A bench ranking is not a pipeline ranking, and the gap can invert the order.**
SWIPE-prime was the best single estimator on that lineage's bench — 36/43
against YIN's 35, a miss set that was a strict subset of YIN's, and honestly
calibrated confidence where YIN reported 0.84 for 68.9% correct. End to end
through the real tracker it scored **29/43 against YIN's 34**. The bench sampled
note interiors; the pipeline runs every frame including silence, attacks and
decay, and YIN's path carried a short 384-sample window the bench never
exercised. That project recorded being burned by this exact move twice. Any
measurement here that isolates a kernel from the tracker — `measure-decision-
separability.ts`, `measure-click-separability.ts`, the falsifier scorers under
`training/` — carries the same hazard: an AUC on extracted rows is evidence
about a witness, never about the recognizer.

**A trailing analysis window makes a bench answer for the previous note.**
Asking an estimator for the pitch at time T shows it audio *ending* at T, so
sampling from a note's start answers mostly from its predecessor. That scored
YIN at 1 of 12 sixteenths and very nearly produced a rewrite of a label file.
This is the window-versus-spacing error class from §3 of `AGENTS.md` wearing a
different hat, and it is the reason the standing rule is to check a window
against the 107ms sixteenth *before* trusting anything built on it.

**Visiting labelled spans in label order can run the clock backwards.** Measured
note spans overlap, so walking them in label order moved time backwards by up to
160ms at boundaries. Stateless estimators cannot detect this; the stateful one
had its history drawn from the future on four of the eight notes it existed to
fix. Anything that replays regions out of a ring by label order — the deep
lane's re-segmentation work included — needs its ordering asserted, not assumed.

**Over-segmentation flatters a one-to-one matcher.** An offline decoder emitting
139 events against 43 labels scored 88%, because a one-to-one matcher finds
correct-looking events in a haystack. Through the real tracker it was 29 against
YIN's 31. This is the same asymmetry the standing two-axis bar exists to catch:
`measure-splits.ts` alongside the ledger, never a recall number alone.

Two further results from that lineage are worth not re-deriving: naive
max-confidence fusion scored *below* its best single member, because an
overconfident witness wins ties it should lose — the same failure mode the
hypothesis trail in `tracker/hypotheses.ts` is built to avoid — and an ERB
frequency warp in SWIPE lost to a linear axis at every step size, because an ERB
axis spends four fifths of its points below 1kHz while the partials separating a
guitar note from its octave are the high ones. The full list, including the
Viterbi-over-NNLS variants and the NNLS octave arbiter, is in §8 of the archived
handoff.

## The direct input, measured to its ceiling

The four DI takes — 127 held-out events on one guitar, one performer and one
interface — were asked the prior question every miss and every extra reduces
to: is the information in the signal, and which function sees it. Four
scripts, every number read on the held-out takes with the constants chosen on
the take measured, which makes each one a CEILING and not a result; the plan
built on them is `docs/DI-ACCURACY-ROADMAP.md`. Engine at `f3bf223`, bit
identical before and after: nothing here changed a detection.

Where the DI stands under the shipping engine: 6 missed (all six on the
sixteenths, all six "no transient within the window"), 25 extra Notes (21 on
the triplet take, 4 on the cowboy take), 117 of 127 named exactly, onsets
inside every gate.

### Onsets: at a 2.67ms hop, log-compressed flux sees 126 of 127

`scripts/measure-di-onset-ceiling.ts`, seven causal functions at a
128-sample hop, each swept over its whole range and scored under
NEAREST-label attribution inside ±30ms (narrower than the 63ms rushed pair
`s19`/`s20`; the ±60ms reading that once produced "48/48" on this material
is the window-wider-than-the-spacing error and is not repeated):

| function, best point per take, summed over the four DI takes | covered | off-label | at 0 off-label |
|---|---|---|---|
| linear flux over frame magnitude (the kernel's shape) | 126/127 | 88 | 50/127 |
| band-limited flux 1.5–6kHz | 126/127 | 72 | 11/127 |
| log-compressed flux | 126/127 | 23 | 90/127 |
| SuperFlux (±1-bin max-filtered reference) | 126/127 | 17 | 90/127 |
| SuperFlux minus its trailing 100ms median | 126/127 | 15 | 107/127 |
| 1.5kHz-highpassed 1ms envelope rise | 114/127 | 179 | 23/127 |
| order-16 LPC prediction residual | 125/127 | 189 | 69/127 |

The sixteenths read 47/48 for every flux variant against the kernel's 42;
the one uncovered is `s14`, the label the labeller placed by subdivision.
Listed candidate by candidate, the eleven off-label firings on the
sixteenths at that point are nine candidates 32–51ms before a downstroke,
each followed within 65ms by a candidate 13–30× stronger, one candidate
43ms before the interpolated `s14`, and the terminal mute; on the triplet
take the three are 52–65ms before an eighth note with the envelope
collapsing behind them. **They are the pick landing on the
string before the stroke.** With the veto "a candidate followed within 65ms
by one ≥4× stronger is a preparation" the triplet take reads 55/55 with zero
off-label, the power chords 16/16 with zero, the sixteenths 47/48 with two
(the terminal mute; a candidate 43ms before the interpolated `s14`), the
cowboy chords 8/8 with one strum-internal transient 68ms after the strum.
126/127, six off-label, all six accounted for.

**Refuted in the same pass.** A single fixed threshold across the four takes:
with the preparation veto the best points sit at 0.145 (sixteenths), 1.86
(triplet), 0.49 (power chords) and 3.0 (cowboy chords) on the
median-subtracted SuperFlux, and at a single 0.25 the sixteenths and power
chords hold (47/48 with 2 off-label, 16/16 with 1) while the triplet take
fires 27 times and the cowboy take 65 times off-label, 27 and 48 of those
with the envelope falling behind them. So the fine function is a proposal
stage and whether energy followed remains the tracker's question. A mute
veto keyed on the 20ms envelope 35ms later falling under half its value 5ms
before takes the triplet take to 55/55 with zero off-label at 0.25, leaves
the cowboy take's 65 where they were, and removes `s6` and `s40`, two real
strokes that are picked and damped inside 40ms; refined to require no rise
at all in the 5ms envelope within 16ms it still removes them, because their
rebound comes 25–35ms after the label. Not the right form.

### Pitch: given the boundary, the engine names the note by +15ms

`scripts/measure-di-pitch-ceiling.ts`, the engine's own dual-window
estimator with a fresh median, on windows ending a fixed distance after the
LABELLED onset. Pitch class correct on the triplet take (55): 64% at +10ms,
96% at +15, 98% at +20, 100% at +30 and +45; on the sixteenths (48): 60%,
100%, 96%, 96%, 100%. Exact reads the same. No label unnamed by +90ms on
either take. The pitch 15ms before the pick reads nothing at all on 46 of
the 55 triplet labels — the string is damped by the pick's contact — and the
previous stroke's pitch on 21 of the 48 sixteenths. **On a direct input
every wrong name is a boundary, not an estimate.** (`clean-lead-120bpm`
reads 7% at +30ms and 56% at +90ms under the same probe, and 28 of its 43
labels read the *previous* note 15ms before their onset: that take's labels
sit well ahead of the pick, which is a property of its first-pass timing and
not of the estimator.)

### The extras, one by one

`scripts/measure-di-extras-census.ts`, from the tracker's own trace and the
matcher's own verdict. DI triplet, 21: eight step-opened Notes ended by the
pick 72–196ms later at the pitch the pick then plays (the next note fretted
before it is picked); five step-opened at a pitch neither neighbour has,
four of them stubs of 53–67ms (D#5, F5, G5, F4 at confidence 0.7–0.8) and
one of 107ms, all ending on the pick; seven attack-opened by a transient
40–130ms before the pick — the
preparation click the fine-hop function no longer fires on under the veto;
one tail fragment. Cowboy DI, 4: three first-string fragments of 133–160ms
kept out of `absorbAttackFragments` by `restruck && announced`, and one
373ms pre-strum transition. Matched Notes are step-opened as often as
attack-opened on the triplet take (27 to 28), so the trigger alone is not
the discriminator; the pairing — a step-opened Note ENDED by an accepted
attack within a quarter second at the pitch it plays — is.

### Chords: one octave error, twice

`scripts/measure-di-chord-evidence.ts`. `c2` reads Em at +120/+200/+300ms
(0.99–1.00) and Em7 at +500 and +1200ms, where D5 (salience 3.7–4.8) is the
third partial of a G3 (1.1–1.4) that lost the cancellation to G4 (3.3).
`p14` reads Gsus2 at +40 and +120ms, where A4 (2.1–2.2) is the third partial
of a D3 (1.45) that lost to D4 (4.8–5.1), and G5 from +200ms. Both are f
chosen over f/2, leaving 3×(f/2) unclaimed; the bass-only sub-harmonic check
in `kernels/missing-fundamental.ts` is the repair, applied to every
candidate. `c1` reads D at +40/+120ms and never blooms: the open D voicing
D3 A3 D4 F#4 is the harmonic series of D2, YIN reads 73Hz at 0.96, and
`maxMonophonicConfidence` vetoes a chord whose period no string is sounding.

### Observed, and refuted as a detector: the dip before the pick

The 5ms envelope around the strokes the kernel loses: `s6` falls 17dB by
+10ms and rebounds to a −20dB stroke at +40ms; `s40` falls 26dB by +30ms and
rebounds at +60ms; `s20`, the same-level re-pick 63ms after `s19`, falls
13dB by +25ms and is back at its previous level by +30ms; the terminal hand
mute falls 28dB and never rebounds. On this take the pick damps the string
before it plays it, which is a witness of a different physical basis from
every energy-increase witness in the same-pitch decision. Built as a
detection function (`dip-rebound dB`, level-gated at the amplitude gate) it
reads 97/127 covered at 90 off-label — sustain and room tone dip 6dB
constantly — so it is not a detector. It is recorded as a candidate witness
for the decision table, with the bar every candidate there has had to clear
(0.73 AUC on the derivation rows) and no reading yet.

### Where this left the direct input, and what was then built

Six of the seven shapes above had a named mechanism and a measured repair;
the seventh (`s14`) is the labeller's own exception. None of them had
derivation material — the five 120bpm takes hold no quiet alternate-picked
upstrokes, no re-picked legato and no direct-input chord change — so the
constants below are held-out readings, each stated as such where it is
declared, and the derivation set's job was to stay exactly where it was.
It did: `clean-lead` 42/43 at 1 extra, `chords-a-bm` 16/16 at 0, the five
takes together 84 Notes, 2 missed, 8 extra before and after every change in
this section. The two stages that shipped are the single-note ones; the
chord stage shipped one exception and refuted its other half.

## The direct input, repaired to its measured shapes

Where the four DI takes stand after `DECISION-033`'s first two stages
(`npm run eval`, twelve 140bpm takes held out):

| take | labels | Notes | missed | extra | named exactly | pitch class |
|---|---|---|---|---|---|---|
| `cowboy-chords-di` | 8 | 12 (was 12) | 0 | 4 (was 4) | 6/8 | 8/8 |
| `power-chords-di` | 16 | 16 | 0 | 0 | 15/16 | 16/16 |
| `lead-line-di` triplet | 55 | 64 (was 76) | 0 | 9 (was 21) | 54/55 | 54/55 |
| `lead-line-di` sixteenths | 48 | 46 (was 42) | 2 (was 6) | 0 | 46/48 (was 42) | 46/48 |
| **total** | **127** | **138 (was 146)** | **2 (was 6)** | **13 (was 25)** | **121/127 (was 117)** | **124/127 (was 120)** |

Across all twelve held-out takes: 429 Notes for 459 labels (was 435), 24
missed (was 30), 72 extra (was 84). Beyond the DI, the amped sixteenths
find one more stroke (38 → 39 of 48), the mic sixteenths one more (39 → 40,
carrying the wrong name), and the mic triplet, the three chord takes and
the three power takes read what they read before. `power-chords-120` names
8/8 (was 7/8) from the chord exception below. Nothing else moves.

The downstream ledger (`measure-downstream-ledger.ts --all`) reads 26
missed labels (was 32), and `measure-splits.ts` 88 of 459 events split
into 96 extra Notes (was 99 into 107): the DI triplet 23 → 11 split, the
cowboy-amped take 4 → 3, the amped sixteenths 4 → 5 and the DI sixteenths
0 → 1 (a fine re-articulation each, inside a label the matcher still pairs
once), no derivation take moved. The sixteenths' remaining misses on the
ledger are the same causes as before — too young to be ended, band-only
transient, never announced — on the amped and mic takes the fine witness
does not reach.

### Stage 1: the fine-hop witness, corroborated by the dip it was refuted as

`src/engine/kernels/fine-onset.ts` is §2.1's function as a kernel: a
1024-point window read every 128-sample render quantum, `log(1 + 200·|X|)`
on magnitudes scaled to the window (the factor of 200 rather than 20 is
what makes the reading the same on a −40dBFS direct input and a room mic),
the reference per bin the maximum over the frames 8–24ms back, max-filtered
over ±1 bin, rectified and summed, minus a trailing 100ms median; local
maxima over ±13ms above a threshold, 40ms dead time, and the 65ms
preparation veto (a candidate at least 4× stronger inside the following
65ms is the pick this one was the contact for). `FastLane` runs it between
hops and hands what it confirms to the tracker on the next frame
(`FastFrame.fineOnsets`), where it may open a Note over silence or
re-articulate the one sounding.

**The threshold, swept on the eval with the witness acting alone**
(`TUNINATOR_FINE_ONSET=θ npm run eval`). At θ=1 the derivation set fails:
`clean-lead` 1 → 4 extras, `chords-a-bm` 0 → 1, `cowboy-120` 4 → 7. At 1.5
`clean-lead` sits at 3 and `cowboy-120` at 7. At 2.5 and 4 `clean-lead`
sits at 2 (one contact 40–42ms before an acted pick), the amped triplet at
27 → 32, the DI triplet at 21 → 23 — the two new extras are pick contacts 86
and 128ms before quarter-note picks, past the veto's reach and not
separable from a quiet stroke by flux or envelope alone. At every θ from 1
to 4 the DI sixteenths read 46 of 48 with 0 extras, the mic sixteenths 40,
the amped sixteenths 41 at θ ≤ 1.5 and 39 above. The witness alone cannot
be neutral on the derivation set at any threshold that helps.

**Corroboration is what makes it neutral.** §2.5's dip — refuted as a
detector at 97/127 covered for 90 off-label — is exactly the reading that
separates a stroke from the flux the witness fires on otherwise. The fast
lane reads the 5ms envelope around each confirmed onset: `dipDb`, the
minimum over [−20, +15ms] against the maximum over [−45, −20ms];
`reboundDb`, the maximum over [+5, +40ms] against that minimum. To
re-articulate a sounding Note a fine onset needs a dip of at least 6dB and
a rebound of at least 6dB; to open a Note over silence it needs the
rebound. With that, and a 55ms dedupe against the broadband kernel's own
acted attacks (40ms left the `clean-lead` contact through), θ=2.5 reads:
derivation 84 / 2 / 8, identical; amped triplet back at 27, DI triplet back
at 21, DI sixteenths 46 (0 extras), mic sixteenths 40, amped sixteenths 39.
The constants (`transient.fineOnset*`) are held-out readings and say so.

**One clock.** A Note the fine witness opens is under the amplitude gate
for the hops the dip covers, and the tracker's sounded clock reads zero
until a frame is audible — `s7` was found, opened, and ended 40ms later as
"too young". A fine-opened or fine-succeeded Note starts its sounded clock
at the frame that opened it. Of the sixteenths' remaining two: `s14` is the
labeller's exception; `s6`, the stroke that falls 17dB by +10ms, is
confirmed by the witness and its Note is never announced.

### Stage 2: the fretting hand's preparation belongs to the pick

The rule, in `note-tracker.ts` (`claimPrefix`, `offerPrefix`,
`tryClaimPrefix`): the Note just before a picked Note is that Note's
preparation — absorbed into it by a `structuralRevision`, boundary at the
pick — when the fretting hand opened it (a pitch step, or a transient the
fine witness read as a *contact*), no stroke lies within 80ms before or
30ms after its start, it ended within a quarter second on the pick, and
either it carries the picked Note's pitch class or it is contact-led and
carries a pitch neither the picked Note nor the note before it has. Five
things were learned building it, each from a measurement that said the
draft was wrong.

**Most prefixes are the region lane's.** The census's eight step-opened
prefixes on the DI triplet are, six of them, Notes the region lane carves
out of the ringing note's tail (`splitAtSegments`) after the pick's Note has
already been announced — the fast lane read the hammer-on as the old note
continuing. A rule that runs only when the picked Note is announced finds
nothing there. So it runs from both ends: at the picked Note's
announcement, and when the region lane carves a step (`beginFromSegment`),
which then looks forward for the pick that ended it. Two of the six arrive
on the region's `energyRise` boundary rather than `pitchChange` — a
hammer-on injects energy — so only a boundary the region put on a
fast-lane *attack* is refused. A `rose` flag on segments, tried as the
discriminator, refused those two and let through the one region-created
Note on the mic sixteenths that is a picked note the fast lane missed
(`s8`): reverted.

**What a contact is.** The direct input's contacts — the pick landing, the
finger arriving — read a dip of 12–24dB and a rebound of 1–5dB
(`F6973` −23/3, `F6069` −22/3, `F15104` −24/3, `F24755` −13/5, `F25595`
−12/1). The mic sixteenths' quiet upstrokes read a dip of 3–6dB and a
rebound of 2–6dB (`F7827` −3/2, `F9488` −3/2, `F6360` −6/6). A contact
test of "dip past 6dB, or rebound under 3dB" ate five of those upstrokes
(`s8`, `s16`, `s17`, `s31`, `s46`, each absorbed as the prefix of the
same-pitch stroke after it — the sixteenths repeat a pitch four times a
beat). A contact is a dip of at least 10dB with a rebound under 6dB
(`CONTACT_DIP_DB`); the mic sixteenths lose nothing to it, and it masks
any onset within 15ms of it — the broadband kernel fires on the same
contact 40–130ms before the pick, which is the census's seven
attack-opened extras.

**The look-back.** A pick the re-articulation detector refuses opens
nothing, and the pitch detector opens the Note when the new pitch has
settled: 40–48ms after the stroke on `clean-lead` (`s8`, a real 200ms note
the draft rule absorbed into the pick after it), 62ms after a stroke the
fast lane missed on the mic sixteenths (`s8` there too, the region's
boundary). The closest DI prefix follows the pick before it by 93ms
(`t10`→`t11`). 80ms, with those three readings on either side of it.

**A step alone is not a stub.** The draft absorbed any step-opened Note
shorter than one articulation at a pitch neither neighbour has. On the mic
triplet `t20` is read as one pitch for 93ms and as B4 for 53ms before the
next pick; the rule took the B4 half — the correct half — as a transition
out of the misread one. A stub needs the hand seen landing: a contact at
its start (four on the DI triplet: D#5 120ms, G5 67ms, F5 107ms, F4 67ms)
or within 30ms before the step (two: F5 stubs led by contacts 21 and 18ms
earlier). Two DI stubs with no contact stay (`n17` G5 53ms, `n20` B4
107ms), and `t20` stays a match.

**The strum-spread exemption is refuted.** Dropping
`absorbAttackFragments`' `restruck && announced` refusal for Notes under
200ms took `cowboy-120` 4 → 2, `cowboy-di` 4 → 2 and `cowboy-mic` 5 → 4
extras — and absorbed the `spicy-chords` Cmaj9 into the E5 after it (the
chord lost, one confidently-wrong name) and a mic power-chord stroke into
its neighbour. The refusal stays; the three DI strum fragments stay with
it. Peak-level ratios were tried as a further discriminator and measure
nothing: a region-created Note inherits its parent's peak.

**What is left on the DI triplet**, the nine, by the tracker's own trace:
four attack-opened by a transient the fine witness read as a stroke (an
A#4 the pitch settles out of in 40ms; A4 and C5 Notes of 133ms picked
between labels; the take's final A4 re-pick); three step-opened with a
stroke at their start (`n39` G5 behind a 21dB dip that rebounds 6dB, at
the bar; `n62` B4; `n95` E5 66ms after the pick before it, its flux at
−5/1dB, which is not a contact); the two stubs above. Every one has a transient the
witnesses call a stroke or nothing at all; none is separable by what the
tracker can currently read.

### Stage 3: one chord exception shipped, the octave rule refuted

`isVirtualPitch`: a Note whose deep-lane activations sit at least 11
semitones under the fast lane's voted pitch may bloom into a chord despite
monophonic-looking confidence — the open D voicing's period is D2's, and no
string plays D2. `power-chords-120` reads 8/8 (was 7/8); nothing else moves.
The octave-consistent cancellation of §2.4 was built in `kernels/chroma.ts`
twice: the loose form named both DI chords and cost `spicy-chords` an
extra, read the mic triplet's `e18` A4 as Dsus2 and moved the cowboy-amped
onset median from 92 to 145ms; the tightened form still lost `e18` and
left `c2` at Em7. Both reverted. `c1` and `c2` stand where §2.4 left them.

## The DI repair, scored on the eight 120bpm takes it was never measured against

The fine-hop witness, the pre-pick prefix and the virtual-pitch bloom were
built and read against the twelve held-out takes and the five derivation
takes, under the rule that the derivation set must not move. The eight
120bpm same-pitch takes (1,131 labelled events) existed on another branch at
the time and were not in that reading. Bringing the two together makes them
scoreable, and the first thing worth recording is what the repair does to
material it was not measured on.

Four trees, one fixture set. `main`, each source branch and the merge were
measured with the eight takes present in all four — the two branch trees as
detached worktrees with `fixtures/` checked out from the merge, so every
tree saw byte-identical audio and labels.

Two results are structural rather than numeric. **The same-pitch branch and
`main` are byte-identical** on `measure-downstream-ledger.ts --all` and
`measure-splits.ts`, every fixture, both axes: that branch tried two engine
gates (a second flux witness on the monophonic re-pick fallback, then a
backward-looking envelope dip) and reverted both, so its net `src/` diff
against `main` is empty. **The merge is byte-identical to the DI branch** on
the same two instruments. So the merge has one engine parent, not two, and
no interaction between the two lines of work exists to find.

| | derivation (78) | held out (381) | the eight (1,131) |
|---|---|---|---|
| `main` / same-pitch | 2 missed, 8 extra | 30 missed, 84 extra | 126 missed, 255 extra |
| merge / DI | 2 missed, 8 extra | 24 missed, 72 extra | 111 missed, 265 extra |

The derivation set does not move **on the segmentation axes**, as it did not
on the DI branch: 84 Notes, 2 missed, 8 extra, bit-identical across all four
trees. It does move on naming, which the DI branch's own "held to
bit-identical numbers" wording does not cover and its Stage 3 note does:
`power-chords-c-a-g-e-c-d-fsharp-e-120bpm` goes 7 of 8 exact to 8 of 8, the
virtual-pitch bloom naming the open D voicing. One derivation event, in the
improving direction, and the only derivation cell that differs between
`main` and the merge on any axis the eval reports.

**On the eight takes the repair is not the one-sided win it is on the mic and
amp takes.** It finds 15 more of the 1,131 events and pays 10 more extra
Notes, and the per-fixture readings do not all point the same way: five of
the eight sit below the per-fixture best of the two parent engines, all five
on the extras axis.

| fixture | `main` | merge |
|---|---|---|
| `same-pitch-eighths-sixteenths-e5-120bpm-di` | 21 missed, 18 extra | **8 missed**, 19 extra |
| `same-pitch-quarters-a3-e5-120bpm-di` | 2 missed, 1 extra | 1 missed, **5 extra** |
| `same-pitch-eighths-a3-120bpm-di` | 63 missed, 3 extra | 63 missed, **6 extra** |
| `same-pitch-eighths-sixteenths-e5-120bpm-amped` | 14 missed, 30 extra | 13 missed, **32 extra** |
| `same-pitch-quarters-a3-e5-120bpm-amped` | 2 missed, 82 extra | 2 missed, **83 extra** |

A per-fixture best of two engines is not a thing any single engine can be,
so this is not a defect of the merge — it is the DI repair's own cost,
charged on material the DI branch did not hold. The cause is one mechanism.
Running the merge with `transient.fineOnsetThreshold = 0` (the witness off,
by config override, no source change) returns every one of the five to its
`main` reading on the extras axis, and the tracker's own trace says the same
thing from the other side: the causes that shrink between `main` and the
merge are `no transient within the window` (42 → 39 on the A3 eighths DI,
11 → 1 on the E5 DI), `transient below the amplitude gate` and
`rejected: gated` — the fine witness supplying boundaries the 13.3ms
broadband kernel never proposed. Where the fragment it opens does not reach
`announceThresholdMs` it lands as `never announced` (4 → 7); where it does,
it is an extra Note.

The prefix and bloom rules on their own (the same override) are the opposite
trade: on the eight takes, 130 missed and 247 extra against `main`'s 126 and
255. They lose four events and remove eight extras. The two mechanisms are
not separable by sign — the fine witness buys events with extras and the
prefix rules buy extras with events — and on the DI triplet they are not
even independent: with the witness off, `lead-line-di-quarter-eighth-triplet`
goes from 0 missed to 1, a note the witness pays back.

### The dip requirement, measured off: a DI-only trade that leaves the amped renders where they were

`fineOnsetDipDb` is what stops a fine onset re-articulating a sounding note
unless the 5ms envelope dipped first — the pick landing on the string before
it plays it. On `held-then-picked-six-strings-120bpm-di` it is what refuses
the take's misses: the witness sees each with a 19–26dB rebound and the dip
test vetoes it.

Falsifier, stated before the run: the override must hold the derivation set
at 84 Notes / 2 missed / 8 extra **and** not lose ground on the twelve
held-out takes; derivation movement refuses it on the spot.

It clears both. With `transient.fineOnsetDipDb = 0` (override, no source
change) the derivation set does not move at all, and the held-out takes go
from 24 missed / 72 extra to **23 / 72** — one event better, no extras. The
take it was aimed at goes from 14 missed / 5 extra to **1 missed / 9 extra**,
its last miss a G4 (`p5c1h`) with no transient in the window at all. Across
the eight takes: 111 missed / 265 extra → **89 / 278**.

**It is refused anyway, on three counts.**

*Both axes.* Corpus-wide the trade is 137 missed / 345 extra → 114 / 358:
23 events bought with 13 extra Notes. `measure-splits.ts` reads it the same
way, 340 split / 410 extra → 351 / 421. A net loss on the extras axis is a
finding and not a commit, and this one is not marginal.

*Where the events come from.* All 23 are on held-out (1) and on the eight
unassigned takes (22). Setting a shipped constant from those readings fits it
to held-out data and to PROVISIONAL generated labels that
`docs/SAME-PITCH-MATERIAL.md` records as not matching the player's own
description on two of the four takes. The eight takes gate nothing precisely
because they are not confirmed; they cannot calibrate a constant either.

*What it does not touch.* **All four amped renders are bit-identical with the
dip requirement off** — 1/71, 9/44, 13/32 and 2/83 missed/extra, and 60/77,
57/62, 33/41 and 51/82 split/extra, before and after. Every split on the
eight takes is same-pitch and contiguous, and on the amped renders that is
the open problem; the dip override moves none of it. It is a direct-input
effect end to end, which is consistent with where it was derived and with
DECISION-028's reading that compression is what removes the separation.

The dip requirement stays at −6dB. What would settle it is the DI derivation
material DECISION-033 already names as its precondition, plus a reviewed
label pass over the eight takes — not a threshold read off the takes
themselves.

### Why the merge does not move the split axis at all

Worth stating as a number rather than an impression, because the question comes
up every time the corpus is re-scored: `measure-tail-fragments.ts` reads
**296 same-pitch contiguous fragments on `main` and 296 on the merge.** Not
nearly the same — the same. `detached` stays 0 and `other pitch` stays 24, so
the whole 320-fragment population is unchanged in shape as well as in count.
Split *events* go 342 to 340 and the composition shifts between fixtures (the
DI triplet 23 to 11, the eight takes 243 to 252), but the defect itself does
not move.

That is what the DI repair is: a PROPOSAL-side change. The fine-hop witness
adds boundaries where the 13.3ms broadband kernel proposed none, and the prefix
rule absorbs a pre-pick fragment BACKWARD into the note the pick plays.
Neither can remove a boundary struck inside a note that is already sounding,
and that is the whole of this defect.

`measure-split-cause.ts` confirms it from the other end by naming the site that
accepted each of the 296:

```
sharpness                199      envelope-rise             35
(no rearticulation)       30      new-pitch                 21
ring-out-sharpness         4      fine-onset                 4
chord-decay-excess         3
```

**The fine witness accepts four of the 296.** Two thirds are accepted by
`sharpness`, a test that predates this work and that neither branch touched.
The thirty with no accepted rearticulation within 60ms did not come from the
re-articulation path at all — the region lane or a Note ending and restarting —
and are a separate defect sharing a symptom.

And the readings at those wrong boundaries are not marginal: sharpness has a
**median of 3.94 and a p90 of 9.78** where they were accepted. The engine is
not failing to compute something at these instants. It is reading a real
spectral rise and calling it a pick, which is exactly DECISION-028's 0.698 AUC
ceiling seen from the phantom side instead of the missed side. The same
decision that lets a quiet re-pick through is the one that lets a compressed
note's own sustain through, which is why the two failure modes cannot be traded
off by moving a threshold: at roughly five real re-picks per phantom, all seven
configurations DECISION-028 measured removed about one real note per phantom.
The `fineOnsetDipDb = 0` reading above is that same exchange rate in the other
direction — 23 events recovered, splits 340 to 351.

The physical root is unchanged and is where the asymmetry points: on the *same
performance*, `same-pitch-quarters-a3-e5` splits 71% of its events on the amped
render and 12% on the DI, and `held-then-picked-six-strings` 50% against 7%.
Compression re-inflates the decay and the amp's harmonic re-excitation puts
genuine flux inside one note. A listener does not judge these instants in
isolation — the rhythm and a monotonically decaying envelope across the phrase
are what make a single picked note obvious to an ear — and that is the sequence
claim DECISION-028 named as the precondition, not another per-boundary gate.

#### Why the deep lane does not already do this

The obvious objection is that re-segmenting over more of the phrase is the deep
lane's whole job. It is, and the reason it does not reach this defect is three
specific things rather than a missing lane.

**One, its merge is switched off.** `deep.regionMerge` is `false`.
`mergeWithinSegment` is the only path that removes a boundary over a region,
and DECISION-028 (a) measured it on: 383 missed labels against a 161 baseline.

**Two, the local absorber is forbidden from these Notes by name.**
`absorbAttackFragments` would accept them on size — `mergeMaxFragmentMs` is
250 and these fragments run 93 to 227ms — but it declines any candidate that
is `restruck && announced`. That is exactly this population: 199 of the 296
carry an accepted re-articulation, and every one clears the 55ms
`minStableMs` announce bar. The guard is deliberate and its reason is in the
comment above it: retracting an announced re-articulation drags the survivor's
start back over a stroke it did not begin, which is how a run of picked notes
comes out as one long chord. DECISION-019 is the same rule from the other side.

**Three, and the load-bearing one: the region segmenter sequences windows, not
events.** `deep/resegment.ts` turns a span into a sequence of events with two
witnesses — the dominant fundamental changed and stayed changed, and the
envelope rose above the quietest point since the last boundary. Both are
decided at one boundary from the windows around it. Neither compares a
candidate boundary to the OTHER boundaries in the phrase, which is the
regularity a listener uses. The lane has the audio to do it: `ringSeconds` is
4, about two bars at 120bpm, while a region caps at `maxRegionMs` 1200. So the
context is in the ring and unread, and "the deep lane looks at more of the
phrase" is true of its window sequence and not yet true of its event sequence.
That is the same gap DECISION-028 named, located in a file.

### The rate gate's ceiling, re-measured with the same-pitch material in the corpus

"The causal rate estimator: built, measured, reverted" above closed the local
rate on a stated ceiling: **8 emitted Notes** at an oracle rate, which is not
worth a mechanism. That reading was taken on a 459-label corpus — its own
end-to-end table says `99 / 459` — and 459 is the corpus WITHOUT the eight
120bpm same-pitch takes. It therefore measured the rate gate on material that
barely contains the phenomenon, which is precisely DECISION-022's complaint
about every ceiling this project had taken to that point.

Re-run unchanged on the merged tree (1,590 labels, `measure-restrike-oracle.ts`,
no source change), the same oracle gate reads:

```
  candidates 280    spurious (drop) 219    matched to a label (KEEP) 61

  sounded/IOI <= 0.40 (oracle)   missed 138 (+1)   merged 214   emitted  77
  sounded/IOI <= 0.35 (oracle)   missed 137 (+0)   merged 206   emitted  71
  sounded/IOI <= 0.30 (oracle)   missed 137 (+0)   merged 178   emitted  51
  sounded/IOI <= 0.20 (oracle)   missed 137 (+0)   merged 109   emitted  26

  rate x 0.50 .. x 0.90          missed 137 (+0)   emitted 26 .. 73
  rate x 1.50                    missed 144 (+7)
```

**71 emitted Notes at zero missed-label cost, against the 8 that closed the
line.** Nine times the payoff, on the axis the correction above established as
the only one that counts.

The mechanism for the difference is the same threshold arithmetic that entry
identified, and it is worth stating because it makes the result predictable
rather than lucky. The gate removes something a consumer can see only when
`0.40 x rate` clears the announcement bar of 55-90ms. The recorded median
oracle IOI at these candidates was **154ms**, giving a 62ms gate — marginal.
On the merged corpus the spurious candidates' median oracle IOI is **222ms**,
giving 89ms — clear of the bar with room. The same-pitch takes are slower
material than the 140bpm lead lines the old ceiling was dominated by, so the
gate's whole benefit region is where this material actually sits.

**This does not reopen the causal estimator; it makes it testable again, and
that distinction is the finding.** The circularity is untouched: the rate
estimate is corrupted by the over-segmentation it exists to correct, and no
amount of new material fixes that. What changes is whether the known shortfall
still lands below the usable band. `PaceEstimator` read a median of **0.82** of
the oracle rate, and on the old corpus 0.82 x 154ms gave a 50ms gate, under the
bar — which is exactly why it achieved 2 emitted Notes against the oracle's 8.
On this corpus 0.82 x 222ms gives a 73ms gate, over it.

So the falsifier for rebuilding `PaceEstimator` (reverted, not in the tree)
is stated in advance and is narrow: **it must reach at least 35 emitted Notes —
half the oracle's 71 — at no cost in missed labels on the derivation set and no
net loss on the twelve held-out takes.** Below that it is the same shuffle the
entry above reverted, and the ratio form is closed for good rather than
pending. Note what it cannot be fitted on: the eight takes' labels are
PROVISIONAL, so the 71 is a ceiling measured against unreviewed ground truth,
and the label review is a precondition for believing the number rather than the
direction.

**A gap in the corpus that this line would depend on, and that no fixture
covers:** every one of the 25 takes is metronomic, at 120 or 140bpm. Nothing
here plays rubato, accelerates, or holds a note past the beat. A rate gate
assumes regularity, and its failure mode is merging notes a player actually
played while slowing down. The quantile-0.25 reading is the existing mitigation
— reading a passage as faster than it is only declines merges — but it was
derived on metronomic material and its safety on expressive playing is
untested and currently untestable here.

### The two pace attempts, side by side, and the one combination neither ran

"A tempo estimate that runs live and biases the engine toward whole notes and
away from fragments" has been built **twice** in this repository, and both are
recorded above in different places. Reading them together is the useful thing,
because each found a different defect and each repair is in the other's entry.

| | attempt 1: constants at a reference pace | attempt 2: the ratio gate |
|---|---|---|
| where | "The reference pace, derived on the five originals" | "The causal rate estimator: built, measured, reverted" |
| the estimate | median of the last 8 inter-onset gaps, fed from **every accepted transient** | quantile 0.25 of the last 8, fed **once per attack burst** |
| what it drove | every duration constant: `minStableMs` x4, `articulationMs` x2, `minRestrumMs`, `ringOutMs`, `mutedRestrumWindowMs`, `releaseGraceMs`, `changeStableMs` | one merge gate: absorb when `soundedMs < 0.40 x rate` |
| verdict | reverted | reverted |
| why | an ORACLE pace buys nothing on the sixteenths, and scaling by the TRUE rate **costs the derivation set** 4 detections and 3 labels | causal rate reached 2 emitted Notes against the oracle's 8 |

Three findings fall out of the pair that neither entry states alone.

**The feed, not the ring, was attempt 1's real defect.** Attempt 1's estimator
read the amp-path lead take (197ms per note) as FASTER than the sixteenths take
(105ms) — a straight inversion. Attempt 2 diagnosed it: one pick crossing six
strings is one stroke with several transients, so feeding every transient reads
a passage as several times faster than it is played, and feeding per attack
burst instead moved whole-corpus extras 107 to 102. **Attempt 1 was never
re-run with attempt 2's feed.** Its oracle row is therefore the only sound part
of its verdict, and its measured-pace rows describe an estimator that has since
been fixed.

**Two of the constants attempt 1 scaled are physics, not tempo, and the
derivation set said so.** `releaseGraceMs` carried all of the derivation damage
by itself: how long silence must persist before a Note has ended is a property
of the string's decay and the amplitude gate. `changeStableMs` is bounded by
how long the chroma path needs to turn over. Both are wrong to scale in
principle, and a third attempt should scale neither. That is a narrowing of the
hypothesis, not a refutation of it: attempt 1 tested "scale every duration" and
found one constant that must not be scaled.

**Both attempts were measured without the same-pitch material.** Attempt 1's
oracle table lists the sixteenths takes, the lead lines and `clean-lead`;
attempt 2's end-to-end table reads `99 / 459`. The ceiling entry above puts the
oracle gate at **71 emitted Notes on 1,590 labels against the 8 that closed
it**, for a reason that is arithmetic rather than hopeful: the gate is visible
only when `0.40 x rate` clears the 55-90ms announce bar, and this material's
candidates sit at a 222ms median rate against the old 154ms.

**So the untested combination is specific:** attempt 1's target (bias the
segmentation decision toward whole notes) with attempt 2's feed (per attack
burst, quantile 0.25), scaling only the announce and absorb constants and
explicitly NOT `releaseGraceMs` or `changeStableMs`, measured on the merged
corpus. Nobody has run that. It is not a new idea — it is the intersection of
two reverted ones, and both refutations' stated causes have a repair in the
other's entry.

**One further shape neither attempt used.** Both were hard thresholds at a
boundary. `tracker/hypotheses.ts` already holds a stateful trail
(`candidate -> contender -> leading -> confirmed`), which is where a *prior*
would live rather than a gate — weighting a segmentation hypothesis by how well
its note lengths fit the passage, instead of merging or not merging at one
instant. DECISION-036 makes that admissible by accepting retroactive amendment
as the contract. It is untested and unmeasured, and stated here so it is not
mistaken for a result.

### The third pace attempt: built with both corrections, and it misses its own bar at the oracle's operating point

The falsifier stated in the entry above was **35 emitted Notes removed — half
the oracle's 71 — at no cost in missed labels on the derivation set and no net
loss on the twelve held-out takes.** The combination it was stated for was built:
`tracker/pace.ts` (ring of 8 gaps, quantile 0.25, fed once per attack burst,
null until three gaps, forgotten after 1.5s of silence — attempt 2's feed and
quantile, attempt 1's target) driving `absorbAtPace()` in `note-tracker.ts`,
which hands a same-pitch fragment back to the Note it split from when the
fragment sounded for less than `pace.absorbRatio` of the local stroke length.

The candidate is the oracle's candidate exactly — a Note opened by an accepted,
settled, same-pitch re-articulation that has ended by stepping away to another
pitch — so the shipped rule and the oracle that bounded it are the same rule.
Shipped at `absorbRatio: 0`, verified byte-identical to the merge on
`measure-downstream-ledger.ts --all` with the gate off.

| `absorbRatio` | derivation missed | held-out missed | the eight | ALL missed | split events | extra Notes | Notes removed |
|---|---|---|---|---|---|---|---|
| off | 2 | 24 | 111 | 137 | 340 | 410 | — |
| 0.30 | 2 | 23 | 112 | 137 | 341 | 408 | 2 |
| **0.35** | 2 | 23 | 113 | 138 | 338 | 401 | **9** |
| 0.40 | 2 | 23 | 113 | 138 | 329 | 391 | 19 |
| 0.50 | 2 | 24 | 113 | 139 | 315 | 368 | 42 |
| 0.60 | 2 | 24 | 115 | 141 | 304 | 353 | 57 |

**At the oracle's own operating point it fails, and not narrowly: 9 Notes
against a bar of 35 at 0.35, and 19 at 0.40 where the oracle removed 77.** The
derivation set does not move at any ratio tried, and the held-out takes gain a
label at 0.30 through 0.40 rather than losing one, so the mechanism is not
dangerous — it is mostly inert. That is the same shuffle attempt 2 was reverted
for, reproduced with attempt 2's own corrections in place, and the ratio form of
this gate is therefore closed as a shipping candidate on the reading it was
given.

**The honest wrinkle, stated rather than buried.** At `0.50` the sweep clears
every clause of the falsifier as written: 42 Notes removed, derivation unmoved,
held-out back at its baseline 24 with no net loss. It is not being shipped on
that, for two reasons and one of them is disqualifying on its own.

*The borrowed constant.* There is a principled argument for 0.50 rather than a
fitted one: attempt 2 measured its causal estimator at **0.82** of the oracle
rate, and 0.40 / 0.82 = 0.49, so 0.50 is the causal ratio that reproduces the
oracle's effective duration bar. But that 0.82 was measured on a *different
implementation* of a different estimator against a 459-label corpus, and it has
**not been re-measured for this one**. Until it is, 0.50 is a number chosen
because this table shows it clearing the bar, which is fitting on held-out and
provisional-label material, and the difference between "derived" and "fitted"
here is exactly one measurement that has not been taken.

*The two labels.* 0.50 costs two labels on the eight takes (111 to 113), so the
corpus-wide reading is 42 extra Notes removed for 2 missed. That is a far better
exchange than the roughly one-for-one every energy witness produced, and it is
still a net loss on the missed axis, which the standing bar calls a finding
rather than a commit. Both labels are on takes whose ground truth is PROVISIONAL
and which `docs/SAME-PITCH-MATERIAL.md` records as not matching the player's
description on two of four — so the cost is measured against annotations that
cannot yet carry it.

**Where the removed Notes come from, which is the finding and was not how the
verdict above was first framed.** Leading with "9 against a bar of 35" put the
weight on a bar chosen as half the oracle's figure, which is an arbitrary
fraction rather than a test of whether the change is worth having. Split by
material, the reading says something sharper and less flattering to both sides:

| `absorbRatio` 0.40, extra Notes | off | 0.40 | delta |
|---|---|---|---|
| derivation (5 takes, 78 events) | 13 | 13 | **0** |
| held out (12 takes, 381 events) | 83 | 82 | **-1** |
| the eight (1,131 events, PROVISIONAL labels) | 314 | 296 | **-18** |

**Eighteen of the nineteen removed Notes are on the eight takes.** On the
seventeen takes whose labels have been reviewed the mechanism does essentially
nothing: derivation is exactly unmoved, and held-out moves by one Note on each
axis (one extra removed, one missed label recovered) which is a shuffle — the
amped triplet take gives up two extras while the mic triplet take gains one.
The missed cost divides the same way: -1 on held-out, +2 on the eight.

So the exchange rate is good — 19 extras for 1 missed corpus-wide at 0.40, and
42 for 2 at 0.50, against the roughly one-for-one every energy witness produced
— and it is almost entirely an exchange rate measured against annotations that
`docs/SAME-PITCH-MATERIAL.md` records as not matching the player's description
on two of the four takes. **The verdict is therefore "not yet decidable", not
"not worth having".** If the eight takes' labels survive review, a 19-for-1
trade at the oracle's own operating point is a change this project would take;
if they do not, both the benefit and the cost move and the reading has to be
taken again. The label review is the blocker in the strict sense that the entire
measured effect sits on the unreviewed side of the corpus.

**What is retained and what is closed.** `pace.absorbRatio` stays 0 and the
ratio gate is closed at its stated operating point. `PaceEstimator` stays, with
`tests/engine/pace.test.ts` asserting both of the defects that sank the earlier
attempts: a pace fed per transient cannot recover the stroke length, and a pace
is forgotten across a rest rather than carried. It is retained because a
sequence model over the envelope — DECISION-028's actual opening, and the thing
this gate is not — needs a pace, and this one's two known defects are fixed and
covered. **The next measurement is named and small:** this estimator's own
ratio to the oracle rate at the candidates, per take. If it is 0.82, 0.50 is
derived and the gate is worth re-reading against reviewed labels. If it is not,
the ratio form is finished.

## The rate gate's second witness: a same-pitch boundary over which no energy arrived, read on the direct input

*Iteration 1 of the slow-note-splits loop (`docs/slow-note-splits-loop-prompt.md`,
DECISION-044). Journal entry in `docs/slow-note-splits-loop-log.md`; DECISION-045.*

### What the shipped gate could not see

DECISION-030's rate gate holds a Note opened by a same-pitch re-articulation
back from announcement until it has outlasted 0.35 of the local inter-onset
interval — but only when the boundary under it showed no envelope dip
(`dipRatio >= 0.85`). The dip is the gate's second witness, and it was chosen
on the whole corpus, where the amped renders dominate. Read on the slow subset
per signal path (a bench over `analyzeSamples` with `trackerTrace`, every
accepted same-pitch re-articulation paired to the eval matcher's verdict on
the Note it opened, EMITTED Notes only — the never-announced ones are the "64
against 8" trap the record already names), the direct input turns out to be
a column the gate never touches:

```
  slow subset, DI: 180 emitted same-pitch candidates, 26 spurious, 154 matched
    accepting site of the 26:  sharpness 24   fine-onset 2   envelope-rise 0
    dipRatio     spurious med 0.64 (p10 0.17, p90 0.77)    matched med 0.12 (p90 0.38)
    riseRatio    spurious med 0.77 (p25 0.63, p75 0.94)    matched p10 1.01, med 2.76
    fragment / causal IOI (shipped estimator)
                 spurious med 0.42 (p75 0.51, p90 0.75)    matched p10 0.68, med 0.86
    AUC (spurious lower): riseRatio 0.909, fragment/IOI 0.894, sharpness 0.823
```

Not one of the 26 DI phantoms reaches the dip bar of 0.85 — their median is
0.64 — so on the direct input the shipped gate is inert, and every one of them
was announced. This also corrects the journal's premise for the DI column: the
whole-take `measure-split-cause.ts` count put `envelope-rise` first on DI (20
of 40), but among EMITTED slow-subset phantoms `envelope-rise` accepts none.
The envelope-rise fragments are the ones the existing bars already refuse
before announcement; what reaches the consumer comes through `sharpness`.

What the DI phantoms share is that no energy arrived. `AttackEvidence.riseRatio`
— the short envelope over its 80ms baseline — sits at 0.77 for them, and a
real re-pick on the same recordings rises to at least 1.01. On the direct
input a pick that lands is louder than the string it lands on, because
nothing in the chain is holding the level flat. The dip reads the same
physics from the other side: a real DI re-pick damps the string on contact
(`dipRatio` median 0.12), a phantom does not (0.64). The two are independent
witnesses of the same absence — one that the string was never touched, the
other that nothing was added — and the shipped gate had only the first, set
where the direct input never goes.

The amped and mic column is a different population and this entry does not
claim it: 147 spurious against 238 matched, `riseRatio` 0.502 AUC (spurious
median 1.04, matched 1.03 — a compressor makes them identical), `dipRatio`
0.452, nothing above 0.65. That matches every earlier reading of the amped
takes and is why the falsifier below asks only that the column not get worse.

### The falsifier, stated before the pipeline ran

Derivation missed labels up by no more than 1 (the emitted-only bench
predicted +1, on `held-then-picked-six-strings-120bpm-amped` with no dropped
candidate near the label — a matcher reassignment, to be diagnosed); slow
subset DI split events down by at least 10; the amped and mic column not
worse; the twelve held-out takes not worse, read once; eval PASS.

### What was built

`tracking.rateFragmentNoRiseRatio` (0.8), `tracking.rateFragmentNoRiseDipRatio`
(0.4) and `tracking.rateFragmentNoRiseSpanFraction` (0.5): a same-pitch
boundary with `riseRatio` under 0.8 and `dipRatio` at or above 0.4 sets an
announce bar of 0.5 × the local interval on the Note it opens. The shipped
dip form is unchanged; a boundary that fails both witnesses takes the longer
bar. The decision is the exported `rateFragmentSpanFraction()` in
`note-tracker.ts`, covered by `tests/engine/rate-fragment.test.ts` on vectors
read off the corpus. With `rateFragmentNoRiseRatio` at 0 the engine is
bit-identical to `main` (verified in the pipeline, every fixture).

### The sweep, derivation predicate "not 140bpm" (5 originals + 8 same-pitch takes)

```
  rise <  frac  dip >=   slow DI split   slow amped+mic   deriv missed   deriv fp   deriv extras
  off                     45/327          158/334          113            241        298
  0.75   0.5   0.4        39              158              114            231        292
  0.8    0.5   0.4        35              158              114            227        288
  0.85   0.5   0.4        35              157              114            226        287
  0.8    0.45  0.4        36              158              114            229        289
  0.8    0.55  0.4        35              158              115            224        287
  0.8    0.5   0.3        35              158              114            227        288
  0.8    0.5   0.5        35              158              114            227        288
```

The rise bar has a cliff on both sides: 0.75 gives up four of the ten DI
events, 0.85 starts to reach the amped column (one event) and the bench put
the nearest real re-picks at 0.82–0.89 (`same-pitch-eighths-a3-120bpm-di`,
`held-then-picked-six-strings-120bpm-di` after a long hold — each a note whose
predecessor was still loud when it was picked). 0.5 on the span is the
largest value that costs nothing beyond the one diagnosed below; 0.55 costs a
second label. The dip floor is flat from 0.3 to 0.5 — the derivation set
cannot see it, so it stays at the value the DI readings put it at (phantoms
0.44–0.85, real re-picks 0.38 at p90) as a floor rather than a tuned edge.

Held out, read once at 0.8 / 0.5 / 0.4: missed 24 → 24, false positives 70 →
69, split events 75 → 74 (`lead-line-amped-quarter-eighth-triplet-140bpm`
gives up one phantom), every other take bit-identical.

### The one label that moved, by instrument

`held-then-picked-six-strings-120bpm-amped`, label `p1c4q4` (F#2 at 17535ms).
On `main` the label's own onset, at 17506ms, is refused as `chord-not-sharp`
— that is unchanged, and it is one of the ledger's existing causes on this
take. What credited the label on `main` was Note `n31`, opened at 17840ms:
305ms after the label's onset, outside the matcher's 300ms onset window, paired
on 133ms of time overlap alone. The boundary that opened it reads `riseRatio`
0.51 and `dipRatio` 0.79 — half the baseline energy, no contact — inside a
chord ringing at 853ms; the new witness holds it to 253ms (0.5 × a 507ms
interval), it lives 120ms, and `end()` drops it. So the derivation count reads
+1 missed, and what was lost is a phantom that had been standing in for a
label the engine had already missed at its onset. Nothing that was played on
time is lost anywhere on the derivation set; the label is on the PROVISIONAL
side of the corpus.

This is reported as it reads — +1 on the derivation missed count — and the
verdict is the owner's. The letter of the standing bar ("missed labels may not
rise") is broken by one; the intent of it is not, and the trade is fourteen
emitted phantoms on the direct input for that one overlap credit.

### Numbers, before → after

```
  slow subset (--subset=slow)  DI 52/54 → 42/44 split/extra    amped+mic 189/245 → 188/244
  corpus (measure-splits)      316 / 379 / 20  →  305 / 368 / 20   split / extra / strays
  by material                  derivation missed 113 → 114, fp 241 → 227
                               held-out   missed  24 →  24, fp  70 →  69
  eval                         PASS, 0 required failures, the one pre-existing informational
  tests                        511 → 522
```

Per take on the direct input: `same-pitch-eighths-sixteenths-e5-120bpm-di`
22 → 13 of 64 slow labels split (extras 24 → 15 on the whole take),
`same-pitch-eighths-a3-120bpm-di` 6 → 5, `held-then-picked-six-strings-120bpm-di`
8 → 8, `same-pitch-quarters-a3-e5-120bpm-di` 9 → 9. The quarters take's nine
are `fine-onset` and near-unity-rise boundaries (0.94–0.99) this witness does
not reach, and the held-then-picked take's eight are mostly re-picks credited
a neighbour's name rather than tail fragments.

### What this closes and what it opens

The ledger's row C9 asked whether `riseRatio` separates DI phantoms from real
re-picks and whether a bar on it removes fragments at +0 missed. Separation:
yes, 0.909. The bar: at +1 on an overlap credit, with the ten-event gain on
one take. The remaining DI slow splits are not this shape — the E5 take's
thirteen survivors sit at rise 0.8–1.0 with the real re-picks at 1.01, which
is the overlap the 0.8 bar stops at — so the next DI gain needs a witness
other than the envelope's level, or the direct-input recordings from the
owner's rig the journal already asks for.

## The boundary of a slow direct-input stroke is the pick's release, not its contact

DECISION-044's loop, iteration 2. The brief's door 2 was benched first and is
closed below; the iteration then went to what the remaining direct-input
splits actually are, which turned out to be a timing error with a physical
cause rather than phantom Notes.

### Door 2, benched and closed: no attack measurement reaches the bar

The brief's door 2 asked for a re-pick witness that survives compression: the
percussive component's flux (HPSS, 11 and 15 hop medians), a band-limited
1–6kHz and 2–8kHz envelope dip and rise, spectral centroid and flatness
novelty, and octave displacement of the fragment, each read at the fine hop
on the outcome-shaped population — every emitted same-pitch Note, spurious
(no label under it) against matched — per signal path on the derivation
takes. The bar was 0.80 AUC on the amped and mic column, which is where the
shipped witnesses are blind.

```
  DERIVATION amped+mic, slow subset: 127 spurious / 231 matched      AUC (oriented)
    band 1-6k dip 0.507   band 1-6k rise 0.51   perc flux 1k+ 0.578
    perc fraction 0.647 (w15 0.639)   centroid jump 0.584   flatness 0.515
  DERIVATION amped+mic, all emitted same-pitch: 133 / 405
    perc fraction 0.684 (w15 0.673)   band dip 0.511   everything else ≤ 0.60
  DERIVATION DI, slow subset: 25 / 147
    engine rise 0.906   band 1-6k rise 0.910   centroid after/before 0.830
    perc fraction 0.806 (oriented)   band dip 0.506
```

Nothing on the amped column is over 0.69, and the direct input's best
witnesses are the envelope rise the shipped gate already reads, in a band or
broadband. Through an amp a phantom and a re-pick are the same event on every
measurement tried, which is the reading DECISION-028 and DECISION-045 had
from the broadband envelope, now from the spectrum and the percussive
residual too. Ledger rows C2a–C2d close on these numbers.

### What the remaining direct-input splits are

The 35 slow DI split events left after DECISION-045 were classified one by
one from the tracker trace (`classify-splits`, scratch): whether the Note
charged as the split is paired to a label, what accepted it, and how far from
the label it opened. 27 of the 35 are one Note per pick with the Note opening
45–70ms BEFORE its label, and the Note before it ending as early; 8 are
phantoms. The score calls the first shape a split because the early-opening
Note lands inside the previous label's span, but nothing extra was emitted.

A 2ms RMS envelope under the labels shows why. A slow pick stroke on a direct
input is two events: the pick lands on the string and mutes it, 25–40dB down
within a few milliseconds, and 45–70ms later lets go, at which point the note
sounds. Every DI label probed sits on the release, within 6ms on the
hand-labelled takes. Both kernels fire on the contact — the fine witness by
design (DECISION-018 built it for exactly this transient), the broadband one
through the `sharpness` fallback — so the Note opens there. The release then
lands inside `transient.articulationMs` of that opening and one of two things
happens: the Note is still too young to be re-articulated (`minStableMs`) and
the attack is folded in, or the fine witness opened a stub on the contact and
the release's split absorbs that stub and inherits its start
(`absorbArticulationFragment`). Either way the boundary stays on the contact.

### The falsifier, stated before the pipeline ran

Derivation DI onset error must fall; derivation missed may not rise; the
amped column may not get worse; held-out read once after the bar was chosen;
eval PASS; and the one take a retrospective simulation showed moving the
wrong way, `held-then-picked-six-strings-120bpm-di`, has to be explained
before shipping.

### What was built

`tracking.releaseRiseRatio` (0 = off, bit-identical to the branch before it).
A Note opened on a contact — by the fine witness, or by a broadband attack
whose `riseRatio` was under `CONTACT_RISE` (1.2: DI contacts and phantoms
rise 0.94 at their third quartile, real re-picks 1.01 at their tenth
percentile, so the constant sits above every contact read and under every
release and is not a tuned edge) — has its boundary moved to the first attack
inside `transient.articulationMs` of its opening whose `riseRatio` clears the
bar, provided the Note has not been announced and has not bloomed into a
chord. Two paths, both traced as `released`: the attack lands in the Note
while it is unsettled and the start simply moves (`via: "unsettled"`); or the
attack split a stub off the contact, the stub is absorbed as before so the
consumer never sees it, but the survivor keeps its own start instead of
inheriting the stub's (`via: "stub"`). `NoteRecord` carries the rise and dip
of the hop that opened it and whether the fine witness did.

Level was tried first and cannot work: a fine-opened stub is backdated onto
the contact, so its frames were folded before it existed and it carries the
release's own level (absorbed `levelRatio` 1.0 on every such stub). The rise
over the 80ms baseline works because that baseline spans the muted string.

### The sweep, derivation predicate "not 140bpm"

```
  bar      slow DI   amped   split  extras  missed  fp    |onset| med / p90
  off      35/327    158     231    288     114     227   25.0 / 90.7
  1.5      30        158     225    280     114     222   25.0 / 95
  2        30        158     225    281     114     223   23.7 / 95
  2.5      31        158     226    283     114     224   24.0 / 95
  3        31        158     226    283     114     224   24.0 / 95
  4        32        158     227    284     114     225   25.0 / 95
```

Flat from 1.5 to 3; 2 is the middle of the plateau and the value at which the
onset median moves. Missed is 114 at every bar. The p90 rises at every bar on
one take, read below.

Every boundary the rule moved was read with its rise, dip, contact-to-release
gap and the local pace (61 `released` events at bar 2 across the corpus, 13
of them the same label moved twice by a chained stub). The gaps are 40–80ms,
clipped by the articulation window; the dip at the release on the direct
input is 0.007–0.15; the rise 2.1–11.2. On `same-pitch-eighths-sixteenths-e5-120bpm-di`
22 boundaries moved from 42–93ms early to 2–25ms late; on
`same-pitch-quarters-a3-e5-120bpm-di` four moved from 38–51ms early to 27–33ms
late and one (`e39`) from 0 to +67, where the label sits on the contact
itself — that take's labels are PROVISIONAL, placed by an RMS-envelope tool.

### Numbers, before → after

```
  slow subset (--subset=slow)  DI 42/44 → 34/36 split/extra    amped+mic 188/244 → 188/243
  corpus (measure-splits)      305 / 368 / 20  →  295 / 357 / 18   split / extra / strays
  tail fragments               252 same pitch / 0 detached / 23 other → 246 / 0 / 23   (extras 275 → 269)
  by material                  derivation missed 114 → 114, fp 227 → 223, extras 288 → 281
                               held-out   missed  24 →  27, fp  69 →  67, split 74 → 70, extras 80 → 76
  ledger MISSED                138 → 141 (both held-out takes below)
  eval                         PASS, 0 required failures, the one pre-existing informational
  tests                        522 → 525
```

Per take on the direct input: `same-pitch-eighths-sixteenths-e5-120bpm-di`
13 → 9 of 64 slow labels split (extras 15 → 10, onset p90 51 → 25ms),
`same-pitch-quarters-a3-e5-120bpm-di` 9 → 8, `same-pitch-eighths-a3-120bpm-di`
5 → 5, `held-then-picked-six-strings-120bpm-di` 8 → 8. Amped and mic: extras
37 → 36 on the E5 amped take, 79 → 79 with one stray fewer on the quarters
amped take, nothing else on derivation moves.

### The held-then-picked take, read

Its onset error rises (median 88 → 97ms, p90 153 → 158) on five moved
boundaries, every one further from its label. The envelope under those five
labels: the label sits 20–90ms BEFORE the contact's mute, and the moved
boundary lands 12–15ms after the biggest envelope jump in the window — on the
release, as everywhere else. That take's labels are PROVISIONAL, one per
event from an RMS-envelope tool, and on this passage the tool put them ahead
of the stroke. The rule is right and the labels are not; the label review the
journal already lists as an owner-side blocker covers it.

### Held-out, read once

Split 74 → 70, false positives 69 → 67, missed 24 → 27, onset p90 71 → 67ms.
`lead-line-di-quarter-eighth-triplet-140bpm` is the direct-input take the
rule was built for and reads as such: slow splits 7 → 4, extras 12 → 9, onset
p90 53 → 21ms. The three labels:

- `t12` on that take. Its own pick, a +18dB rise at the label, was never
  detected; the Note credited to it was a 40ms stub sitting in the NEXT
  stroke's mute, 66ms late, and the rule folds that stub into the release it
  belongs to. An overlap credit for a label the engine had already missed —
  the same shape as DECISION-045's one label.
- `s7` and `s16` on `lead-line-sixteenths-e-fsharp-140bpm` (room mic,
  sixteenths at 140bpm, 107ms apart). At `s7` the pick at the label opened a
  Note with a real transient (sharpness 12.8) but no rise, because the
  previous sixteenth was still loud; the envelope under it shows the
  contact-then-release shape and the boundary moved 67ms onto the release.
  The region lane had found the next sixteenth 62ms after that, and its
  reconciliation reads a fast-lane boundary within `deep.minSegmentMs` of
  its own as agreement, so the second Note was no longer carved. `s16` is the
  same reconciliation one bar later, credited before by a duplicate Note that
  started 117ms ahead of it. One real note lost, one credit-by-overlap, both
  on the one take where the stroke's own gap is more than half the note
  interval.

The moved boundaries that cost something are the two whose contact opening
had a broadband transient with sharpness above 9 (the mic sixteenth, and a
strum on the mic cowboy take whose onset moved 66ms later without losing the
label); the direct-input contact openings read sharpness 0.5–6.6. That is a
candidate guard — a contact does not scrape — and it stays a candidate,
because it was read on held-out material and a bar chosen there would be
tuned on it. It is in the ledger for the next iteration to derive on its own
predicate.

### What remains on the direct input, by shape

30 slow DI splits remain on derivation. Read on the trace, by what became of
the release (`classify-shape`, scratch):

- 9 are a contact REFUSED as a re-articulation (`no-energy-not-sharp` or
  `ring-out-not-sharp`, rise 0.56–0.93) followed 67–80ms later by the
  release, accepted — and the burst rule then puts the boundary back at the
  refused contact, because "the boundary is the first attack of the burst".
  On a strum that rule is right; on a single string it puts the note on the
  pick's landing. Five of the held-then-picked take's eight are this. The
  release's rise there is 1.45–3.66 against a previous note still ringing
  (dip 0.25–0.40 on the held notes), so a bar alone would not take all of
  them; the burst's first attack having carried no energy is a witness of its
  own.
- 3 are the release arriving on a hop the amplitude gate refuses (`gated`,
  rise 3.1–6.8): the muted string is under `analysis.rmsGate` when the
  release begins, so `rearticulation.ts` never sees it and the Note keeps the
  contact.
- 1 has the release 80ms after the contact, at the edge of the window the
  rule reuses from `transient.articulationMs`; 1 has a release rising 1.98,
  just under the bar; 2 have a release inside the window and over the bar
  that did not move the boundary (`a3`, `e830`), unread.
- 4 have no release-shaped onset within 130ms of the early Note at all.
- 10 are phantoms: 8 tail, 1 before the real Note, 1 swallowing the next
  pick; 5 of them `sharpness`-accepted, 2 `fine-onset`, 3 with no
  re-articulation decision.

The first two shapes are the same mechanism read at two more sites, not new
witnesses; they are ledger rows C11 and C12.

## A burst that began on a refused contact: the boundary belongs on the release, and moving it there reads worse through the pace estimator

DECISION-044's loop, iteration 3; DECISION-047. Built, measured, reverted. The mechanism
is right at every site it touched and the score is worse, for a reason that
is now its own ledger row.

### The shape

Of the 30 slow direct-input split events left after DECISION-046, 9 are a
pick's contact REFUSED as a re-articulation (`no-energy-not-sharp` or
`ring-out-not-sharp`, rise 0.56–0.93) with the release accepted 67–80ms
later, on `envelope-rise` or `sharpness`. With the contact refused, the Note
it landed in is still open when the release arrives, so the release splits
it — and the split's boundary is "the FIRST attack of this burst", the
contact. Five of the held-then-picked DI take's eight are this; the quarters
DI take has two, the E5 eighths take two.

### The falsifier, stated before the pipeline ran

Derivation slow DI split down by at least 6 of the 9; derivation missed and
false positives not up; the chord takes, whose strums the burst rule exists
for, bit-identical; held-out read once after the bar was chosen.

### What was built

`tracking.burstContactRiseRatio` (0 = off), read in step (a)'s
`rearticulated && settled` branch: when the boundary would be the burst's
first attack, that attack rose by less than the bar, the split does not
change pitch class, and the attack in hand rose by `releaseRiseRatio` or
more, the boundary is the attack in hand. The successor's start follows
through `begin()`'s clamp to `lastEndedAt`. Traced as `released` via
`burst`. Two unit tests on a synthesized stroke with a soft click on the
contact (loud enough for the transient detector, too dull for the
sharpness fallback) showed the split landing on the release with the rule on
and on the contact with it off.

### The sweep, derivation predicate "not 140bpm"

```
  bar      slow DI   split  extras  missed  fp    |onset| med / p90
  off      30/327    225    281     114     223   23.7 / 95
  1.0      33        227    284     116     225   23.3 / 90
  1.1      33        227    284     116     225   23.3 / 90
  1.2      33        227    284     116     225   23.3 / 90
  1.3      33        227    284     116     225   23.3 / 90
```

Flat across the bar — every refused contact reads under 1.0 — and worse on
every count the falsifier names: slow DI split up 3, missed up 2, false
positives up 2. Per take: quarters DI 8 → 7 and onset p90 67 → 57ms;
held-then-picked DI 8 → 10, missed 14 → 15; E5 eighths DI 9 → 11, missed
8 → 9, fp 3 → 5. The chord takes on derivation are not bit-identical either:
`cowboy-chords-c-d-em-g-c-d-em-am-120bpm` reads one split and one false
positive fewer.

### The moves themselves are right

Every `released` event via `burst` at 1.2 on the three DI takes, with the
label delta before → after:

```
  held-then-picked-di   13 moves   -107 → -40, -97 → -30, -100 → -33, -95 → -28, -78 → -12,
                                   -65 → 2, -72 → 8, -70 → 10, -60 → 20, -40 → 27, -58 → 22,
                                   -60 → 20, and one the other way: 10 → 77 (p4c1q3)
  e5-eighths-di          5 moves   -57 → 10, -51 → 15, -57 → 10, -60 → 7, -55 → 12
  quarters-di            5 moves   -78 → -12, -73 → -7, -68 → -2, -60 → 7, -73 → -7
```

Twenty-two of twenty-three boundaries move from 40–107ms early to within
33ms of their label; the one that does not is a label sitting on the contact.
On the held-then-picked take the moves are three times the rule's nine
targets, because the refused-contact shape is under most of its re-picks
whether or not the score counted them as splits.

### Why the score is worse anyway

Two readings, both indirect.

1. **The pace estimator moves with the boundaries.** `localIoiMs` is the
   median of the last eight gaps between Note openings. A boundary moved
   67ms shortens one gap and lengthens the next, and on the E5 take, whose
   gaps sit in two clusters (eighths at ~227ms, sixteenths at ~120ms), one
   moved gap tips the median from 227 to 160ms. The announce bar
   DECISION-045 sets for a same-pitch no-rise fragment is half the local
   interval: 113ms before, 80ms after. Two contact-opened stubs of exactly
   80ms — a contact the sharpness fallback accepted, whose release then
   arrived on a `gated` hop (ledger C12) — that had been held back and
   dropped now clear the bar and are announced. Trace at 15907 and 16147ms:
   `announceBarMs` 113 → 80, `announced` false → true, nothing else
   different. Both new false positives on that take are this.
2. **Overlap credits.** `e843` on the E5 take was credited by an 80ms stub
   177ms late; with the boundary on the release that stub is 13ms and is
   absorbed, and the label's own pick, which the Note before it runs
   through, reads as missed. `p2c3q4` on the held-then-picked take was
   credited across an octave by the C5 reading of a held C3; the 120ms C3
   stub that anchored the credit becomes 40ms and is absorbed. Both are
   labels the engine had not found at their own onset.

So the mechanism did what it says on 22 of 23 boundaries, and the score
moved by four labels none of which is a note the engine had found and lost.
It is still reverted: the loop's bar is the score on the derivation takes,
the falsifier said "not up" on missed and false positives, and the failure
names something real — a pace estimate that a 67ms boundary move can tip by
67ms is a fragility this rule exposes rather than causes, and it will bite
DECISION-046's moves too on any take whose gaps are bimodal. That is ledger
row C14; C11 waits on it.

## The pace estimate reads the openings that never became Notes, and striking them out is the first move on the amped column since DECISION-030

DECISION-044's loop, iteration 4; DECISION-048. Ledger row C14, opened by
iteration 3's failure.

### What is in the estimator's window

`localIoiMs` is the median of the last eight gaps between Note openings,
every opening counted — the comment on it argues that a phantom can only
shorten a gap, which is the safe direction. On the E5 eighths DI take the
window before the eighth at 15907ms (labels 250ms apart) holds these
openings and their fates:

```
  n72 @14147  gap 213   absorbed (13ms stub)
  n73 @14227  gap  80   announced
  n74 @14475  gap 248   announced
  n75 @14627  gap 152   announced
  n76 @14893  gap 267   announced
  n77 @15120  gap 227   dropped unannounced (0ms)
  n78 @15187  gap  67   announced
  n79 @15467  gap 280   announced
  n80 @15616  gap 149   dropped unannounced (91ms)
  n81 @15707  gap  91   announced
  n82 @15907  gap 200   dropped unannounced (80ms)
  sorted: 67 91 149 152 200 227 267 280   median 200
```

Half the gaps are pieces of a 250ms eighth cut by an opening that was later
absorbed or dropped — a contact stub, a phantom the rate gate held back. The
"safe direction" holds for one such gap; eight of them put the median on a
cliff between the pieces (149–200) and the wholes (227–280), and DECISION-047
showed one 67ms boundary move tipping it 227 → 160ms.

### The falsifier, stated before the pipeline ran

Derivation missed, false positives and extras not up; the slow subset not
worse on either path; held-out read once; and, for the row's own claim, the
two E5 stubs at 15907 and 16147ms keep a bar they cannot clear under a 67ms
move.

### What was built

`tracking.paceIgnoresRetracted` (boolean; false is the estimator as
shipped). The tracker keeps its openings with their Note ids; when a Note is
absorbed — `absorbArticulationFragment`, `absorbAttackFragments`, a prefix
claim, a region merge — or ends before it was announced, its opening is
struck from the list, and the gap it cut in two is whole again. Causal: only
a fate already decided is read, and the opening being judged never enters
its own estimate. Unit-tested on synthesized eighths with sharp blips
between them, some of which the tracker opens and drops: the pace reading
at the last re-pick is under 170ms with every opening counted and over
220ms with the retracted ones struck out.

### Numbers, before → after (derivation predicate "not 140bpm"; on/off, no constant to sweep)

```
  slow subset (--subset=slow)  DI 34/36 → 34/36 split/extra    amped+mic 188/243 → 182/232
  corpus (measure-splits)      295 / 357 / 18  →  289 / 346 / 19   split / extra / strays
  tail fragments               246 same pitch / 0 detached / 23 other → 235 / 0 / 23   (extras 269 → 258)
  derivation                   missed 114 → 114, fp 223 → 211, extras 281 → 271, split 225 → 219
  held-out (read once)         missed 27 → 27, fp 67 → 66, extras 76 → 75, split 70 → 70
  ledger MISSED                141 → 141, no fixture moved
  eval                         PASS, 0 required failures, the one pre-existing informational
  tests                        525 → 528
```

Per take: `same-pitch-quarters-a3-e5-120bpm-amped` 50 → 46 of 72 slow
labels split, false positives 77 → 69 (eight phantoms that used to clear a
bar read off cut gaps now do not); `held-then-picked-amped` 47 → 46, fp 52
→ 50; E5 amped and DI one phantom fewer each; `same-pitch-eighths-a3-amped`
56 → 55 split with one more stray, a 93ms Note at 2133ms at the very start
of the take, where the estimator has no gap yet and abstains by design. The
direct-input column does not move: its remaining splits are timing shapes
(C11, C12), not fragments the bar could hold.

### The estimator against the labels

With the tracker's pace reading added to the `rearticulation` trace event,
each accepted same-pitch re-articulation on the derivation takes was read
against the labels' own local interval (median gap of the eight labels
around it):

```
  ratio estimate / labels          off: p10 0.37  med 0.85  p90 1.09   (n 1247)
                                   on : p10 0.48  med 0.96  p90 1.17   (n 1235)
  same-pitch-eighths-sixteenths-e5-di   0.66 / 0.96 / 1.18  →  0.94 / 1.04 / 1.22
  same-pitch-eighths-a3-amped           0.48 / 0.75 / 1.07  →  0.59 / 0.85 / 1.17
  same-pitch-quarters-a3-e5-amped       0.26 / 0.35 / 0.63  →  0.32 / 0.47 / 0.85
  held-then-picked-amped                0.27 / 0.77 / 1.02  →  0.49 / 0.90 / 1.04
```

DECISION-037 recorded a different estimator at 0.82 of the oracle and
called the ratio "not yet decidable" for this one; it is 0.85 → 0.96 at the
median. The quarters amped take stays low because its phantoms are
ANNOUNCED — they clear the bar and stay in the estimate — which is the
self-limiting corruption the constants' comment describes, now measured:
the estimate there reads under half the true interval.

### Two observations, not acted on

`RATE_PERCENTILE` is 0.5 and its comment explains at length why it is NOT
the median. The comment describes the low percentile an earlier build
used; the value is the median. Nothing here depends on which is meant, but
the next person to read the constant should know the comment is stale.

The bars this estimate feeds (0.35 and 0.5 of the interval) were chosen
with the estimate reading 0.85 of the truth. At 0.96 they are effectively
13% longer, and derivation missed did not move, so they hold; but a sweep
of `rateFragmentSpanFraction` under the corrected estimate is the tuning
pass §6.6 allows on a kept mechanism, and it was not run here.

## The refused-contact burst rule, re-run on the corrected pace estimate: the estimator holds, and the score still cannot see the moves

DECISION-044's loop, iteration 5; DECISION-049. Built again, measured,
reverted again. DECISION-048 removed the reason DECISION-047 gave for the
score reading worse, and the score reads the same rule the same way for
two other reasons, both now named.

### The falsifier, stated before the pipeline ran

The same as iteration 3's, since the mechanism is the same: derivation
slow DI split down by at least 6 of the 9 refused-contact events; derivation
missed and false positives not up; chord takes bit-identical; held-out read
once after the bar was chosen. The bar was 1.2 and only 1.2, because
iteration 3's sweep at 1.0 / 1.1 / 1.2 / 1.3 was flat — every refused
contact reads under 1.0 — and a second sweep would have answered a question
the record already answers.

### What was built

DECISION-047's build, character for character: `tracking.burstContactRiseRatio`
(0 = off) and the branch at the split's backdate site in step (a) of the
tracker, with the two soft-click tests. Reverted to bit-identical; the
tests went with the code.

### Numbers, before → after (derivation predicate "not 140bpm", bar 1.2)

    slow subset      DI 30 → 30 of 327; quarters DI 8 → 7, E5 eighths DI 9 → 8, held-then-picked DI 8 → 10
    corpus (deriv)   split 219 → 218, extras 271 → 271, strays 9 → 9, missed 114 → 116, fp 211 → 211, |onset| p90 95 → 93
    chord takes      cowboy-chords derivation take split 3 → 2, fp 4 → 3 (not bit-identical; better)
    held-out (once)  split 70 → 69, extras 75 → 73, fp 66 → 64, missed 27 → 27, |onset| p90 67 → 63

Against iteration 3 at the same bar: slow DI was 33, missed 116, fp 225,
E5 DI 11. The two E5 false positives DECISION-047 traced to the tipped
estimate (`announceBarMs` 113 → 80) are gone — the E5 DI take reads 2
false positives on and off, its stubs' bars now 133 and 140ms — so
DECISION-048 did what it was kept for. What is left is the two overlap
credits from iteration 3 (`e843`, `p2c3q4`, missed 114 → 116, unchanged in
mechanism) and a held-then-picked DI take that reads 8 → 10 split events
while the rule moved its boundaries right. That take is the whole of the
falsifier's first line, and it was read label by label.

### The split instrument reads a chain of early boundaries as a split on whichever label ends up holding two Notes

`measure-splits.ts` charges to a label every Note that starts inside the
label's span, reaching 40ms ahead of it so a Note a little early is still
its own. A Note 67ms early — the contact-opened shape — is past the reach,
so it is charged to the label BEFORE it. On the held-then-picked DI take
the re-picks are all of that shape, so before the rule each label held
its successor's early Note and not its own, one Note each, and the split
count was the four places where two early Notes met. The rule moved the
boundaries the refused-contact shape produces onto the release; those
labels now hold their own Note — and still the next pick's early Note,
where the next pick's contact is a shape the rule does not reach (a
release on a gated hop, or past the 80ms window: ledger C12). Every one of
the six labels that became "split" is a label whose own boundary is now
right and whose successor's is still wrong: `p1c1q3`, `p1c2q2`, `p1c2q3`,
`p1c3q2`, `p1c4q3`, `p2c2q4`. Four labels stopped reading as split for the
mirror reason: `p1c2q1`, `p1c3q1`, `p2c3q2`, `p2c4q1`, each of which had
held two early Notes and now holds one. Net, 8 → 10: the count on this take is the number of chain
positions still wrong, and fixing a boundary in the middle of a chain moves
the charge to its neighbour without removing it. The count is not wrong —
the consumer does see two Notes inside that label's span — but it cannot
credit a rule that fixes one shape while the neighbouring shape stands, and
the falsifier was written as if it could.

### One moved start opens a 67ms window in which a transient is read against the rolling baseline instead of the decay fit

`p1c2q3` reads three Notes, and the third is new. At 9213ms a transient
inside the held note is accepted as a `sharpness` re-articulation; with the
rule off, the same transient at the same moment was refused
`ring-out-not-sharp`. Nothing about the transient changed. What changed is
the Note's age: `rearticulation.ts` sends a transient to the ring-out
branch — the decay-fit test, with the stricter `restrumSharpness` and
`ringOutFluxRatio` bar — only once `soundedMs >= ringOutMs` (250). With the
Note opened at the contact (8920) the transient arrived at 280ms of age and
went to the ring-out branch; with the Note opened at the release (8987) it
arrived at 213ms and went to the rolling-baseline sharpness test, which
accepted it. The ring-out clock runs from the Note's start, so every
boundary this rule moves later by 67ms also delays the ring-out branch by
67ms, and a transient in that window that the decay fit would have refused
is read by the test that shed "a run of new Notes after the phrase had
ended" before the ring-out branch existed. The same holds for every
boundary DECISION-046 moves at the unsettled-Note and absorbed-stub sites;
whether it cost anything there was not read, and is the first thing ledger
row C15's falsifier asks. The physical string was excited at the contact,
so the decay the ring-out test fits began there; the clock the branch reads
should probably be the burst's first attack, not the Note's start.

Beside those three Notes the region lane emitted its own, 8920–9181, opened
at the contact, its prefix claim on the fast-lane Note declined
`prefix:region-attack`. With the boundary on the contact the two lanes
agreed on one Note; with the fast-lane Note starting 67ms later they do
not. It is the fold DECISION-046 met on the held-out mic sixteenths take,
read on a derivation take for the first time.

### Verdict

Reverted, for the second time. The falsifier's first line fails at 30 → 30,
its second at missed +2, and the chord takes are not bit-identical (better,
by one phantom on the cowboy take, but the line said identical). The
mechanism is unchanged from iteration 3 and its moves are iteration 3's;
what this iteration adds is that the estimator was not the only thing in
the way. The score cannot credit the rule until the neighbouring shape
(C12) is fixed, because the split instrument charges chains, and the rule
should not ship until the ring-out clock is anchored to something a
boundary move does not shift (C15), because the moved start reopened the
rolling-baseline test on a held note. C11 is spent; it is not the next
mechanism to build, it is the one that will read clean once C12 and C15
have.

## The release can land on a hop the amplitude gate refuses, and the window it must land in is six hops, not 80.0000000000018 milliseconds

DECISION-044's loop, iteration 6; DECISION-050. Built, measured, kept.
Ledger row C12: the release arriving on a hop the gate refuses.

### The shape, re-read at the current engine

Before building, the 30 slow direct-input split events left after
DECISION-048 were classified again with the same instrument as iteration 2
(the shape of the early neighbour Note each label is charged with). The
distribution is unchanged — 9 refused-contact bursts, 10 phantoms, 4 with
no release-shaped onset, 3 gated releases, 1 at the window's edge, 2 in
the window and unmoved, 1 weak — and every site was then read on the
trace. That read changes what the ledger row promised.

- `e851` → `e852` (E5 eighths DI), "release beyond 80ms (+80ms)": the
  contact opened a Note at 14626.67ms on the sharpness fallback and the
  release arrived at 14706.67ms, accepted `envelope-rise`, unsettled — and
  `isRelease` refused it. Six hops of 640 samples at 48kHz is 80ms; in
  doubles the two hop times subtract to 80.0000000000018, and
  `> articulationMs` is true. The window is meant to be inclusive
  ("inside one articulation window") and the same six-hop gap on
  `e815`'s stroke subtracts to exactly 80. A comparison in milliseconds
  on hop-quantised times is a coin toss at the edge.
- `e815` → `e816` (E5 eighths DI), "gated release (+80ms)": the contact
  at 5626.67ms, accepted on the sharpness fallback (sharpness 2.59, rise
  0.77); the release at 5706.67ms with sharpness 5.86 and rise 3.66, on a
  hop whose long-window RMS is under the gate, so `rearticulation.ts`
  returned `gated` before any witness was read and the Note kept the
  contact, 76ms early.
- `e839` → `e840`, "gated release (+91ms)": the same, 91ms after a
  contact the fine witness opened. Past the window; not this rule's.
- `e835` → `e836`, "gated release (+67ms)": the early Note is the REGION
  lane's, opened at the contact by its own segmentation; the fast lane
  never opened anything there, so a fast-lane release test cannot reach
  it.
- `e830` → `e831`, "in window but unmoved": the fine witness delivered the
  contact at 9397ms on a frame after the release (a band-only onset at
  9466ms, rise 3.96) had already passed; the Note was opened backdated
  onto a contact whose release was history.
- `a3` → `a4` (quarters DI), "in window but unmoved": region-lane Notes
  throughout that passage; the fast lane refuses every contact there at
  the ring-out branch (`ring-out-below-floor`).

So of the "3 + 1 + 2" the row named, two are reachable at the release
test: `e851` by the window and `e815` by the gate.

### The falsifier, stated before the pipeline ran

Derivation slow DI split 30 → 28, those two labels; derivation missed and
false positives not up; amped and mic takes not worse; held-out read once
after. Nothing to sweep: the key is a boolean and the window has no
constant.

### What was built

`tracking.releaseOnGatedHop` (true; false is DECISION-046's test as
shipped). In step (a) of the tracker, after the unsettled release test:
when the verdict was `gated`, the Note is unsettled, and `isRelease` holds
— contact-opened, unannounced, inside the window, rise over the bar — the
start moves to the attack, traced as `released` via `gated`. Nothing
opens: the amplitude gate exists to stop the fast lane opening a Note on
room tone, and this reads a rise, a ratio over the muted string, in a Note
that is already open and has not been announced. And `isRelease` now
measures its window in samples, `clock.durationSamples(articulationMs)`
against `attack.atSample - startSample`, so six hops is inside.

Two tests on a synthesized stroke whose release begins under the gate: the
first note decaying slowly enough to be over the gate when the pick lands,
a soft contact click over a string damped to a hundred-and-twentieth, a
release that speaks at a quarter of its level for 20ms before the string
reaches it, and room noise so the measured floor puts the gate at
`analysis.rmsGate`, raised to 0.03 for the test. Getting a synthetic
release under the gate while still rising twofold over its own contact hop
took most of the iteration: the rise witness's 80ms baseline and the
release window are the same six hops, so the contact's own hop is always
in the baseline, and a release loud enough to clear the bar over it is
usually loud enough to clear the gate. The real stroke does it because the
direct input's gate sits at the measured floor times 200, under the fixed
cap, and the string under the pick is very quiet.

### Numbers, before → after (derivation predicate "not 140bpm")

    slow subset      DI 30 → 29 of 327 (E5 eighths DI 9 → 8); amped + mic 152 → 152 of 334, bit-identical per take
    corpus (deriv)   split 219 → 218, extras 271 → 270, strays 9, missed 114 → 114, fp 211 → 211, det 1308; |onset| med 25 → 23
    window alone     the same 29 (`e851`); the gated path adds no label to the count and moves two boundaries
    held-out (once)  identical on every line: split 70, extras 75, fp 66, missed 27, det 420
    corpus (all)     289 / 346 / 19 → 288 / 345 / 19; slow subset 216 / 268 → 215 / 267; tail fragments 238 / 258 unchanged
    ledger MISSED    141, unchanged
    eval             PASS; tests 528 → 530

### Why 29 and not 28

`e851` fell to the window. `e815` fell to the gated path — and `e817`
rose. Trace at 5690–6260ms, off and on:

- `e816`'s Note, `n24`, moves from the contact (5626.67) to the release
  (5706.67), 3ms from its label instead of 76ms early. Every other Note in
  the chain shifts with it.
- `e817`'s contact at 5893.33ms had been refused at the ring-out branch
  (`ring-out-not-sharp`, the Note before it 253ms old) and then accepted
  at 5960ms as `ring-out-sharpness`, a settled split that the burst rule
  backdated onto the contact — the C11 shape, 57ms early. With `n24`
  younger by 80ms the same contact reaches the rolling-baseline test
  instead (`soundedMs` 173, under `ringOutMs`) and is accepted
  `sharpness`; the Note it opens is unsettled when the release arrives at
  5960ms, so DECISION-046's unsettled path moves it there. `e817`'s own
  Note now sits 10ms from its label. This is ledger row C15's coupling —
  the ring-out clock runs from the Note's start — read in the rule's
  favour for once.
- `e818`'s contact at 6122.67ms was opened by the fine witness; its
  release at 6200ms is gated and 77ms later, inside the window, but the
  Note was announced at 55ms of audible string (a fine-opened contact
  gets the plain announce bar, not the same-pitch fragment bar the
  attack-opened contact on `e816` got, 121ms), and an announced start does
  not move. Before, that Note was charged to `e817` alongside a Note that
  was not `e817`'s; now `e817`'s own Note is right and this one still
  starts 67ms early, so `e817` reads split. The chain reading from
  DECISION-049, one position along.

Three boundaries right instead of one, and the count moves by one. The
falsifier named the labels and both fell; the count it predicted assumed
the neighbour would stand still, which DECISION-049 had already said it
would not.

### Verdict

Kept. The keep rule holds with nothing against it — missed and false
positives equal, splits and extras down, the amped and mic takes and every
held-out take bit-identical — and the window comparison was a defect in
DECISION-046's rule whatever the gate does. What is left of C12: `e839`
(a gated release 91ms after a fine-opened contact, past the window),
`e830` (the fine witness delivering a contact after its release had
passed), `e835` and `a3` (region-lane Notes at the contact), and now
`e818` (a fine-opened contact announced at 55ms, before its release
arrives at 77ms). The last is the one with a mechanism in it: the
announce bar for a Note the fine witness opened on a contact.

## The release test reaches a Note the fine witness opened only on the frame that opens it, and moving that Note loses a stroke whose release barely sounded

DECISION-044's loop, iteration 7; DECISION-051. Ledger row C15 read and
closed without a build; ledger row C16 built, measured, reverted.

### C15, read on the trace: the ring-out clock coupling reads in the rule's favour on every derivation case

DECISION-049 named the coupling: `rearticulation.ts` reaches the decay-fit
branch by the Note's age from its START (`soundedMs >= ringOutMs`, 250ms),
so a start DECISION-046 moves 67–80ms later delays that branch by the
same amount, and a transient arriving in that window is read by the
rolling-baseline test instead. Row C15's first read asks how often that
happens on the four derivation direct-input takes at the shipped engine
(DECISION-050), before anything is built: every start the release test
moved, every transient in the window the move reopened, and whether its
verdict changed.

    held-then-picked DI       5 moved starts    0 transients in the reopened window
    A3 eighths DI             0                 0
    E5 eighths DI            37                23, of which 2 changed verdict
    quarters DI               5                 0

Twenty-one of the twenty-three transients get the same verdict from the
rolling-baseline test that the ring-out branch gave them. The two that
change are both on the E5 take and both change the same way: a contact
refused at the ring-out branch (`ring-out-not-sharp` at 5893ms,
`ring-out-below-floor` at 14893ms) is accepted `sharpness` once the Note
before it is 80ms younger, and the Note it opens is unsettled when its
release arrives, so DECISION-046's unsettled path moves it onto the
release. The first is `e817`, read in iteration 6; the second is `e853`'s
stroke, 14893 → 14960ms, 12ms from its label. Neither made a phantom. The row's falsifier was
the E5 and held-then-picked phantom counts falling by the number of
transients that read wrong, and that number is zero, so there is nothing
for an anchored clock to fix on derivation. Closed by the read; the
held-then-picked case at 9213ms that DECISION-049 reproduced is C11's,
reachable only if C11 is built again.

### C16, re-read: the Note was not announced before its release arrived

Row C16 said `e818`'s Note on the E5 take — opened by the fine witness on
a contact at 6122.67ms, with a gated release at 6200ms — was announced at
55ms, before the release arrived at 77ms, and that the announce bar for a
fine-opened contact was therefore the mechanism. The trace says otherwise.
The fine witness confirms an onset 65ms after it, so the contact at
6122.67ms was delivered on the frame at 6200ms: the same hop as the
release. `handleFineOnset` opens the successor backdated to the dip with
`lastAudibleAt` set to the frame, so at step (a) of that frame the Note has
77ms on its clock — settled, since `minStableMs` is 55 — and is not yet
announced, because `publish` runs at the end of the frame. DECISION-050's
gated path requires `!settled`; that condition, not the announce bar,
refused the release. A higher announce bar would have changed nothing,
since the announce comes after step (a) either way.

So the reachable mechanism is the gated path without its unsettled
requirement. `isRelease` keeps `!announced`, so in practice this reaches a
fine-opened Note only on the frame that opens it, when its release arrives
on that same hop.

### The falsifier, stated before the pipeline ran

Derivation slow DI split 29 → 28, `e817`'s charge cleared; derivation
missed and false positives not up; amped and mic takes not worse; held-out
read once after. Nothing to sweep: a boolean.

### What was built

`tracking.releaseOnGatedHopSettled` (true; false is DECISION-050 as
shipped): the condition in step (a) reads
`(!settled || releaseOnGatedHopSettled)` in place of `!settled`. A
frame-driven test constructs a `NoteTracker` on hand-made frames: 17
voiced hops of A3 opened by an attack, three gated hops, then a gated hop
carrying an attack with rise 3 and a fine onset placed 77ms back, and
asserts that the second Note starts on that gated hop with the key on and
on the fine onset's dip with it off.

### Numbers, before → after (derivation predicate "not 140bpm")

    slow subset      DI 29 → 27 of 327 (E5 eighths DI 8 → 7, quarters DI 8 → 7); amped + mic 152 → 152 of 334, bit-identical per take
    corpus (deriv)   split 218 → 216, extras 270 → 268, strays 9, missed 114 → 115, fp 211 → 210, det 1308 → 1306
    held-out         not read; the derivation result decided the iteration
    tests            533 with the frame-driven test; 530 after the revert

The path touched four Notes on derivation: the three above and one on the
held-then-picked DI take, a fine-opened contact at 96466.67ms moved 67ms
onto its release at 96533.33ms (`p6c4q2`, a provisional label that sits
100ms ahead of the contact, as iteration 2 found that take's labels do);
counts unchanged there, onset error p90 158 → 160ms.

Both labels the count credits fell for the reason predicted. `e817`: the
Note at 6122.67ms moves to 6200ms, 10ms from `e818`'s label. `e35` on the
quarters take: the contact at 34920ms (fine dip −38dB, rebound 18dB) had
its release at 34986.67ms (rise 3.75, gated) on the same frame the fine
witness delivered the contact; the release's own fine onset at 34989.3ms
(−7dB dip, 29dB rebound) was delivered at 35066ms and, with the Note still
starting at the contact, opened a second Note 69ms into the first — the
"tail phantom" the classification charged to `e35` and the scorer counted
a false positive. With the start on the release that onset is 2.7ms after
it and opens nothing: `e35` is one Note, 47ms after its label's start,
and the false positive is gone.

### The label that was lost

`e36` on the quarters DI take, 35450–35930ms, the stroke after `e35`.
Frames at the shipped engine:

    35440    gated   rms 0.0062   band onset; fine dip at 35445.3ms, −29dB, rebound 14dB
    35480    gated   rms 0.0019   the string under the pick
    35506.7  gated   rms 0.0053   rise 2.12
    35520    gated   rms 0.0069   rise 2.11, attack; the fine onset delivered on this hop
    35533.3  voiced  rms 0.0080   E5, the one hop over the gate
    35546.7  gated   rms 0.0080
    35560    gated   rms 0.0078

The gate on this take is `analysis.rmsGate`, 0.008. `e35`'s stroke peaked
at 0.017; this one's release re-excited the string to 0.008 and stayed
there, so the string sounds through the whole label and the gate hears one
hop of it. Before the change the Note was born at the contact with 75ms on
its clock, announced, matched `e36` by 5ms, and ended at 35546.67ms. With
the change the start moves to the release at 35520ms, the clock reads
13.33ms at the end of the frame, and the Note is dropped unannounced: the
release test re-decided whether the Note exists, because the announce clock
reads from the moved start. That is a mechanism, not a coincidence, and it
is the same mechanism on every stroke this path can reach: a fine-opened
Note on its birth frame has exactly the frame's audible time after the
move.

One thing about the label, for the owner's listening list and not for
editing here: `e36`'s label sits 5ms from the contact and 70ms before the
release. Every other same-pitch direct-input label probed in this loop sat
on the release within 6ms (the held-then-picked labels are the separate case
iteration 2 named). On this stroke the release is the quietest thing in
it.

### Verdict

Reverted: missed rose by one and the keep rule has no exception for a
count that would be 27 on the release positions. The engine is
DECISION-050's, bit-identical; the test went with the key it tested. The
write-up is the product, and it names the next mechanism: the move must
not re-decide the Note. The fine witness decided that when it delivered a
contact and the tracker opened a Note born settled on it; the gated
release relocates that Note's boundary, and its announce clock can keep
reading from the contact (`ownStartTime`, the way `announceSoundedMs`
already reads a different start than `startTime` for a Note that absorbed
a stub). On derivation that is this change plus `e36` regained — the Note
would start at 35520ms and end at 35546.67ms, inside the label, matched on
overlap — and what it risks is a contact whose release is a gated hop with
a rise and nothing sounding after it, announced where it now dies. Ledger
row C17, with that count as its falsifier.

## The release moves a Note the fine witness opened without re-deciding it: the announce clock stays on the contact

DECISION-044's loop, iteration 8; DECISION-052. Built, measured, kept.
Ledger row C17: the gated release on a fine-opened Note keeps the
announce clock on the contact.

### The shape

Iteration 7 (DECISION-051) read the path and named the loss. A contact
the fine witness delivers arrives 65ms after the audio it describes, so it
can land on the same hop as the pick's release; `handleFineOnset` opens
the Note born settled on that frame, `publish` has not yet run, and
DECISION-050's release test — unsettled Notes only — refused it. Reading
the test on that Note moved two boundaries right (`e817` on the E5
eighths DI take, `e35` on the quarters take) and lost `e36`: a stroke
whose release re-excited the string only to the gate's own level, so that
the Note had 75ms on its announce clock born at the contact and 13.33ms
started at the release, and was dropped unannounced. The move re-decided
the Note, because `announceSoundedMs` reads from `startTime`.

The mechanism is the separation of two quantities the record already
keeps apart for a different move. `ownStartTime` is where the Note was
created; `startTime` is where it is reported to begin; `announceSoundedMs`
reads from `ownStartTime` when the Note absorbed a stub a pitch step shed,
so audio that belongs to the note before does not count toward this one's
bar. Here the direction is the reverse and the argument is the same: the
muted stretch between the contact and the release is this stroke's — the
pick landed, the string sat under it, the pick let go — and the witness
that opened the Note read the contact and decided a stroke had begun. The
release relocates the boundary. It does not get to say whether the stroke
happened.

### The falsifier, stated before the pipeline ran

Derivation slow DI split 29 → 27 (`e817`, `e35`) with missed 114 → 114
(`e36` regained on overlap, its Note inside the label); false positives
and extras not up; amped and mic takes not worse; every Note the rule
newly announces — moved on its birth frame and dead unannounced without
the clock — counted on the derivation takes, each matched to a label or
charged as a false positive; held-out read once after. Nothing to sweep:
a boolean.

### What was built

`tracking.releaseOnFineOpenedFrame` (true; false is DECISION-050 as
shipped). In step (a) the gated release test reads
`(!settled || (fineOpened && releaseOnFineOpenedFrame))`; `isRelease`
keeps `!announced`, so a fine-opened Note is reached on its birth frame
only. When the move is on a settled Note the record's new
`releasedFromContact` is set, and `announceSoundedMs` reads from
`ownStartTime` for it, as it does for `absorbedRenaming`. `soundedMs`,
which `settled` and the ring-out clock read, still reads from the moved
start: the Note is unsettled for 55ms after the move, which changes
nothing it can reach, since it is announced at the end of the frame.

Four frame-driven tests on a `NoteTracker` fed by hand: a note, three
gated hops for the pick landing, a gated hop carrying the release's rise
and the fine witness's contact 77ms back, then the string. With nineteen
voiced hops after the release the second Note starts on the release hop;
with ONE voiced hop it still starts there and is still announced — the
test that fails with the clock line removed; with the key off the second
Note starts on the contact, as DECISION-050 shipped it.

### Numbers, before → after (derivation predicate "not 140bpm")

    slow subset      DI 29 → 27 of 327 (E5 eighths DI 8 → 7, quarters DI 8 → 7); amped + mic 152 → 152 of 334, bit-identical per take
    corpus (deriv)   split 218 → 216, extras 270 → 268, strays 9, missed 114 → 114, fp 211 → 210, det 1308 → 1307
    moved Notes      4 on their birth frame (E5 1, quarters 2, held-then-picked 1); 1 newly announced (`e36`'s, matched); 0 false positives from them
    held-out (once)  identical on every line: split 70, extras 75, strays 10, missed 27, fp 66, det 420
    corpus (all)     288 / 345 / 19 → 286 / 343 / 19; slow subset 215 / 267 → 213 / 265
    ledger MISSED    141, unchanged; tail fragments 238 / 258 → 237 / 257
    eval             PASS; tests 530 → 534

The three Notes iteration 7 moved move the same way: `e817`'s to 6200ms
(10ms from `e818`), `e35`'s to 34986.67ms (the release's own fine onset
at 34989.3ms then opens nothing, so the phantom charged to `e35` and
counted a false positive is gone), and the held-then-picked contact at
96466.67ms to its release. `e36`'s Note starts at 35520ms, is announced
with 88ms on the clock from the contact, and ends at 35546.67ms, inside
its label; the matcher credits it on overlap, 70ms after the label's
start — the label sits on the contact, which DECISION-051 noted for the
owner's listening list.

### Verdict

Kept. Every keep line holds with nothing against it: missed equal on both
sets, false positives down one, splits and extras down two, amped, mic and
held-out bit-identical. What the count still holds on the direct-input
column, 27 of 327: 10 phantoms, 9 refused-contact bursts (C11, blocked on
the chain reading), the region-lane contacts (`e835`, `a3`), `e839`
(release 91ms after the contact), `e830` (contact delivered after its
release), and the four with no release-shaped onset in the window.

## The region lane's envelope boundary sits at the start of the window that noticed the rise, and the transient inside that window is as often the mute as the release

DECISION-044's loop, iteration 9; DECISION-053. Built, measured, reverted.
Ledger row C18, added and spent in the same iteration: an envelope-rise
boundary placed on the fast lane's transient inside the window that
noticed the rise.

### The shape, read at the seven direct-input sites the fast lane never placed

After iteration 8 the direct-input column holds 27 slow splits on the
tuning takes. Seven of them the classification files as "no
release-shaped onset in the window", "release in window but unmoved" or
"weak release"; at each the trace, the frames and the FINAL Notes were
read around the NEXT label, since the split instrument charges a label
with the Note of the label after it opening early.

- `a2`, `a4`, `a15` (quarters DI) and `e825` (A3 eighths DI): the early
  Note is the region lane's. The fast lane refused the contact at the
  ring-out branch or never saw a transient at it (the mute begins as a
  fall, not a flux), and the final Note starts 55–63ms before its label,
  at the mute's onset — `a4`: Note 3427ms, mute from 3427ms, the fast
  lane's transient at 3466.67ms (rise 2.00, ungated), label 3490ms.
- `e831` (E5 DI): a fine-opened contact at 9397ms delivered at 9466.67ms,
  one hop after the burst's first attack at 9453ms (rise 1.84, under the
  bar); on the birth frame the rise is 3.96 and the attack is null, so
  DECISION-052's path has nothing to read.
- `e825` (E5 DI): a contact-opened Note whose release's rise is 1.98
  against a bar of 2.
- `p1c1q2` (held-then-picked DI): the label sits 48ms after the string
  spoke; that take's labels are the review list's.

The four region-lane cases share one mechanism, in `resegment.ts`. An
envelope boundary is placed at `boundarySample(window)`, the START of the
first 85ms window whose RMS clears `segmentRiseRatio` over the trough,
which the file calls the earliest defensible estimate because a boundary
placed late gives the new event its predecessor's frames. On a same-pitch
stroke on a direct input that window begins in the mute, so the boundary
lands 45–65ms before the string sounds. The fast lane's transient at the
release sits inside that same window, and the file's own `attack` branch
("the boundary is the transient, not the window that noticed it") never
reaches it, because the envelope branch is tested first and the `attack`
branch only reads a transient in the 21ms hop before the window's start.

### The falsifier, stated before the pipeline ran

Derivation slow DI split 27 → 23 or fewer, naming `a2`, `a4`, `a15`,
`e825`; derivation missed, false positives and extras not up; amped and
mic takes not worse, since the deep lane runs on every take; held-out read
once after. Nothing to sweep: a boolean.

### What was built

`deep.segmentRiseOnTransient` (true; false is the segmentation as
shipped), carried into `SegmentOptions` as `riseOnTransient`. When the
envelope branch fires, the boundary becomes the first transient the fast
lane recorded inside the window — the `proposed` one in the hop before
its start, else the first in `(start, end]` — with kind `attack`; with no
transient there, the window's start as before. Two tests on a handwritten
sequence: a decaying note, four windows in the trough, the rise, and a
transient 25ms into the window that notices it; the boundary sits on the
transient with the rule and at the window's start without it or without
the transient.

### Numbers, before → after (derivation predicate "not 140bpm")

    slow subset      DI 27 → 34 of 327; amped + mic 152 → 152 of 334, bit-identical per take
    corpus (deriv)   split 216 → 224, extras 268 → 276, strays 9, missed 114 → 109, fp 210 → 220, det 1307 → 1322
    per take         quarters DI split 7 → 8, fp 3 → 5; E5 eighths DI split 8 → 10, missed 8 → 5, fp 2 → 5; A3 eighths DI split 6 → 9, missed 63 → 61, fp 4 → 7; held-then-picked DI split 8 → 10, fp 5 → 7
    held-out         not read; the derivation result decided the iteration
    tests            536 with the two tests; 534 after the revert

`a4` moved as designed, 3427 → 3466.67ms, 23ms from its label. Five
labels came back: three sixteenths in the E5 take's runs (`s1673`,
`s1683`, `s1696`), where boundaries on transients cut a run into Notes
that match, and two on the A3 take. Ten Notes appeared that match nothing:
four of 93–96ms (`n39` at 18920ms on the quarters take, `n60` at 10893ms
and `n90` at 16144ms on the E5 take, `n49` at 40400ms on the
held-then-picked take) and six of 227–386ms.

### Why: the list the region lane reads has no rise on it, and half of it is the mute

`NoteTracker.attackSamples`, which the deep lane receives as
`attackSamples`, records every hop on which the fast lane saw energy
arrive — a broadband attack OR the band-only witness (`FastFrame.bandOnset`),
deliberately, so a quiet upstroke the fast lane may not act on is still a
proposal. On a direct-input same-pitch stroke the band witness fires at
the MUTE's onset: the frames at `a15` carry `band` at 8960ms, the
mute's first hop, and at `e831` at 9400ms; and the burst's first
broadband attack is often the contact (`e837` at 10983ms:
`no-energy-not-sharp`, rise 0.56). The first transient inside a window
that begins in the mute is therefore the mute or the contact as often as
the release, and a boundary placed there leaves `minSegmentMs` (90ms) of
muted string as a Note: the four 93–96ms extras, one of them at `e837`'s
contact, the C11 shape seen from the region lane. The six longer extras
are boundaries moved onto a transient that was not the rise's — inside an
85ms window over a sixteenth run at 120ms a stroke, the window that
notices one release can hold the next stroke's contact — and each
regained sixteenth cost an extra somewhere else in the same run.

The rule read the right witness and picked the wrong sample. The transient
list carries samples only; the fast lane knows each transient's rise
(`riseRatio` on the `onset` trace event, broadband or band-only) and does
not pass it on.

### Verdict

Reverted: split, extras and false positives all up, the amped and mic
takes untouched, five labels regained against ten extras. The engine is
DECISION-052's, bit-identical. What the write-up names as the next
mechanism (ledger C19): the transient list carries each transient's kind
and rise, and an envelope boundary is placed on the first BROADBAND
transient inside its window whose own rise clears the release bar
(`tracking.releaseRiseRatio`), else the window's start. On the four sites
that reads `a4`'s release (rise 2.00) and not the band-only mute onset at
`a15`; on `e837` it reads past the contact (0.56) to the release (3.41).
Its falsifier is this iteration's numbers with the ten extras absent.

## The region lane's boundary on the transient that rose: right where it reaches, unseen by the count, and short of three sites by one hop

DECISION-044's loop, iteration 10; DECISION-054. Built, measured, reverted.
Ledger row C19: the transient list carries each transient's witness and
rise, and an envelope-rise boundary is placed on the first broadband
transient inside its window whose rise clears the release bar.

### The falsifier, stated before the pipeline ran

Derivation slow DI split 27 → 23 or fewer, naming `a2`, `a4`, `a15`
(quarters DI) and `e825` (A3 eighths DI); missed, false positives and
extras not up; iteration 9's ten extras absent; amped and mic takes not
worse; held-out read once after. Nothing to sweep: the bar is
`tracking.releaseRiseRatio`, already fixed.

### What was built

`RegionTransient` in `contracts.ts` — sample, broadband or band-only, and
`FastFrame.riseRatio` on the hop that carried it. The tracker keeps it
beside `attackSamples` (`attackRises`, `transientsIn`), the engine passes
it on both region-request paths as `DeepRegionRequest.transients`, the deep
lane merges it by sample and hands it to `segmentRegion` with
`transientRiseRatio` = `tracking.releaseRiseRatio`. Under
`deep.segmentRiseOnRisingTransient` (true; false is the segmentation as
shipped) the envelope branch places its boundary on the first broadband
transient from the hop before the window's start to the window's end whose
rise clears the bar, kind `attack`; with none, the window's start as
before. Two tests on a handwritten sequence with three transients inside
the noticing window — the band-only mute onset (rise 0.4), the contact
(broadband, 0.7), the release (broadband, 2.4) — read the release, and the
window's start with the rule off or with the release removed.

### Numbers, before → after (derivation predicate "not 140bpm")

    slow subset      DI 27 → 27 of 327 (E5 eighths DI 7 → 6, A3 eighths DI 5 → 6, quarters DI 7 → 7); amped + mic 152 → 152 of 334, bit-identical per take
    corpus (deriv)   split 216 → 217, extras 268 → 269, strays 9, missed 114 → 111, fp 210 → 210, det 1307 → 1310
    held-out         not read; the derivation result decided the iteration
    tests            536 with the two tests; 534 after the revert

Iteration 9's ten extras are absent; the four 93–96ms stubs and the six
longer ones alike. Three labels came back (`s1683` on the E5 take,
`e856` and `s1699` on the A3 take). One extra Note appeared.

### What moved, read on the segments and the final Notes

`a4` moved as designed. The region 2040–4013ms carries two transients in
the noticing window, the release at 3466.67ms (broadband, rise 2.0041) and
a fine-onset entry at 3472ms (no rise recorded), and the segmentation reads
`attack@3467` where it read `energyRise@3427`; the final Note is
3467–3907ms, 23ms from its label where it was 63ms. `e836`'s Note moved the
same way and `e835` is no longer charged. The count does not move for the
reason DECISION-049 and DECISION-051 named: `a4`'s own Note, now inside
`a4`'s span, shares it with `a5`'s Note, which starts 78ms early and
always did, so the charge moves from `a3` to `a4`; on the A3 take
`e856`'s regained Note starts 47ms before its label and is charged to
`e855`. Two boundaries right, two charges moved along the chain, the
column reads 27.

`a2`, `a15` and `e825` did not move, and the frames say why: the rise
witness reads the long window, which lags the flux by one hop, so the hop
that carries the transient reads the rise of the hop before it. `a2`: the
transient at 2520ms carries rise 1.03 and the next hop 2.67. `a15`: 9000ms
carries 0.91, the next hop 2.00. `e825`: 7973.33ms (gated) carries 1.68,
the next hop 4.35. `a4` moved because its transient's own hop happened to
read 2.0041. The release's rise belongs to the transient one hop before
it.

The extra Note is a duplicate. On the A3 take the region 32040–32533ms
reads `attack@32293` on a transient at 32293.33ms (broadband, rise 2.18)
where the fast lane's own Note `n135` already starts, at 32293.33ms; the
segment is carved as a new Note, `n137` 32293–32531ms, beside the one it
duplicates, and `s1699` is credited by the duplicate. `splitAtSegments`
takes `from = max(segment.from, record.startTime)` and never asks whether
another Note already begins there; before this rule an envelope boundary
was a window start and never coincided with a fast-lane boundary, so the
question never arose.

### Verdict

Reverted: extras up by one, the slow DI count unchanged, and the keep
rule reads those before it reads the two boundaries that are right. Two
rows for the ledger. C20: the transient's rise is the larger of its own
hop's and the next hop's, since the long-window rise lags the flux by one
hop; on the three unmoved sites that reads 2.67, 2.00 and 4.35. C21: a
carved segment whose start coincides with a Note that already begins
there — within a hop — is not a new Note; the region lane's verdict is the
existing boundary, and `splitAtSegments` should merge with it rather than
carve beside it. Each names this iteration's site as its reproduction.

And one thing the loop's instrument owes its owner. Three iterations have
now placed boundaries right and read flat or worse because
`measure-splits.ts` charges a Note that starts more than 40ms before its
label to the label before it, so on a passage where every Note opens
early — the direct-input same-pitch takes, exactly the material this loop
exists for — fixing one boundary moves the charge to its neighbour, and
the column cannot fall until every boundary in the chain is right at once.
Charging a Note to the label whose start it is nearest to, or to the label
it overlaps most, would read each right boundary as one fewer split. That
is a change to the instrument, so every number in the journal moves with
it, and it is the owner's call, not this loop's.

## The region lane's boundary on the transient that rose, read one hop late, and a carve that sees every Note: six boundaries right, seven duplicates gone, one site short by 0.003

DECISION-044's loop, iteration 11; DECISION-055. Built, measured, kept.
Ledger rows C20 and C21, built together as iteration 10's write-up said
they would be if C20 alone reproduced the duplicate. It did.

### The falsifier, stated before the pipeline ran

C20: derivation slow DI split 27 → 24 or fewer with `a2`, `a15`, `e825`
and `a4` each within 40ms of their labels; missed 114 → 111 or fewer
kept; false positives not up; extras not up; amped and mic not worse;
the A3 duplicate at 32293ms named. C21, if built: the duplicate absent,
derivation extras not up, no label a fast-lane Note already matched
lost. Held-out read once after, for the pair.

### What was built

The rise. `RegionTransient.riseRatio` is now the larger of the rise on
the transient's own hop and the rise on the hop after it: the tracker
keeps the newest entry as `pendingRise` and folds the next frame's
`riseRatio` into it before that frame's onset block runs, so the region
request placed on the transient's own hop still carries the lagged
reading when the deep lane comes to segment. Everything else is
DECISION-054's build under the same key,
`deep.segmentRiseOnRisingTransient` (true; false is the segmentation as
shipped). One frame-driven test on the tracker
(`region-transients.test.ts`) reads three transients back with their
witness and rise, the band-only one at 0.4 and the broadband one at
2.67 from the hop after it; the two segmentation tests of iteration 10
stand.

The carve. When the region lane would carve a successor out of the last
few tens of milliseconds of a Note (`carveAfter`), it now looks at every
Note the tracker still holds — the region's own candidates, the open
Notes, the closing Notes and the ended ones — and if one already begins
within a hop of the boundary it carves nothing, because the fast lane put
that boundary in and the region agrees with it. Before, the scan saw the
candidates and the open Notes only, and a Note that began inside the
region and was still sounding past its edge was out of sight: the
region reaches only as far as the last Note that ended inside it.
`deep.regionCarveSeesEveryNote` (true; false is the carve as shipped).
Two reconciliation tests: two Notes back to back, the second opened by
the fast lane on the hop the first ended, a region ending before the
second does, and its boundary a hair before the first Note's end, which
is what converting a sample to milliseconds does — nothing carved with
the key on, the duplicate carved with it off.

### Numbers, before → after (derivation predicate "not 140bpm")

    slow subset      DI 27 → 21 of 327 (A3 eighths DI 5 → 1, E5 eighths DI 7 → 6, quarters DI 7 → 6, held-then-picked DI 8 → 8); amped + mic 152 → 149 of 334 (A3 eighths amped 36 → 35, E5 eighths amped 24 → 22)
    corpus (deriv)   split 216 → 206, extras 268 → 257, strays 9, missed 114 → 112, fp 210 → 203, det 1307 → 1302
    by key           rise alone 24 / 152, split 214, extras 266, missed 110, fp 210; carve alone 24 / 149, split 209, extras 260, missed 115, fp 203; both off bit-identical to DECISION-052's engine
    held-out         split 70 → 71, extras 75 → 76, strays 10 → 11, missed 27 → 27, fp 66 → 69, det 420 → 423 (read once, after)
    corpus (all)     split 286 → 277, extras 343 → 333, strays 19 → 20; ledger MISSED 141 → 139
    eval             PASS; required 0 failures; informational the one pre-existing

### What moved under the rise, read on the segments and the final Notes

Four region-lane boundaries moved onto their releases, and the charges
on `a1`, `a3`, `e824` and `e835` cleared: `a2` (2520ms, rise 1.03 on its
hop and 2.67 on the next), `a4`, `e825` (7973ms, 1.68 then 4.35) and
`e836`. One charge moved along the chain, as DECISION-054 said it would:
`a4` is now charged, because `a5`'s Note starts 78ms early on a refused
contact (C11) and always did, and `a4`'s own Note, now inside its label,
ends where `a5`'s begins. Missed 114 → 110 under the rise alone: `e856`
and `s1699` on the A3 take, `s1673` and `s1683` on the E5 take, each a
Note where the region's boundary now stands.

`a15` did not move. Its transient at 9000ms reads 0.91 on its own hop and
1.997 on the next, against a bar of 2 (`tracking.releaseRiseRatio`, the
release bar, reused unchanged); the hop after that reads 2.05. The
falsifier named four sites and three moved. The site is on the ledger
(C24, the rise read over the two hops after the transient) rather than
answered by a lower bar: a bar under the release bar reads the contact
before it reads the lagged rise (DECISION-053's stubs).

The duplicate reproduced, and its cause is not what DECISION-054 said.
`n134` (32040–32293.333333333336ms) owns the boundary at
32293.333333333332ms by four picoseconds, so the reconciliation takes the
carve branch; `carveAfter` scans the region's candidates and the open
Notes for a neighbour, and `n135`, which the fast lane opened at
32293.33ms and which ends at 32547ms, past the region's edge at
32533ms, is neither. The successor already standing there was out of
sight, and a second one was carved beside it. Not `splitAtSegments`,
which the ledger row named.

### What the carve rule removed, on the shipped path too

The carve's blindness predates this loop. With the rise off, letting the
carve see every Note changes four derivation takes, all for the better,
and every change is a Note that began within a hop of another:

    A3 eighths DI     three pairs (2291|2293, 4315|4320, 5773|5787ms): fp 4 → 1, split 6 → 2; the three "tail phantom" splits on `e82`, `e810`, `e816` were these
    E5 eighths amped  two pairs (12917|12920, 15672|15680ms): fp 27 → 25, split 29 → 27
    quarters amped    one pair (30197|30200ms): fp 69 → 68
    A3 eighths amped  one carve (5480–5707ms) beside a Note that ended past the region's edge: fp 42 → 41, split 55 → 54

No label on those takes is lost by it except one, and that one is the
rule working. `s161` on the A3 DI take, 20011ms: the fast lane opened a
Note on the attack at 20026.67ms that read A5 for two hops (885 then
553Hz on an A3), a pitch change opened the A3 Note at 20053.33ms and the
27ms stub died unannounced without lending its start; the region then
carved an A3 Note from 20024ms to 20253ms, wholly overlapping the one at
20053ms, and that duplicate credited the label. The carve now sees the
Note 29ms after its boundary and carves nothing, and the A3 Note starts
42ms after its label. The right fix is the stub's start, not the carve:
ledger C22.

### Held-out, read once

    lead-line-di-quarter-eighth-triplet   split 8 → 10, extras 9 → 11, fp 8 → 10 — the rise
    power-chords (mic)                    strays 3 → 4, fp 7 → 8 — the rise
    lead-line-di-sixteenths               missed 2 → 1 — the rise
    lead-line-amped-sixteenths            split 5 → 4, extras 7 → 6, missed 12 → 13 — the carve

Attributed on the four-way listing of the final Notes at each site, not
on a second read of the totals. The rise's three new Notes: on the DI
triplet take, two 91–94ms Notes of no pitch between a note's end and the
next stroke's release (5693–5787ms before the D5 at 5787ms, 6989–7080ms
before the A4 at 7080ms), the level under them fallen to 1% — the string
under the hand, which the shipped engine carved just the same and then
absorbed into the following Note as its contact stub, and which the
candidate declines as a prefix of no pitch (`prefix:unpitched`); and one
A#4 Note, 25427–25541ms, in the noise after the power-chord mic take's
last chord. The rise's one label regained, `s6` on the DI sixteenths
take, is a Note at the right time (4293ms against 4269ms) that the
recognizer names B3 where the label says F#5. The carve's one label lost,
`s44` on the amped sixteenths take, was credited by an E5 Note carved at
8464ms beside the fast lane's F#5 at 8467ms — 150ms after the label
began and 8ms after it ended — and the labels there say F#5 from 8456ms.

### Verdict

Kept, on the derivation rule: the slow subset better on both paths and
worse on neither, extras down, missed down, eval PASS. The held-out cost
is three false positives and one label, against one label regained, and
is the owner's to weigh at review as iteration 2's was. Three rows for
the ledger: C22 (a stub the pitch tracker split off the first hops of an
attack lends its start to the Note the pitch change opened), C23 (a
carved prefix of no pitch between a note's end and the next stroke's
release is offered to that stroke as its contact stub, the way the fast
lane offers one — read on the tuning takes first, since its sites are
held-out), C24 (the rise read over the two hops after the transient).

## The octave stub read and the rise read two hops out: nothing for the direct input in either, and `a15`'s boundary was never the envelope's

DECISION-044's loop, iteration 12; DECISION-056. One candidate falsified
on the bench without a build, a second built, measured and reverted.
Ledger rows C22 and C24.

### C22, the octave stub, read on the tuning takes

The falsifier, stated first: on the tuning takes, the unannounced stubs an
attack opened and a pitch change ended within three hops, counted with
their pitch against the successor's; then `s161` regained at +0
derivation missed with false positives not up.

The count (`stubs.ts`, all thirteen derivation takes): 101 such stubs.
82 read the successor's pitch or its octave on their first hops (21
octave, 61 the same class) and 19 something else; 61 of the 101 are 27ms
long, 29 are 0–13ms, the rest 40ms. Of the successors that matched a
label, 21 start more than 40ms after it, and for 9 of those the stub's
own start is within 40ms of the label — all nine on amped takes (seven on
the E5 eighths amped take, one each on the A3 eighths amped and the
held-then-picked amped). On the direct-input takes the stubs are 0–13ms
and the successors on time, save two on the A3 take, and `s161` is not
regained by lending the start: the Note at 20053ms is the only Note
between 20027ms and 20267ms, and the labels there are `s161`
(20011–20117ms) and `s162` (20117–20254ms), two picks. The fast lane
opened nothing for the second, so one of the two is missed whichever the
Note is credited to; the carve DECISION-055 removed had been filling that
hole with a duplicate. Lending the stub's start would move the miss from
`s161` to `s162`. The row as stated is falsified; what remains of it is
nine amped onsets 42–77ms late that would read within 40ms, a row for the
amped column's onset error, not the direct input's, restated as C22 for a
later iteration.

### C24, the rise read over the two hops after the transient

The falsifier, stated first: `a14`'s charge cleared (`a15`'s Note within
40ms of its label at 9015ms), derivation slow DI 21 → 20 or fewer, missed
not up, false positives not up, extras not up, amped and mic not worse;
held-out read once after.

Built as `deep.transientRiseHops` (2; 1 is DECISION-055's reading):
`pendingRise` keeps reading for that many hops, and a later transient
still takes it over. One more tracker test read `a15`'s figures back —
0.91, 1.997, 2.05 — as 1.997 under one hop and 2.05 under two. 540 tests.
Swept at 1, 2 and 3 hops on the derivation takes:

    hops 1   slow DI 21/327, other 149/334, split 206, extras 257, missed 112, fp 203, det 1302
    hops 2   slow DI 21/327, other 149/334, split 206, extras 257, missed 113, fp 203, det 1301
    hops 3   identical to 2

The quarters DI take is bit-identical at every setting: `a15` did not
move. The deep lane's own reading says why. The region 8507–9680ms
carries the transient at 9000ms as broadband with rise 2.053 — the two-hop
reading worked — and the segmentation still reads `attack@8960`, kind
`attack`, not `energyRise`. That boundary was never the envelope
branch's. It is the shipped attack branch's, which reads a transient in
the hop before a window's start when the window's RMS clears
`segmentAttackRiseRatio` (1.25) over the trough, and the transient it
read is the band-only onset at 8960ms — the mute — because
`attackSamples` carries band-only onsets. DECISION-055's rule runs in the
envelope branch only and never sees this boundary. `a15` was on the
falsifier of iterations 10, 11 and 12 under the wrong premise each time;
the frames (0.91, 1.997, 2.05) were read correctly and were irrelevant.

The one label the two-hop reading costs is `t17` on the clean-lead take
(D5, 14527–14693ms): under one hop a region-lane Note 14517–14653ms
credits it; under two hops the transient before it reads a larger rise,
qualifies first, and the boundary lands where nothing survives, so the
Note in front runs to 14653ms and the label is missed. A longer reading
does not only reach the release: it also lets an earlier transient
outrank it.

Reverted; `src/` bit-identical to DECISION-055's (`git diff HEAD --
src/` empty).

### What the ledger gets

C25: the attack branch of `resegment.ts` reads a band-only onset as the
boundary's transient. On a direct-input same-pitch stroke that onset is
the mute, 40–55ms before the release. The candidate: when the transient
the attack branch reads is band-only and a broadband transient whose rise
clears the release bar sits inside the window that noticed the rise, the
boundary is the latter — the same rule DECISION-055 gave the envelope
branch, applied to the branch that actually placed `a15`'s boundary.
Reproduction: quarters DI, region 8507–9680ms, `attack@8960` on the
band-only onset, broadband 9000ms rise 1.997 (2.053 over two hops), label
9015ms. Falsifier: `a14`'s charge cleared at +0 derivation missed, fp and
extras not up, amped and mic not worse; the count of attack-branch
boundaries that stand on a band-only onset on the tuning takes, with how
many have a rising broadband transient in the window.

## The attack branch on the transient that rose: two boundaries right on the held-then-picked take, two false positives fewer, and the count reads one worse

DECISION-044's loop, iteration 13; DECISION-057. Built, measured,
reverted. Ledger row C25.

### The falsifier, stated before the pipeline ran

As the row had it: `a14`'s charge cleared at +0 derivation missed, false
positives and extras not up, amped and mic not worse; first a count of the
attack-branch boundaries standing on a band-only onset on the tuning
takes. The count came first and changed the falsifier before the sweep
ran: `a15`'s release reads 1.997 on the one-hop reading DECISION-056 left
in place, under the bar of 2, so the rule cannot reach it, and the
falsifier became the column — derivation slow DI 21 → 20 or fewer, missed,
false positives and extras not up, amped and mic not worse.

### What was built, and what the count said

`deep.segmentAttackOnRisingTransient` (true; false is the attack branch as
shipped): when the attack branch of `resegment.ts` places a boundary — on
the transient in the hop before a window whose RMS clears
`segmentAttackRiseRatio` over the trough — and a broadband transient
whose rise clears `tracking.releaseRiseRatio` sits inside that window, the
boundary is that transient. DECISION-055's envelope-branch rule, factored
into `risingTransientIn` and applied in the second branch. Two
segmentation tests: a window clearing 1.25 and not 2 over the trough,
the band-only mute onset in the hop before it, the release inside it —
the release with the rule, the mute without it or with no rising
transient.

The count, every window the attack branch fired on across the thirteen
derivation takes, before the segment-length check: 648. 335 stood on a
band-only onset, 163 of those with a rising broadband transient inside
the window; 201 stood on a broadband transient that had itself risen
(unchanged by the rule) and 41 on a broadband contact with a rising
transient later in the window. The direct-input same-pitch takes hold
most of them (E5 eighths 46 + 11, quarters 41 + 6, held-then-picked 43 +
20, A3 eighths 16). `a15`'s window is not among the 163.

### Numbers, before → after (derivation predicate "not 140bpm")

    slow subset      DI 21 → 22 of 327 (held-then-picked DI 8 → 9); amped + mic 149 → 148 (A3 eighths amped 35 → 34)
    corpus (deriv)   split 206 → 206, extras 257 → 257, strays 9, missed 112 → 112, fp 203 → 201, det 1302 → 1300
    held-out         not read; the derivation rule decided
    tests            541 with the two tests; 539 after the revert

Two takes change of the thirteen: of the 204 windows the rule moved a
boundary in, all but two coincide with a boundary the fast lane already
has or fail the segment-length check, and the reconciliation leaves them
where they are.

### The one DI change, read on the site

Held-then-picked DI, 13300–14200ms: labels `p1c3q3` 13040–13540ms,
`p1c3q4` 13560–14035ms, `p1c4h` from 14035ms.

    before   n16 12960–13453   n17 13453–13947   n15 13947–14813
    after    n16 13013–13533   n17 13533–13947   n15 13947–14813

Two boundaries moved onto their releases: `p1c3q3`'s Note from 80ms early
to 27ms, `p1c3q4`'s from 107ms early to 27ms. Nothing else on the take
moved except one false positive gone: the 94ms Note the shipped attack
branch had carved at 17413ms on a contact, now placed on the release at
17507ms where the fast lane's own Note begins, and so not carved. The
count reads 8 → 9 because `p1c4h`'s Note starts 88ms early on a refused
contact (C11) and always did; with `p1c3q4`'s Note now inside its label,
that early start ends it 88ms short and the charge lands on `p1c3q4`,
where before the two early starts cancelled. The same chain reading as
DECISION-049, -051, -054 and -055: two right boundaries, one more split
on the count.

The amped change is one false positive fewer on the A3 eighths amped take
and one split fewer, no label moved.

### Verdict

Reverted, on the keep rule's letter: the slow subset is better on the
amped path and worse on the direct-input path. The read says the rule is
right where it reaches and the count cannot see it. No new mechanism row:
what stands between this rule and a keep is the split instrument's
forward reach, which is the owner-side item DECISION-054 raised
(decision 3 on the PR), and it now has a fourth iteration's evidence.
With C11 blocked on the same item, no open ledger row targets the
direct-input column; C13, C22 (amped onsets) and C23 (a count first) are
the amped column's and held-out sites'.
