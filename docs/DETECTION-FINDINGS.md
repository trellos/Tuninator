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
rank at 0.90–1.00 while `clean-lead-120bpm` — 44% of the table, the dense
same-pitch re-picking the whole problem is about — reads 0.605. And its
score LOCATIONS shift per take even where ranking is good: recalibrating a
single threshold across takes (the LOTO logistic over the score alone)
collapses the pooled figure to 0.513, and keeping every derivation positive
admits 101 of 102 negatives. Even had the ranking bar been cleared, no
usable operating point exists on this corpus today.

### Verdict, and the state of the ledger

**The falsifier fired: 0.7157 against a bar of 0.73, with the best
hand-built witness at 0.7281 on the same rows.** Per the protocol stated
before the run: written up, logged (DECISION-017), stopped. Nothing is
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
