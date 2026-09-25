# External models evaluated for Tuninator

One paragraph per published model the owner has asked about: why it does or
does not fit. The full measurements for each live in
`docs/DETECTION-FINDINGS.md` and `DECISION_LOG.md`, under the entry named.

## `greblus/solitito-ai` — 2026-09-25 — does not fit (DECISION-085)

Solitito's model is real time in the sense that it keeps up with live audio,
answering every 40ms, but each answer describes roughly the last second of
sound as a whole: it listens to about 0.77s at a time, and its finest output,
"a note was struck in the last 0.1s", arrives 0.2–0.5s after the pick and stays
up for about a second. That is enough for a practice app that waits for you to
play a chord, and it will usually notice that a short note happened, but it
cannot say when that note began or ended, or separate two quick notes. The
errors Tuninator has left are exactly those: a sixteenth note at 140bpm lasting
about 0.1s, and short ghost notes split off a real one. So it cannot help with
where notes start and stop, it names pitch classes without an octave, and at
7.4M parameters it is about 300 times too large to ship in the engine anyway.
Stopped before running it on any recording.
