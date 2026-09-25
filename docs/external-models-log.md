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

## `MuScriptor/muscriptor-small` — 2026-09-25 — fine enough on paper, not tested: its weights are gated (DECISION-086)

MuScriptor writes music down as a list of notes, each with its own start and
end placed to a hundredth of a second, and it can mark the same pitch being
picked again. Those are exactly the boundaries Tuninator still gets wrong, so
on paper it is fine enough in time to help, where solitito was not. Two things
stand in the way of finding out. It listens in five-second blocks and answers
only when a block is complete, while Tuninator decides within a fraction of a
second and keeps only four seconds of sound, so it would have to be read on
windows it was never scored on, with the note in question at the very end.
And the trained model is locked behind a Hugging Face sign-in with a
non-commercial licence, and runs only in a Python toolkit this environment
cannot install, so it was not run on any recording. At about 100 million
parameters, some 4,000 times what the engine can ship, a good result could
only ever point at what the engine's own detectors should measure. Testing it
needs the owner to accept its licence on Hugging Face, add a token to the
environment, and allow its download and package hosts.
