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

## What is left

Two shapes now. The first is `s4`/`s9`/`s11` above: the region lane can see
those events and cannot act on them, because it proposes boundaries into a
partition the fast lane already made rather than owning the partition.

The second is the one the last pass named: **the pitch path runs
about 90ms behind the transient path.** Every remaining split in the lead take
is a Note whose boundary is right and whose first hops describe its predecessor,
or the reverse. Correcting only the reported times fixes the onset error almost
completely (90ms to 36ms) and makes the labelling worse, because the boundaries
and the pitch evidence then disagree about where a Note is. Either both move or
neither does. That is a change to how segmentation works, not a constant to
tune, and it wants its own pass with the articulation tests extended first — a
Note's boundary and the frames that name it have to be derived from the same
clock.

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
