# Frozen pre-rewrite baseline

Captured on branch `claude/guitar-event-recognizer-refactor-t5g5yr` at commit d8e4141,
BEFORE any rewrite work. This is the reference every phase must not regress against.

Commands: `npm ci && npm test && npm run eval`

## Test suite
289 tests across 10 files — all passing.

## Eval (`npm run eval` exits 1)

| fixture | required | labels | detections | matched | missed | false pos | exact | pitchClass |
|---|---|---|---|---|---|---|---|---|
| chords-a-bm-g-d-2x-120bpm | yes | 16 | 13 | 13 | 3 | 0 | 75.0% | 81.3% |
| clean-lead-120bpm | yes | 43 | 42 | 34 | 9 | 8 | 67.4% | 72.1% |
| cowboy-chords-c-d-em-g-c-d-em-am-120bpm | no | 8 | 15 | 8 | 0 | 7 | 75.0% | 87.5% |
| power-chords-c-a-g-e-c-d-fsharp-e-120bpm | yes | 8 | 11 | 8 | 0 | 3 | 87.5% | 100.0% |
| spicy-chords-cmaj9-g-am11 | no | 3 | 8 | 3 | 0 | 5 | 33.3% | 100.0% |

**TOTAL: 78 labels, 12 missed, 23 false positives.**

Gate failures at baseline:
- `clean-lead-120bpm` (required): minLabelAccuracy (pitchClass) 72.1% < 90%, maxFalsePositives 8 > 3
- `power-chords-...` (required): maxMedianOnsetErrorMs 140.0 > 120.0

## The 12 missed labels

- `chords-a-bm-g-d`: s6 (G @6920ms), s8 (D @7920ms), s12 (Bm @9920ms)
- `clean-lead`: t6 (C#5 @12693ms), t10 (E5 @13360ms), t11 (D5 @13527ms),
  t16 (E5 @14360ms), t17 (D5 @14527ms), t18 (C#5 @14693ms), t23 (F#5 @15527ms),
  s4 (A4 @20245ms), s5 (B4 @20370ms)

Diagnostic reading: the clean-lead misses fall in fast sixteenth-note runs and the
chords misses are all restrums of a still-ringing chord. Both are cases the old
single-active-event tracker (`src/core/event-tracker.ts`, `active: Active | null`)
cannot represent — a second event cannot begin while the first is alive. This is
the defect the rewrite's multi-note tracker + re-articulation detection targets.

## Fixture container note

The `mvhd`/`mdhd` duration headers in all five `fixtures/audio/*.mp4` read a stale
2.048s. The `stts`/`stsz` sample tables are authoritative (ffmpeg uses them; decoded
durations 13.076–23.999s match). Any hand-rolled duration check must not trust `mvhd`.
