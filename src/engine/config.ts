/**
 * The recognizer's single tuning object.
 *
 * Successor to `core/policy.ts`, minus the thing that file existed for: modes.
 * A `Policy` was per-mode because `lead` and `chords` ran *different code* —
 * chord segmentation was driven by chord-label change, note segmentation by
 * pitch step, and a chord played in lead mode was simply never a chord. One
 * recognizer now runs the whole time, so what is left here is genuine tuning:
 * gates, ranges, window sizes and how patient the tracker should be.
 *
 * Plain data, JSON-shaped: it crosses the worklet/worker port as a structured
 * clone, so no functions and no class instances.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import type { EngineTuning } from "../types.js";

export type EngineConfig = {
  analysis: {
    minFrequencyHz: number;
    maxFrequencyHz: number;
    /** Requested fast hop; the engine snaps it to whole 128-sample quanta. */
    hopMs: number;
    /**
     * Loudest the gate may ever be, and what it was before it could move.
     *
     * The gate now comes from a measurement of the rig's own noise floor and
     * this is the ceiling on it, which makes the change one-directional: on a
     * quiet rig the detector gets more sensitive, and on a noisy one it is
     * exactly as sensitive as it always was. A gate that could rise with the
     * measurement would gate out a room mic's real playing, whose signal sits
     * far closer to its floor than a direct input's does.
     */
    rmsGate: number;
    /**
     * How far above the measured noise floor the gate sits.
     *
     * Derived on the five 120bpm fixtures by sweeping downward until one of
     * them moves; see `NoiseFloorTracker` for what is being measured and why an
     * absolute level cannot do this job.
     */
    rmsGateNoiseMultiple: number;
    /** Quantile of frame RMS the noise floor tracks. */
    noiseFloorQuantile: number;
    /** Step size per hop of the noise-floor tracker, in log units. */
    noiseFloorRate: number;
    /**
     * Level the noise-floor estimate never goes below.
     *
     * Digital silence is not a rig. Without this, a take that opens on a
     * stretch of true zeros would derive a gate of zero and then hear the first
     * speck of dither as playing.
     */
    noiseFloorMinimum: number;
    confidenceGate: number;
  };

  pitch: {
    /** Long YIN window, in samples. Sized for two periods of low E (82.4Hz). */
    longWindow: number;
    /** Short YIN window, in samples. ~4x better time resolution. */
    shortWindow: number;
    /** Above this frequency a confident short-window result is preferred. */
    shortWindowMinHz: number;
    /** YIN absolute threshold on the CMND curve. */
    yinThreshold: number;
    /** Frames of temporal median applied before snapping to a note. */
    medianFrames: number;
    /**
     * How far behind the audio the pitch estimate runs, ms.
     *
     * A frame is stamped at the END of the window it analysed, and the temporal
     * median needs several hops to turn over, so the pitch reported at time T
     * describes audio from around T minus this. The transient path has no such
     * delay, which is why a Note that begins on an attack lands on time while
     * its pitch arrives late.
     *
     * Used to decide WHICH Note a frame's pitch is evidence about. Zero means
     * every frame votes for whatever is sounding when it arrives, which on a
     * 167ms triplet hands half of each Note's evidence to its predecessor.
     */
    voteLagMs: number;
    /**
     * A single-hop pitch jump this large reads as a new note rather than a bend.
     * Total displacement cannot separate "A3 bent up to B3" from a legato
     * D5->E5 step — both are 200 cents — only the per-hop rate can.
     */
    stepThresholdCents: number;
    /** Consecutive frames a new pitch must hold before it splits a Note. */
    stepConfirmFrames: number;
    /**
     * Pitch confidence an arriving note needs before "the pitch changed" counts
     * as evidence that an attack started a new Note.
     *
     * On a strummed chord YIN reports whichever string dominates the window and
     * flips between them freely, at low confidence throughout — there is no
     * single periodicity to find. Requiring real periodicity is what stops
     * every strum from fragmenting into one Note per string.
     */
    splitConfidence: number;
  };

  transient: {
    fluxFftSize: number;
    /** Multiplier on the adaptive median. Higher = fewer flux onsets. */
    fluxSensitivity: number;
    fluxMedianWindow: number;
    /**
     * How far back the flux reference spectrum remembers, ms.
     *
     * The kernel holds the per-bin MAXIMUM over this span and compares the
     * arriving frame against it, so unresolved low harmonics beating against
     * each other read as nothing new while a pick still reads as an arrival.
     * Long enough to cover that beating, short enough that a note ringing for
     * a second does not set the bar its own re-pick has to clear — which is
     * exactly what the decaying peak hold this replaced did. See
     * `REFERENCE_FRAMES` in `kernels/onset.ts` for the derivation.
     */
    fluxReferenceMs: number;
    /**
     * Lower edge of a SECOND, band-limited flux the detector runs alongside the
     * broadband one, Hz.
     *
     * A pick is an impulse: it puts energy across the spectrum at once. A string
     * already ringing is a handful of narrow partials, and on a guitar they are
     * almost all below 1kHz. Summing the flux over a band that holds the pick's
     * transient and not the ringing note's fundamentals is what lets a quiet
     * pick be heard over a loud sustain, which is the whole of the
     * alternate-picking problem: at 140bpm the upstrokes fall 107ms after the
     * downstroke they answer and are far quieter than it.
     *
     * Both edges and the floor were derived on the five 120bpm fixtures alone,
     * by sweeping them together and reading the raw onset coverage of the 78
     * labels against the fraction of off-label hops that fire. The chosen point
     * is the highest coverage available at an off-label rate no worse than the
     * broadband detector's, and it is a local optimum in all four directions:
     *
     * ```
     *   band \ floor      0.10           0.09           0.08           0.07
     *   0-24k broadband 88.5%/6.27%    92.3%/7.10%    94.9%/8.40%    94.9%/9.93%
     *   750-6000        91.0%/5.07%    92.3%/5.53%    93.6%/6.02%    93.6%/6.88%
     *   1000-6000       89.7%/4.11%    91.0%/4.46%  * 93.6%/4.99% *  93.6%/5.43%
     *   1250-6000       89.7%/3.82%    92.3%/4.16%    92.3%/4.45%    92.3%/4.94%
     *   1000-24000      91.0%/4.58%    92.3%/4.89%    93.6%/5.51%    93.6%/6.09%
     * ```
     *
     * Two things in that table matter more than the winning cell, and they are
     * why this band can be chosen honestly where the highpass tried before it
     * could not. Coverage has an interior maximum in the LOWER edge — it climbs
     * to 1000Hz and falls again by 1500 — and raising the UPPER edge past 6kHz
     * never buys a single label, it only costs off-label firing. A highpass has
     * neither property: its edge could be raised indefinitely and the room-mic
     * takes kept improving, because a mic take here is 28% of its magnitude
     * above 12kHz where every direct input in the corpus is 0.2%. A band that
     * stops at 6kHz cannot win by measuring hiss, and the sweep says it does
     * not want to.
     */
    attackBandLoHz: number;
    /** Upper edge of that band, Hz. See `attackBandLoHz`. */
    attackBandHiHz: number;
    /**
     * Threshold floor for the band flux, as a multiple of the frame's own
     * in-band magnitude.
     *
     * This is the term that actually decides an onset — not the adaptive
     * median. Instrumented over every labelled attack in the five 120bpm
     * fixtures, `fluxSensitivity * median` is the binding term at two of
     * clean-lead's 43 labels and at none of the other four fixtures': the
     * median runs an order of magnitude below the relative floor. So the onset
     * test in practice reads "did more than this fraction of the frame's
     * magnitude arrive as new energy", and a quiet upstroke landing on a loud
     * ringing note is measured against a bar the ringing note sets. The band is
     * what pays for lowering the bar.
     */
    attackBandFloorFactor: number;
    /** Minimum interval between accepted attacks, ms. */
    minIntervalMs: number;
    /** RMS window for the envelope-rise test, ms. */
    envelopeWindowMs: number;
    /** Baseline the envelope-rise test measures against, ms. */
    envelopeBaselineMs: number;
    /** Rise over that baseline that counts as an attack on its own. */
    envelopeRiseRatio: number;
    /**
     * Rise a *flux* onset additionally needs before it is allowed to start a
     * new Note over a sounding one. Spectral flux fires on more than attacks:
     * as a note decays the adaptive median falls with it, so ordinary sustain
     * ripple keeps clearing the threshold and halves the note. A real re-pick
     * puts energy back into the string, which is what this tests for.
     *
     * Re-derived once the region lane began acting on transients the fast lane
     * had recorded and refused. Swept downward on the five 120bpm fixtures
     * until one of them moves: they are bit-identical at 1.2 and `clean-lead`
     * sheds three false positives at 1.15. This is the most sensitive setting
     * that material supports, which is the right side to err on — a played
     * note that never appears cannot be recovered later, an extra one can.
     */
    rearticulationRiseRatio: number;
    /**
     * Transient sharpness (flux / RMS) at which an attack counts as a genuine
     * re-articulation even though it is no louder than what it interrupts.
     * A muted upstrum over a ringing chord is exactly that case.
     *
     * Swept downward on the five 120bpm fixtures until one of them moves: they
     * are bit-identical at 0.65 and `spicy-chords` sheds two false positives at
     * 0.60. Four of the picks the sixteenths run loses on a direct input sit
     * between 0.60 and 0.68 on this figure.
     */
    rearticulationSharpness: number;
    /**
     * Transient sharpness a re-strum needs over a *ringing chord*.
     *
     * Higher than `rearticulationSharpness`, and the only energy-independent
     * witness available there, because a chord's decay makes every level-based
     * test unreliable. Measured on the fixtures: genuine strums sit at 0.9 and
     * above (median 2.4 on the cowboy take), while most fragments a ringing
     * chord sheds top out just above 1.1.
     */
    restrumSharpness: number;
    /**
     * How far above the flux kernel's own adaptive threshold a transient must
     * stand before a *sharpness-only* re-articulation is believed.
     *
     * The companion to `restrumSharpness`, and the reason that constant no
     * longer decides anything on its own. Sharpness is spectral flux over the
     * frame's RMS, which is independent of how loud the passage is but not of
     * what the signal path did to it: a room mic and an amp sim leave far more
     * steady-state spectral churn behind than a direct input does, so the same
     * figure means "a pick hit a string" on one path and "nothing happened" on
     * another. Measured across the corpus, the sharpness of attacks that land
     * on no labelled event runs 0.46 on the clean 120bpm takes and 1.37 on the
     * amp-sim ones, which straddles any fixed threshold that could be chosen.
     *
     * This is measured against the signal's OWN recent flux instead — the
     * kernel's threshold is a running median of the last seventeen hops — so it
     * reads the same on every path. Derived on the 120bpm fixtures, where the
     * two muted upstrums this escape exists for measure 1.58 and 1.78 while
     * sustain ripple that has just cleared the onset threshold sits, by
     * construction, a hair above 1.0.
     */
    restrumFluxRatio: number;
    /**
     * How long a single Note must have sounded before its own decay curve is
     * allowed to veto a re-articulation.
     *
     * Comfortably longer than a sixteenth at 140bpm (107ms) so fast runs keep
     * splitting normally, and far shorter than the seconds-long ring-out that
     * follows a phrase, which is what this is for.
     */
    ringOutMs: number;
    /**
     * How close to its own predicted decay a single note must still be for a
     * transient to count as re-picking it.
     *
     * A pick puts energy into a string, so a re-picked note sits at or above
     * where its own curve says it should be — measured on the fixtures, genuine
     * re-picks land between 0.93 and 1.05 of the prediction. A note at half its
     * predicted level had nothing added to it: it is dying faster than its own
     * fit expected, and the sharp transient on top of it is the string itself,
     * not a pick. Those measure 0.43 and 0.52, and they are how a quarter note
     * came out as two.
     */
    ringOutDecayFloor: number;
    /**
     * How far above the flux the signal has been showing since the note began
     * a *single* ringing note's re-pick must stand.
     *
     * The companion of `restrumFluxRatio` for the monophonic ring-out branch,
     * and separate from it because the two cases are not alike. Over a chord
     * the escape exists for a muted upstrum, which answers its downstrum inside
     * a beat and arrives while six strings are still moving. Over one note
     * ringing out past `ringOutMs` the same escape is the last thing standing
     * between a long decay and a Note per twitch, and with the onset detector
     * now able to see a quiet arrival over a sounding note there are far more
     * twitches to say no to. Derived on the five 120bpm fixtures: `clean-lead`
     * sheds a false positive inside a held quarter note at 1.8 and another at
     * 2.4, and its labelled re-picks are untouched at both.
     */
    ringOutFluxRatio: number;
    /**
     * Transient sharpness a *pitch-changing* attack needs before it starts a
     * new Note.
     *
     * Lower than `rearticulationSharpness`, because a new pitch is already
     * strong evidence — but not zero, because the individual strings of one
     * strum arrive at different pitch classes over tens of milliseconds and
     * would otherwise each open a Note of their own.
     */
    newPitchSharpness: number;
    /**
     * How long a *polyphonic* Note must have sounded before an attack is
     * allowed to end it.
     *
     * A strum excites six strings at slightly different moments and each one
     * rings unevenly, so the hundreds of milliseconds after a chord are full of
     * transient-looking energy that is the same strum still happening. A single
     * note has no such internal structure, which is why this applies only once
     * the deep lane has reported polyphony.
     */
    minRestrumMs: number;
    /**
     * How far above a Note's own measured decay curve the signal must sit for
     * the extra energy to count as a fresh strum.
     *
     * The one test a muted upstrum can pass and sustain ripple cannot: the
     * upstrum puts energy into strings that were on their way down, and no
     * amount of ripple lifts a decaying chord above where its own decay says
     * it should be.
     */
    restrumDecayExcess: number;
    /**
     * How long after a chord began a *sharpness-only* re-strum stays plausible.
     *
     * The sharpness escape exists for one thing: a muted upstrum, which damps
     * the strings and so puts total energy DOWN while plainly re-articulating
     * the chord. That is part of a strumming pattern — it follows its downstrum
     * within a beat, and on the fixtures every genuine one lands within half a
     * second of the strum it answers. Further into a ring-out the same evidence
     * means something else: a decaying chord produces sharp transients of its
     * own — finger noise, a string re-seating against a fret — that no pick
     * made, and reading those as re-strums is how a chord kept shedding Notes
     * seconds after it was played. Past this, re-articulating a chord takes
     * energy above its own decay curve, which is a witness ripple cannot fake.
     *
     * Any fixed value here is a bet about tempo, and the first one lost it. 800
     * came off the 120bpm fixtures, where every genuine sharpness-only restrum
     * lands within half a second. The held-out 140bpm power-chord takes answer
     * each downstrum on the next note boundary, 857ms later, and the decisions
     * arrive at 813-933ms: every single one of the sixteen even-numbered strikes
     * across the three signal paths was refused for being 13ms to 133ms too
     * late. 1000 is the smallest round bound that admits them, and it is a bound
     * rather than a fit: raising it further changes no decision on any 140bpm
     * take, while removing it entirely sheds extra Notes on three other
     * fixtures (cowboy-amped 11->15, cowboy-120 10->12, power-chords-120 9->14).
     * The ceiling is real and this sits below it.
     */
    mutedRestrumWindowMs: number;
    /**
     * Total pitch motion across the glide window that counts as an active
     * glide, in cents. Bending sweeps the spectrum, which spikes flux AND lifts
     * RMS, so both attack tests pass mid-bend; an attack only means "new note"
     * when the pitch is not already moving. Well above vibrato (±15 cents).
     */
    glideMinCents: number;
    /** Hops of pitch history the glide test looks back over. */
    glideWindowHops: number;
    /**
     * Envelope rise at which an attack is a re-articulation even mid-glide.
     *
     * The glide guard exists because bending sweeps the spectrum, which fires
     * both attack witnesses repeatedly inside what is musically one note. But a
     * bend does not put energy into a string, it redistributes what is already
     * there, so no amount of bending lifts the envelope severalfold. Measured
     * on the sixteenths run, picks rejected purely for arriving mid-glide carry
     * rise ratios up to 13.5 — a figure a bend cannot produce.
     *
     * Derived on the 120bpm fixtures by sweeping downward until one of them
     * moves. They are bit-identical from 1.6 upwards; at 1.5 `clean-lead`
     * sheds a false positive and at 1.25 it sheds five, which is the bend the
     * guard exists for coming apart again. 1.6 is the most sensitive setting
     * this material will support.
     */
    glideRiseOverride: number;
    /**
     * How long one articulation lasts, ms — the window in which a Note that has
     * just been ended by an attack is still the *same* thing being played.
     *
     * A strum is one gesture, not six: the pick crosses six strings over tens
     * of milliseconds and each string arrives as its own transient at its own
     * pitch. A single picked note is no better behaved — the attack transient
     * is the least periodic part of it, so the pitch estimator spends its first
     * hops still reporting whatever was ringing before. Either way the fast
     * lane emits a stub, named after the wrong thing, that ends on the attack
     * the player actually meant.
     *
     * Sized to cover the pitch path's lag and a strum's spread, and to stay
     * under a sixteenth at 120bpm (125ms) so a genuinely fast run still
     * segments. The fixtures put the cliff between 75 and 110ms: below it the
     * stubs survive, above it real notes in the triplet run are swallowed.
     *
     * Re-swept once the region lane began carving events out of what the fast
     * lane had merged: the five 120bpm fixtures are bit-identical at 80 and
     * `chords-a-bm` sheds a false positive at 75, so 80 is the shortest window
     * that material supports. It matters because absorbing a stub is one of
     * the two named ways a played note disappears — on the room-mic sixteenths
     * three labelled strokes were being swallowed as stubs and on the amp sim
     * five were.
     */
    articulationMs: number;
  };

  tracking: {
    /**
     * How long a Note must sound before it is announced.
     *
     * Swept on the five 120bpm fixtures: bit-identical at 55, and at 50
     * `clean-lead` gains three false positives. The findings already record the
     * other side — above 60 the sixteenth run starts losing real notes — so the
     * usable band is narrow and this sits at the sensitive end of it.
     */
    minStableMs: number;
    /**
     * How long a Note with no measurable pitch must sound before it is
     * announced.
     *
     * Longer than `minStableMs`, because there is less to go on. A pitched Note
     * has already been confirmed by an independent estimator; an unpitched one
     * has only energy, and energy alone is also what a pick scrape, a fret
     * buzz and the tail of the previous chord look like.
     */
    minUnpitchedStableMs: number;
    /** How long silence must persist before a Note is ended. */
    releaseGraceMs: number;
    bendThresholdCents: number;
    /** How long after an attack a new Note may still be backdated onto it. */
    backdateWindowMs: number;
    /** Notes held for `getNote()` after they end. */
    endedNoteHistory: number;
    /** Maximum contour points retained per Note. */
    maxContourPoints: number;
  };

  harmony: {
    fftSize: number;
    /** Minimum top-1 template score for a confident chord label. */
    floor: number;
    /** Minimum score(top1) - score(top2) for a confident chord label. */
    margin: number;
    /**
     * Confident hops the winning ROOT needs before a Note is willing to be
     * named. The chroma path runs once every few hops and caches in between, so
     * a handful of identical hops can be a single look at the spectrum.
     */
    minEvidenceHops: number;
    /**
     * How long a Note must have sounded before it may report harmony it cannot
     * name.
     *
     * Naming a chord is self-justifying: the template fitted, the bass agreed,
     * and the Note says so. Saying "this is a chord and I will not name it" is
     * a much weaker claim to make about a short Note, and it is the one that
     * goes wrong on a fast run — an 85ms transform at 167ms per note straddles
     * two notes plus the decay of a third, which is genuinely polyphonic audio
     * that is not a chord. Every chord in the fixtures sustains for at least
     * 450ms; nothing shorter is a strum worth abstaining about.
     */
    minChordDurationMs: number;
    /** Estimated simultaneous fundamentals below which harmony never blooms. */
    minPolyphony: number;
    /**
     * Semitones the detected voices must span before the audio counts as
     * harmonic. Roughly a fifth: below that the "extra" fundamentals are an
     * octave doubling of one string, not a second voice.
     */
    minVoiceSpreadSemitones: number;
    /**
     * Mean fast-lane pitch confidence above which a Note stays a single note,
     * whatever the spectrum looks like.
     *
     * The spectral evidence cannot settle this on its own. A 4096-point window
     * is 85ms, and in a run at 167ms per note it straddles two notes plus the
     * decay of a third — so a fast lead line genuinely looks polyphonic, with
     * four to six fundamentals spread across two octaves. What separates it
     * from a chord is periodicity: one string sounding alone is strongly
     * periodic and YIN says so (median confidence 0.98 on the lead fixture),
     * while six strings ringing together have no single period to find (median
     * 0.65 to 0.90 on the chord fixtures).
     */
    maxMonophonicConfidence: number;
    /**
     * How harmonic the recent audio must read before an octave-sized pitch jump
     * is treated as the detector moving between strings rather than as a note
     * change.
     *
     * Deliberately far below half: the fragmentation this prevents happens in
     * the first moments of a strum, when the estimate has only just started
     * recovering from the silence before it. Waiting for certainty would arrive
     * after the damage.
     */
    octaveFlipContext: number;
    /**
     * How harmonic the recent audio must read before YIN's pitch steps stop
     * being treated as note boundaries at all.
     *
     * Higher than `octaveFlipContext`: ignoring an octave jump costs nothing on
     * a single note, while ignoring every step would merge a legato run into
     * one Note, so this one wants real confidence that a chord is sounding.
     */
    stepSuppressContext: number;
    /** Run the chroma path once every N fast hops. */
    hopDivisor: number;
    /**
     * How far back a Note that has just named itself a chord may reach to
     * absorb the fragments of its own attack.
     *
     * A strum is not one event acoustically: six strings are excited over tens
     * of milliseconds, each with its own transient, and the fast lane — which
     * has to answer within a hop and cannot know a chord is coming — reports
     * several short Notes before the deep lane has enough spectrum to say what
     * was played. Those fragments are not wrong, they are early. When the
     * harmony finally resolves, the Note that carries it reaches back and
     * absorbs the unnamed fragments contiguous with it, which is also what
     * moves its start back onto the real attack.
     */
    mergeLookbackMs: number;
    /** Largest silence between two Notes that a merge may bridge. */
    mergeMaxGapMs: number;
    /**
     * Longest Note a merge may absorb.
     *
     * A fragment of a strum's attack is short by definition — it exists because
     * the fast lane had to answer before the chord had declared itself. A Note
     * that sustained for longer than this was a note somebody played, and
     * swallowing it into a neighbour would delete a real event rather than
     * repair an artefact.
     */
    mergeMaxFragmentMs: number;
    /** How long the absorbing Note must itself have sounded. */
    mergeMinSurvivorMs: number;
    /**
     * How long a rival chord reading must persist before it splits the Note.
     *
     * Chord segmentation cannot wait for silence: the bars in these recordings
     * run into each other with no gap, and a player changing chord mid-ring
     * often produces no transient worth the name. The change itself is
     * therefore a boundary — but only once it has held, because one confused
     * window during a transition would otherwise shred a bar into fragments.
     */
    changeStableMs: number;
  };

  deep: {
    /** Audio history the deep lane can revisit, in seconds. */
    ringSeconds: number;
    /**
     * Source-time delay before a deep job's result is applied. Models the real
     * cost of deep analysis and, offline, makes that delay deterministic.
     */
    latencyMs: number;
    /**
     * Samples between successive windows when the deep lane walks a region.
     *
     * A quarter of the 4096-point window: enough overlap that a boundary is
     * localised to about 21ms, cheap enough that a second of audio is fifty
     * transforms rather than two hundred.
     */
    regionHopSamples: number;
    /**
     * Longest pending region, in ms, before it is analysed without waiting for
     * a Note to end.
     *
     * A player holding one chord produces no Note ends for seconds, and a
     * region that grows unboundedly eventually outruns the ring and is dropped
     * — which would mean the deep lane never rules on anything.
     */
    maxRegionMs: number;
    /** Hard ceiling on windows per region, whatever the hop works out to. */
    maxRegionWindows: number;
    /**
     * Audio that must have arrived after the last Note in a region before the
     * region is analysed.
     *
     * A boundary is only visible once a window has seen what comes AFTER it, so
     * a region that stops at the moment its last Note ended cannot locate its
     * own final boundary. This is not the latency the findings measured and
     * rejected: that one delayed applying a fixed window ending at "now", which
     * buys nothing. This delays the analysis until the audio it is about has
     * finished arriving, which is the only version of waiting that helps.
     */
    regionSettleMs: number;
    /**
     * Shortest span the region segmenter will call an event.
     *
     * Below this a "boundary" is the analysis window sliding across an existing
     * boundary rather than a second thing being played: the fastest run in the
     * fixtures is 125ms per note.
     */
    minSegmentMs: number;
    /**
     * Consecutive windows a new dominant fundamental must hold before it counts
     * as a boundary.
     *
     * One window is a flap — an 85ms transform straddling a boundary reports
     * whichever of the two notes happens to be louder, and it changes its mind
     * on the next hop. Two in a row is a note.
     */
    segmentHoldWindows: number;
    /**
     * How far the envelope must rise above the quietest point of the current
     * segment before that rise is a new articulation.
     *
     * This is the witness that catches a note re-picked at the same pitch,
     * which no amount of looking at the spectrum will ever separate: a D5
     * picked twice is D5 throughout. Measured on the fixtures, a genuine
     * re-pick clears 2.5x over the trough it starts from while sustain ripple
     * stays under 1.6x.
     */
    segmentRiseRatio: number;
    /**
     * Envelope rise a boundary needs when the fast lane saw a transient there.
     *
     * `segmentRiseRatio` is the bar for a rise with no other witness, so it
     * carries the whole burden of proof on its own. When the fast lane already
     * saw energy arrive at an exact moment, the only remaining question is
     * whether anything followed it, and the bar is correspondingly lower — it
     * has to be, because the region's windows are 85ms long and a quiet
     * upstroke 107ms after its downstroke shares most of its window with the
     * tail of that downstroke, so its full rise is never visible in one window.
     */
    segmentAttackRiseRatio: number;
    /**
     * Let the deep lane absorb Notes the fast lane over-segmented.
     *
     * Splitting is additive — it can only turn one detection into two — while
     * merging deletes a detection the recognizer already stood behind, and if
     * the segmenter is wrong that is a played note thrown away.
     *
     * **Off, on measurement.** Enabled on these fixtures it takes false
     * positives 6 -> 10 and fragmentation 11/78 to 12/78 with a worst case of
     * five Notes on one event — merging one pair moves a start time, which
     * opens the survivor to the fast lane's own absorption path and cascades.
     * The mechanism is here and tested; it does not yet pay for itself, and
     * saying so is cheaper than a number nobody can explain.
     */
    regionMerge: boolean;
    /**
     * Let the deep lane rename a Note the region disagrees with.
     *
     * A different claim from the structural switches: splitting and merging are
     * about how many events there were, renaming is about what one of them was
     * called, and the two fail in unrelated ways.
     *
     * **Off, on measurement, and for a reason already on the record.** The
     * findings note that giving the deep lane a vote on a monophonic Note's
     * pitch changed nothing because it is fooled by the same ringing
     * predecessor YIN is. Letting it *override* rather than vote is worse:
     * clean-lead pitch class 92.9% -> 81.5%, which fails the gate. The
     * strongest fundamental in a window is the loudest voice, and the loudest
     * voice in a fast run is routinely the note before this one.
     */
    regionCorrectPitch: boolean;
  };

  diagnostics: {
    pitchFrames: boolean;
    contour: boolean;
  };
};

/** Matches the AudioWorklet render quantum. Do not change to "go faster". */
export const RENDER_QUANTUM = 128;

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  analysis: {
    minFrequencyHz: 70,
    maxFrequencyHz: 1400,
    hopMs: 12,
    rmsGate: 0.008,
    rmsGateNoiseMultiple: 200,
    noiseFloorQuantile: 0.05,
    noiseFloorRate: 0.02,
    noiseFloorMinimum: 1e-5,
    // Tuned against the recorded fixtures, not chosen a priori. At 0.5 the
    // detector dropped frames mid-note on decaying low strings, which read as
    // note-offs and split notes in two; 0.35 keeps them voiced.
    confidenceGate: 0.35,
  },
  pitch: {
    longWindow: 2048,
    shortWindow: 512,
    shortWindowMinHz: 300,
    yinThreshold: 0.13,
    medianFrames: 3,
    voteLagMs: 0,
    stepThresholdCents: 70,
    stepConfirmFrames: 2,
    splitConfidence: 0.6,
  },
  transient: {
    fluxFftSize: 1024,
    fluxSensitivity: 1.35,
    fluxMedianWindow: 17,
    fluxReferenceMs: 32,
    attackBandLoHz: 1000,
    attackBandHiHz: 6000,
    attackBandFloorFactor: 0.08,
    minIntervalMs: 60,
    envelopeWindowMs: 20,
    envelopeBaselineMs: 80,
    envelopeRiseRatio: 1.35,
    rearticulationRiseRatio: 1.2,
    rearticulationSharpness: 1.6,
    restrumSharpness: 0.9,
    restrumFluxRatio: 1.3,
    ringOutMs: 250,
    ringOutDecayFloor: 0.6,
    ringOutFluxRatio: 2.4,
    newPitchSharpness: 0.6,
    minRestrumMs: 380,
    restrumDecayExcess: 1.25,
    mutedRestrumWindowMs: 1000,
    glideMinCents: 25,
    glideWindowHops: 5,
    glideRiseOverride: 1.6,
    articulationMs: 80,
  },
  tracking: {
    minStableMs: 55,
    minUnpitchedStableMs: 90,
    releaseGraceMs: 90,
    bendThresholdCents: 45,
    backdateWindowMs: 120,
    endedNoteHistory: 64,
    maxContourPoints: 512,
  },
  harmony: {
    fftSize: 4096,
    floor: 0.55,
    margin: 0.08,
    minEvidenceHops: 3,
    minChordDurationMs: 250,
    minPolyphony: 2,
    minVoiceSpreadSemitones: 7,
    maxMonophonicConfidence: 0.9,
    octaveFlipContext: 0.25,
    stepSuppressContext: 0.8,
    hopDivisor: 4,
    mergeLookbackMs: 900,
    mergeMaxGapMs: 120,
    mergeMaxFragmentMs: 250,
    mergeMinSurvivorMs: 0,
    changeStableMs: 240,
  },
  deep: {
    ringSeconds: 4,
    latencyMs: 40,
    regionHopSamples: 1024,
    maxRegionMs: 1200,
    maxRegionWindows: 96,
    regionSettleMs: 200,
    minSegmentMs: 90,
    segmentHoldWindows: 2,
    segmentRiseRatio: 2.0,
    segmentAttackRiseRatio: 1.25,
    regionMerge: false,
    regionCorrectPitch: false,
  },
  diagnostics: {
    pitchFrames: false,
    contour: false,
  },
};

/** Deep clone, so a caller's overrides never alias the shared defaults. */
function clone(config: EngineConfig): EngineConfig {
  return {
    analysis: { ...config.analysis },
    pitch: { ...config.pitch },
    transient: { ...config.transient },
    tracking: { ...config.tracking },
    harmony: { ...config.harmony },
    deep: { ...config.deep },
    diagnostics: { ...config.diagnostics },
  };
}

/**
 * Merge caller tuning over the defaults.
 *
 * `EngineTuning` deliberately exposes far less than `EngineConfig` holds: the
 * window sizes and template thresholds are the recognizer's business, and a
 * caller who moves them is tuning a detector rather than configuring a library.
 */
export function resolveEngineConfig(
  tuning: EngineTuning = {},
  diagnostics: { pitchFrames?: boolean; contour?: boolean } = {}
): EngineConfig {
  const config = clone(DEFAULT_ENGINE_CONFIG);
  const a = config.analysis;

  if (tuning.minFrequencyHz !== undefined) a.minFrequencyHz = tuning.minFrequencyHz;
  if (tuning.maxFrequencyHz !== undefined) a.maxFrequencyHz = tuning.maxFrequencyHz;
  if (tuning.hopMs !== undefined) a.hopMs = tuning.hopMs;
  if (tuning.rmsGate !== undefined) a.rmsGate = tuning.rmsGate;
  if (tuning.confidenceGate !== undefined) a.confidenceGate = tuning.confidenceGate;

  if (tuning.minStableMs !== undefined) config.tracking.minStableMs = tuning.minStableMs;
  if (tuning.releaseGraceMs !== undefined) {
    config.tracking.releaseGraceMs = tuning.releaseGraceMs;
  }
  if (tuning.bendThresholdCents !== undefined) {
    config.tracking.bendThresholdCents = tuning.bendThresholdCents;
  }
  if (tuning.deepLatencyMs !== undefined) config.deep.latencyMs = tuning.deepLatencyMs;

  if (diagnostics.pitchFrames !== undefined) {
    config.diagnostics.pitchFrames = diagnostics.pitchFrames;
  }
  if (diagnostics.contour !== undefined) config.diagnostics.contour = diagnostics.contour;

  return config;
}

/** Snap a requested hop to a whole number of render quanta, minimum one. */
export function snapHop(hopMs: number, sampleRate: number): number {
  const requested = (hopMs / 1000) * sampleRate;
  const quanta = Math.max(1, Math.round(requested / RENDER_QUANTUM));
  return quanta * RENDER_QUANTUM;
}
