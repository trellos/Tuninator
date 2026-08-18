/**
 * Tiny typed event emitter. `on()` returns its own unsubscribe function, so
 * there is no `off()` to get wrong.
 */

import type { TuninatorEventHandler, TuninatorEventName } from "./types.js";

type AnyHandler = (payload: never) => void;

export class Emitter {
  private readonly handlers = new Map<TuninatorEventName, Set<AnyHandler>>();

  on<E extends TuninatorEventName>(
    eventName: E,
    handler: TuninatorEventHandler<E>
  ): () => void {
    let set = this.handlers.get(eventName);
    if (!set) {
      set = new Set();
      this.handlers.set(eventName, set);
    }
    const fn = handler as unknown as AnyHandler;
    set.add(fn);

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.handlers.get(eventName)?.delete(fn);
    };
  }

  emit<E extends TuninatorEventName>(
    eventName: E,
    payload: Parameters<TuninatorEventHandler<E>>[0]
  ): void {
    const set = this.handlers.get(eventName);
    if (!set || set.size === 0) return;

    // Copy before iterating: a handler may unsubscribe itself, or another.
    for (const handler of [...set]) {
      try {
        (handler as (p: unknown) => void)(payload);
      } catch (error) {
        // A throwing consumer must never break the audio pipeline, and must
        // never take down the other subscribers to the same event.
        if (eventName !== "error") {
          // eslint-disable-next-line no-console
          console.error("[tuninator] listener threw", error);
        }
      }
    }
  }
}
