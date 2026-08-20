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
