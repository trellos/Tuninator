# Decision Log

Architectural, technical, and critical project decisions for Tuninator, in the
schema defined by `AGENTS.md` §6. Newest entries at the top. A decision this
project rejected is logged exactly like one it accepted — the negative results
are what keep later work from repeating them.

---

#### [DECISION-011]: Reject DP-based joint region segmentation
* **Date:** 2026-08-20
* **Status:** Rejected
* **Owner:** Detection architecture
* **Context:** Local, one-candidate-at-a-time accept/reject decisions for
  re-articulation cap at ~0.73 AUC (see DECISION-010). Hypothesis: choosing a
  region's whole segmentation jointly, by dynamic programming over candidate
  boundaries (cost = per-segment misfit + price per cut), might succeed where
  per-candidate thresholds fail, because it can weigh a boundary against the
  segmentation it is part of rather than judging it alone.
* **Decision:** Measured the ceiling before building it into the engine
  (`scripts/measure-dp-segmentation.ts`, fit-on-test). Rejected: no price
  setting is inside the current baseline (32 missed / 107 extras) on both
  axes; the best point holding extras under baseline misses 234 of 454
  reachable labels. The per-segment cost terms themselves scored 0.469 AUC
  (decay residual — chance), 0.689 (pitch stability), 0.713 (chroma
  stability) — the same ceiling as the local witnesses. A joint decision does
  not create information the underlying features lack.
* **Alternatives Considered:** Feeding the DP three streams at their natural
  time/frequency resolutions (fine RMS envelope, fast-lane per-hop pitch,
  85ms deep-lane chroma) rather than one window — implemented, did not change
  the conclusion.
* **Consequences:** Confirms the problem is in the feature set, not in the
  decision procedure over it (local threshold vs. joint optimum). Directly
  motivated DECISION-012: stop improving logic over the twelve existing
  witnesses and look for features with a different physical basis. Full
  numbers: `docs/DETECTION-FINDINGS.md`.

#### [DECISION-010]: Reject per-rig calibration of re-articulation thresholds
* **Date:** 2026-08-20
* **Status:** Rejected
* **Owner:** Detection architecture
* **Context:** Attack contrast varies 2.0x–24.2x across the corpus and up to
  106x within a single take. A `NoiseFloorTracker` already derives the
  amplitude gate from a rig's own measured noise floor successfully. Question:
  can the same pattern — measure the rig, scale the decision thresholds by
  what was measured — fix the re-articulation (same-pitch repick) decision?
* **Decision:** Built `RigProfileEstimator`, proved a real rig signature
  exists (flux floors run 1.6x within one recording chain vs 3.0x between
  chains), then measured the fit-on-test *ceiling*: scaling re-articulation
  bars by the profile trades 7 correctly detected events and 7 correct names
  for 17 fewer duplicate Notes (32→39 missed, 107→90 extras) — worse on the
  axis that matters. The honest cross-take-within-chain version is slightly
  worse still. Decisive evidence: the *same* amp-sim profile removes 9
  duplicate Notes at zero cost on one take and costs 5 played events on
  another take from the same guitar, same session. What varies is the
  passage being played, not the recording chain.
* **Alternatives Considered:** Fitting a twelve-witness logistic model
  directly (DECISION-009, same root failure); pooling all takes into one
  profile (worse on both axes, 49 missed / 98 extras — confirms the
  chain-specific signal is real, just not useful for this decision).
* **Consequences:** Per-rig calibration is closed as a direction for this
  decision. The `RigProfileEstimator`/`RigCalibration` code stays in the tree
  (`UNCALIBRATED` is the identity, off by default, pinned by a test) because
  the underlying rig signature may be useful elsewhere (e.g. informing the
  missing-fundamental estimator which signal path it is on), just not for
  this decision.

#### [DECISION-009]: Reject a fitted multi-witness model for re-articulation
* **Date:** 2026-08-20
* **Status:** Rejected
* **Owner:** Detection architecture
* **Context:** Twelve hand-computed witnesses exist for the re-articulation
  decision (spectral flux in four normalisations, envelope ratios, decay-fit
  residual, duration, pitch-change flags). No single threshold on any one
  witness works across the corpus's 2.0x–106x attack-contrast range. Question:
  does a fitted combination of all twelve do better than hand-tuned logic
  over the same set?
* **Decision:** Rejected. Best single witness reaches 0.73 AUC. An L2
  logistic regression over all twelve reaches 0.808 AUC in-sample, 0.758 with
  folds that mix takes, and **0.434 leave-one-take-out — worse than chance**.
  Scored on twelve held-out takes after fitting on five derivation takes:
  0.647, below the single best witness (0.667). Correlation analysis shows
  the twelve witnesses collapse to roughly four independent signals
  (`sharpness`/`heldSharpness` r=0.954, `fluxRatio`/`heldFluxRatio` r=0.867).
* **Alternatives Considered:** Two-feature exhaustive sweep (still overfits
  per-take scale); regularisation sweep λ ∈ {0.01, 0.1, 1, 10} (does not
  close the in-sample/leave-one-out gap).
* **Consequences:** The in-sample→leave-one-take-out collapse is the
  signature of features whose *scale* is take-dependent, not of a decision
  procedure that needs improving. This is the finding that redirected effort
  from "combine what we have better" to "find scale-invariant features" —
  see `docs/onset-features-prompt.md` for the resulting research direction
  (period-to-period waveform dissimilarity, adaptive whitening).

#### [DECISION-008]: Adopt structural revision as the mechanism for retroactive segmentation correction
* **Date:** 2026-08-19
* **Status:** Accepted
* **Owner:** Recognizer architecture (P2/P7 of the rewrite)
* **Context:** Some evidence that a segmentation decision was wrong only
  arrives after the decision was delivered to a listener (e.g. a rejected
  transient later corroborated by a mute; a same-pitch split later shown to
  be one continuous decay). The public API promises delivered events are
  never silently rewritten.
* **Decision:** A correction is delivered as a `NoteChange` with
  `type: "structuralRevision"` on the surviving Note (carrying
  `relatedNoteIds`), followed by a `noteStarted` for any new Note with a
  backdated `startTime`. History is revised in *meaning*, never rewritten —
  already-delivered events always stand.
* **Alternatives Considered:** Silently retracting and re-emitting events
  (breaks the "events are facts, once delivered" guarantee downstream
  consumers rely on); withholding emission until the deep lane confirms
  (unacceptable added latency for the fast lane's whole reason for existing).
* **Consequences:** Gives later-arriving evidence (deep lane re-segmentation,
  mute witness, decay-fit corroboration) a principled place to land without
  breaking the public contract. Cost: consumers must handle
  `structuralRevision` explicitly rather than treating the Note stream as
  append-only.

#### [DECISION-007]: Adopt a two-lane (fast/deep) architecture over one source-sample timeline
* **Date:** 2026-08-18
* **Status:** Accepted
* **Owner:** Recognizer architecture (P0 of the rewrite)
* **Context:** Rewriting from a single-active-event pitch detector
  (`src/core/event-tracker.ts`, `MusicEvent`, four caller-selected modes) to a
  streaming musical event recognizer per the architecture spec. Needed a way
  to answer both "what's happening right now" (bounded latency) and "what
  actually happened here" (needs more audio and more time than causal
  operation allows).
* **Decision:** Fast lane: causal, sub-50ms, pitch/onset/re-articulation only.
  Deep lane: allowed to be late, revisits a timestamped ring buffer by sample
  range, does spectral/harmonic/multi-pitch/re-segmentation work, emits
  corrections as `NoteChange`s (see DECISION-008). Both driven off one
  `SourceTimeMs` clock derived only from sample count ÷ sample rate.
* **Alternatives Considered:** Single-pass causal-only detector (cannot
  recover from bad early segmentation, which is the majority of remaining
  defects per `docs/DETECTION-FINDINGS.md`); fully offline/batch analysis
  (fails the real-time browser requirement entirely).
* **Consequences:** Enables retroactive correction (DECISION-008) and made
  `deep/resegment.ts` possible. Cost: two lanes to keep synchronised, a
  ring-buffer memory budget (`deep.ringSeconds`), and — per DECISION-011 —
  even this architecture has not yet closed the remaining segmentation gap;
  the lane exists but does not yet own boundary placement jointly.

#### [DECISION-006]: Modes are removed; one recognizer runs at all times
* **Date:** 2026-08-18
* **Status:** Accepted
* **Owner:** Public API design (P4 of the rewrite)
* **Context:** The 0.1 API had four caller-selected modes (`lead`, `chords`,
  `rhythm`, `raw`) that ran genuinely different code paths — chord
  segmentation was driven by chord-label change in `chords` mode and simply
  never ran in `lead` mode. This meant a chord played while in `lead` mode was
  never recognised as one.
* **Decision:** One recognizer runs the whole time. A Note starts as
  whatever the fast lane can say in a few tens of milliseconds — usually a
  single pitch — and `harmony` appears on it later if the deep lane's
  evidence supports it. No `setMode`/`getMode`, no `TuninatorMode`.
* **Alternatives Considered:** Keeping modes as a performance optimisation
  (rejected — the correctness cost of "notes played in the wrong mode are
  invisible" outweighs any saved cycles); auto-detecting an implied mode
  from recent input (rejected — same class of bug, just implicit).
* **Consequences:** Fixes a real correctness bug at the cost of always
  running the harmonic-analysis path. This is a breaking API change with no
  compatibility shim — `docs/MIGRATION.md` documents the full mapping.

#### [DECISION-005]: Voices and Notes are distinct; a ringing string does not spawn a new Note
* **Date:** 2026-08-18
* **Status:** Accepted
* **Owner:** Tracker semantics (F2/F3, S1 of the rewrite/recovery)
* **Context:** After the initial rewrite landed, false positives jumped
  23→52 because the detector could not distinguish "a new note was struck"
  from "a voice that's still ringing produced a fresh-looking transient".
  49 of 52 false positives fell inside an already-labelled event's span.
* **Decision:** A new Note triggered while another is still ringing must show
  an energy rise *above the predicted decay envelope* (a fitted
  `VoiceDecay`, not an absolute threshold) before it is allowed to exist. A
  detected pitch explainable as one of the currently-sounding Note's own
  voices is attributed to that Note rather than spawned as a new one.
* **Alternatives Considered:** A fixed refractory window after any onset
  (measured and rejected — genuine restrums in the corpus are spaced
  453–560ms apart and phantom re-triggers cluster at 427–627ms; the
  distributions overlap almost completely, so no window width works);
  gating chord protection on the Note's *name* rather than on whether it has
  *bloomed* into a chord (rejected — this actively broke the one path,
  amp-sim recordings, that needed the protection most, since amp
  compression frequently prevented a confident chord name).
* **Consequences:** Recovered from the 23→52 false-positive regression
  without weakening any label or threshold (`git diff --stat -- fixtures/`
  was empty across the whole recovery). Established `voices.ts`
  (`VoiceDecay`) as authoritative over note creation, which later became load
  -bearing for the mute-witness and decay-based corrections described in
  `docs/DETECTION-FINDINGS.md`.

#### [DECISION-004]: Engine isolation — `src/engine/**` may import nothing outside itself and `src/types.ts`
* **Date:** 2026-08-18
* **Status:** Accepted
* **Owner:** Project architecture (P0 of the rewrite)
* **Context:** The 0.1 codebase already had this property informally
  (`src/core/`) and it was load-bearing: identical code ran in the
  `AudioWorklet`, the Node offline-eval harness, and Vitest. Losing it during
  the rewrite would have made the offline evaluation harness meaningless —
  it would no longer prove anything about live behaviour.
* **Decision:** Preserved and formalised as a test
  (`tests/engine/isolation.test.ts`) rather than a convention. No `window`,
  `AudioContext`, `performance`, npm imports, or top-level side effects
  anywhere under `src/engine/`.
* **Alternatives Considered:** Relaxing isolation for convenience during the
  rewrite with a plan to "clean it up later" (rejected outright — a
  convention with no enforcement degrades under time pressure, and this
  project's whole evaluation methodology depends on the property holding
  exactly, not approximately).
* **Consequences:** Every DSP kernel and tracker file is testable with
  synthesized `Float32Array` input and no browser mocks. Cost: some
  duplication at the `src/browser/` boundary (e.g. the worker host mirrors
  engine state rather than reading it directly) to keep the boundary clean.

#### [DECISION-003]: Rewrite target is a streaming Note recognizer, not an incremental patch to the pitch detector
* **Date:** 2026-08-17
* **Status:** Accepted
* **Owner:** Project direction
* **Context:** Tuninator 0.1 was a per-frame YIN pitch detector with a
  single-active-event tracker. The desired product — an evolving `Note`
  object with a hypothesis trail, chord blooming, overlapping events, bends
  as one continuous Note — could not be expressed by extending the existing
  `MusicEvent`/single-active-event model; the data model itself was wrong for
  the target.
* **Decision:** Full rewrite of the semantic layer (tracker, event model,
  public API) while reusing the eval-tested DSP kernels (YIN, FFT, chroma,
  chord templates, channel selection) as first implementations behind new
  contracts. Breaking 0.x change, no compatibility shim, delivered as phased
  commits (see `docs/MIGRATION.md` for the resulting phase plan).
* **Alternatives Considered:** Incremental extension of `event-tracker.ts` to
  support overlapping events (rejected — the "exactly one active event"
  invariant was structural throughout the file, not a single check to
  relax); a compatibility shim translating old API calls onto the new model
  (rejected — a shim would have to invent data for concepts the new model
  doesn't produce, e.g. `MusicEvent.state` for an object that no longer has
  envelope states, and inventing data is worse than a compile error for
  consumers).
* **Consequences:** One clean break at P4 of the rewrite rather than
  incremental API churn across many releases. Cost: `examples/browser-demo`
  and the separate `Tuninator-Example` repository needed dedicated migration
  work (`docs/MIGRATION.md`, `docs/example-migration-prompt.md`).

#### [DECISION-002]: Definition of "done" is zero missed required labels, not a percentage accuracy target
* **Date:** 2026-08-17
* **Status:** Accepted
* **Owner:** Project direction
* **Context:** Needed a concrete, falsifiable bar for when detection quality
  is acceptable, stated before the rewrite began rather than negotiated
  after seeing results.
* **Decision:** The recognizer must detect every required labelled event
  (`maxMissed: 0` on required fixtures) unless fixture-audio verification
  (`scripts/verify-fixtures.ts`) shows the label is not recoverable from the
  audio — inaudible, or the stated pitch class genuinely absent from the
  signal. Any such exception requires written evidence in the verification
  report, never a quietly lowered threshold. Stated standard, restated
  directly by the project owner during development: "if a human wouldn't
  recognize it as a note then sounds like the analyzer is not working and
  needs to be fixed."
* **Alternatives Considered:** A percentage accuracy gate (e.g. "≥90% of
  labels found") — rejected as too easy to satisfy by quietly accepting a
  fixed error rate rather than by fixing causes.
* **Consequences:** Forced every miss to be individually traced to a named
  code branch (`scripts/measure-downstream-ledger.ts` exists because of this
  decision) rather than reported in aggregate. Currently 32 of 459 labels are
  still missed; each has a named cause in `docs/DETECTION-FINDINGS.md`. Not
  yet met in full — this decision remains the active target, not a
  historical record of success.

#### [DECISION-001]: Held-out evaluation set is mandatory before any detection constant is trusted
* **Date:** 2026-08-19
* **Status:** Accepted
* **Owner:** Evaluation methodology
* **Context:** Every tuned constant in the detection pipeline (gates,
  thresholds, window sizes) risks being fitted to the exact five recordings
  used to derive it, producing numbers that look good and predict nothing
  about a new recording.
* **Decision:** Split the corpus into a five-take, 78-event **derivation**
  set (120bpm, one guitar) that alone may inform any tuned constant, and a
  twelve-take, 381-event **held-out** set (140bpm, a second guitar, three
  signal paths: DI, amp sim, room mic) that is scored on every run and never
  fitted. Any measurement drawing a conclusion from held-out data alone (e.g.
  a chain-specific calibration profile derived from *all* takes in a chain,
  including the one being scored) must be labelled explicitly as a ceiling,
  not a result.
* **Alternatives Considered:** Tuning against the full seventeen-take corpus
  directly (rejected — this is exactly the leak the split exists to prevent,
  and several 2026-08-20 experiments, e.g. DECISION-010's fit-on-test
  calibration ceiling, demonstrate concretely how large the gap between an
  in-sample number and a genuine held-out number can be).
* **Consequences:** Every accuracy number in `README.md` and
  `docs/DETECTION-FINDINGS.md` is meaningful specifically because this
  separation held throughout the project. Cost: derivation data is scarce
  (43 single-note events from one recording underwrite the entire note-
  segmentation tuning), which is itself a named limitation — more varied
  derivation recordings would be the highest-leverage single contribution to
  future tuning work.
