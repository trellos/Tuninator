# examples/

## `browser-demo/`

A Vite browser demo: a scrolling note timeline, a 90bpm metronome, and a live tuner readout,
consuming the library through its public API only.

```bash
npm run build                    # in the repository root, for dist/tuninator-worklet.js
cd examples/browser-demo
npm install
npm run dev                      # http://localhost:5173
npm test                         # the demo's own tests
```

It is also where **channel selection** lives. The library analyses one mono channel and does not
choose it — see [Input is mono](../README.md#input-is-mono) — so the demo does the choosing:
[`channel-input.ts`](browser-demo/src/channel-input.ts) opens the microphone, splits it with a
`ChannelSplitterNode`, and hands one channel to the worker, using the windowed hysteretic selector
in [`channel-select.ts`](browser-demo/src/channel-select.ts). That selector used to live in the
library; it was moved here rather than deleted, with its tests.

The demo depends on the library as `"tuninator": "file:../.."`, so it always builds against the
checkout it sits in.
