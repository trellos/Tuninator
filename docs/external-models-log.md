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

## `cstr/hft-transformer-GGUF` — 2026-09-25 — does not fit, measured end to end (DECISION-087)

hFT-Transformer is a piano transcriber that, unlike solitito's model, really
does answer every 16 milliseconds: on a clean test tone it keeps four repeats
of one note played a sixteenth apart as four notes. Two things stop it helping
Tuninator. It needs between about 0.6 and 2.6 seconds of sound after a moment
before it will say what happened there, so only the slower, second-guessing
half of the recognizer could ever ask it, and by then the answer is usually
missing some of what it wanted to hear. And on the guitar recordings it does
not tell a real re-pick from a phantom split any better than the recognizer's
own attack measurements do. It looked slightly better on the practice takes
only with every recording pooled together, did worse within any one signal
path, and did worse than a coin toss on the 140bpm test takes. Wired in to
veto the recognizer's same-pitch splits, it removed 120 phantom notes from the
practice takes but deleted 144 real ones, and broke the required clean-lead
test. It also hears new notes inside nearly half of the notes the recognizer
already gets right, names pitch worse than the recognizer through an amp, and
at 5.5 million parameters is about 220 times too large to ship anyway.

## `spotify/basic-pitch` — 2026-09-25 — hears something real, but no rule built on it helps (DECISION-088)

Basic Pitch is Spotify's small, open note-transcription model. Every 12
milliseconds it says, for each piano-key pitch, whether a note is sounding and
whether one has just been struck. Unlike solitito, it answers about that
moment rather than the last second, and at about 17,000 parameters it is
within the engine's size limit. On test plucks it placed each attack within a
few milliseconds and kept apart two picks of one string a sixteenth apart. On
Tuninator's recordings it does hear something useful: a ghost Note usually has
no fresh pick under it. The model ranks a ghost below a real note 85–90% of
the time, on the practice takes and again on the 140bpm test takes, and it
knows this about 70ms after the pick, which is when the engine announces a
Note anyway. But too many real notes look like ghosts to it for that to be
usable. Set so that it costs no real note, it removes 4 of the 254 ghost
Notes. At its own default it removes 135 but loses 86 played notes and fails a
required recording, and on the test takes that trade is one for one. At the
moment the engine decides to cut a note it has not yet heard enough of the
pick to say anything, and it cannot recover the notes the tracker loses
without also hearing extra picks inside a quarter to two fifths of the notes
already caught. So it does not help as it stands. What it hears, a fresh
attack on a note's own pitch, is something the engine could measure itself,
beside a second clue.
