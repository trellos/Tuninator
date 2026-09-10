# Evaluation

How well the recognizer actually does, measured. Every number here is derived
from a real run — `scripts/check-readme-eval.ts` re-derives the table and four
of the prose figures below from `.cache/eval-report.json` and fails CI on drift,
so a figure in this file that disagrees with `npm run eval` cannot survive a
pull request.

---

`npm run eval` decodes every recorded take in `fixtures/audio/`, runs the real recognition chain
over them, matches Notes one-to-one against the hand-written ground truth in `fixtures/labels/`,
and exits nonzero when a fixture marked `required` misses a threshold.

The corpus is **17 takes, 459 labelled events, about ten minutes of playing**, across two guitars,
two tempos and three signal paths (direct, amp sim, room mic). Five takes at 120bpm are the
derivation set — every tuned constant was chosen against those alone — and the twelve 140bpm Les
Paul takes are **held out**: they are recorded, labelled and scored, but nothing is tuned on them.
That separation is the only reason any number below means anything.

`npm run eval` currently **passes**: every required fixture meets its thresholds.

| Fixture | Required | Labels | Notes | Missed | Exact | Pitch class | Onset median |
|---|---|---|---|---|---|---|---|
| `chords-a-bm-g-d-2x-120bpm` | **yes** | 16 | 16 | 0 | 91.7% | 100.0% | 0ms |
| `clean-lead-120bpm` | **yes** | 43 | 42 | 2 | 82.1% | 92.9% | 46ms |
| `power-chords-c-a-g-e-...-120bpm` | **yes** | 8 | 9 | 0 | 87.5% | 100.0% | 107ms |
| `cowboy-chords-...-120bpm` | no | 8 | 12 | 0 | 75.0% | 87.5% | 40ms |
| `cowboy-chords-di-...-140bpm` | no | 8 | 12 | 0 | 75.0% | 100.0% | 52ms |
| `cowboy-chords-mic-...-140bpm` | no | 8 | 13 | 0 | 75.0% | 100.0% | 88ms |
| `cowboy-chords-amped-...-140bpm` | no | 8 | 11 | 0 | 62.5% | 100.0% | 92ms |
| `power-chords-di-...-140bpm` | no | 16 | 16 | 0 | 93.8% | 100.0% | 19ms |
| `power-chords-...-140bpm` (mic) | no | 16 | 23 | 0 | 72.7% | 100.0% | 23ms |
| `power-chords-amped-...-140bpm` | no | 16 | 18 | 0 | 92.3% | 100.0% | 13ms |
| `spicy-chords-cmaj9-g-am11` | no | 3 | 5 | 0 | 33.3% | 100.0% | 37ms |
| `lead-line-di-sixteenths-...-140bpm` | no | 48 | 42 | 6 | 87.5% | 87.5% | 15ms |
| `lead-line-sixteenths-...-140bpm` (mic) | no | 48 | 39 | 9 | 68.1% | 72.3% | 16ms |
| `lead-line-amped-sixteenths-...-140bpm` | no | 48 | 38 | 13 | 70.8% | 70.8% | 15ms |
| `lead-line-di-quarter-eighth-triplet-140bpm` | no | 55 | 76 | 0 | — | — | — |
| `lead-line-quarter-eighth-triplet-140bpm` (mic) | no | 55 | 65 | 2 | — | — | — |
| `lead-line-amped-quarter-eighth-triplet-140bpm` | no | 55 | 82 | 0 | — | — | — |

The three triplet takes score no accuracy because every section of them is marked informational in
`fixtures/eval.config.json`; the gated subset is empty by configuration, so the check is reported
as not applicable rather than failed.

## What is good and what is not

**Good.** Every chord fixture on every signal path finds all of its labels. Onset timing is well
inside its gates — of the fourteen takes that score it, seven have a median absolute error under
25ms and the worst is 107ms against a 120ms limit. Pitch class on the required lead fixture is
92.9%.

**Not good, and both are the same defect seen from two sides.**

- **Fast single-note lines lose strokes.** The sixteenth-note takes find 35–42 of 48 strokes. The
  losses are downstream of the evidence, not in it: the onset kernel covers 44, 44 and 47 of the
  48 on the three paths, and the Notes are lost afterwards — absorbed, ended too young, or created
  and then paired with a neighbouring label.
- **Fast single-note lines also produce extra Notes.** The triplet takes emit 65–82 Notes for 55
  labels. `npx tsx scripts/measure-splits.ts` puts the corpus at 99 of 459 events split with 107
  extra Notes, and 63 of those 99 are the three triplet takes. The shape is one thing: a
  correctly-named Note followed by a short SAME-PITCH tail fragment, so a single played event
  comes out as two.

The reason both are hard is measurable and is the same one: **attack contrast varies 2.0×–24.2×
across the corpus and up to 106× within a single take.** No single threshold separates a genuine
re-pick from a decaying string's own noise everywhere, which is why the design leans on retroactive
correction — the deep lane re-segmenting a region it can see whole — rather than on getting the
first answer right.

[`DETECTION-FINDINGS.md`](DETECTION-FINDINGS.md) records every experiment that was
measured and reverted, so that a road already found to be a dead end is not driven down again.

Held-out onset coverage, for scale: the twelve 140bpm takes have a kernel onset within 60ms of
**372 of their 381 labels**, at an off-label rate of 1.34% of above-gate hops. The evidence is
almost all there; what happens to it afterwards is the work that remains.

## The labels are estimates, and the eval says so

The fixture labels state their own uncertainty. That is why exact and pitch-class accuracy are
reported **separately** — a large gap between them points at the labels, while a low pitch-class
number points at the recognizer.

Where the recognizer confidently disagrees with a label, the evidence is written to
`.cache/proposed-label-corrections.json` rather than applied. **`fixtures/labels/` is read-only and
was never modified**, and no label was ever decided by asking the recognizer.
