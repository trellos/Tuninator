# examples/

## `browser-demo/` — this is a holding location, not its final home

This directory contains **Tuninator-Example**, the Vite browser demo: a scrolling note timeline
with a 90bpm metronome, consuming the library through its public API only.

It is intended to live in its own repository, `trellos/Tuninator-Example`, checked out as a
sibling of this one:

```
C:\dev\Tuninator\
C:\dev\Tuninator-Example\
```

It is committed here instead because the session that built it could not create the repository —
the GitHub App returned `403 Resource not accessible by integration` on repository creation — and
the build container it was written in is ephemeral. Committing it here was the only way to keep
the work.

### The files assume the sibling layout, unchanged

`package.json` declares `"tuninator": "file:../Tuninator"` and `vite.config.ts` aliases
`tuninator` to `../Tuninator/src/index.ts`. Those paths are correct for the standalone repo, and
they are **deliberately left as they are** so the directory can be lifted out verbatim.

That also means the demo does **not** build from this location without adjusting those two paths.

### Moving it to its own repository

```bash
# from C:\dev
mkdir Tuninator-Example
cp -r Tuninator/examples/browser-demo/* Tuninator-Example/
cp Tuninator/examples/browser-demo/.gitignore Tuninator-Example/
cd Tuninator-Example
git init && git add -A && git commit -m "Initial commit: Tuninator browser demo"
gh repo create trellos/Tuninator-Example --public --source=. --push
npm install && npm run dev
```

Then delete `examples/` from this repository.

### What it does

See [`browser-demo/README.md`](browser-demo/README.md). Briefly: start/stop mic, live frequency
and cents, active `MusicEvent`, a canvas timeline showing 16 beats (10.667s) of scrolling history
with beat gridlines from the metronome clock, and a mode selector exercising `setMode()` while
listening.

It ships a **mock Tuninator** (`?mock=1`) that emits a synthetic pitch and event stream, so the UI
can be developed and smoke-tested without a microphone or a built library. `npm run smoke` drives
it headlessly and verifies the canvas actually rendered by reading pixels back;
`screenshot.png` is the evidence.
