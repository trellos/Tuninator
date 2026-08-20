/**
 * `IConfidenceModel`: how per-facet confidences become one number.
 *
 * A mean of the parts that actually exist, rather than a fixed weighted sum
 * over a fixed set. The parts available differ by Note — a single picked note
 * has no spectral fit, a strummed chord has no useful YIN periodicity — and a
 * fixed formula either invents values for the missing parts or systematically
 * under-reports whichever kind of Note has fewer of them.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import type { ConfidenceParts, IConfidenceModel } from "../contracts.js";

export class DefaultConfidenceModel implements IConfidenceModel {
  blend(parts: ConfidenceParts): number {
    const values: number[] = [];
    if (parts.pitch !== undefined) values.push(parts.pitch);
    if (parts.stability !== undefined) values.push(parts.stability);
    if (parts.amplitude !== undefined) values.push(Math.min(1, parts.amplitude));
    if (parts.spectralFit !== undefined) values.push(parts.spectralFit);
    if (values.length === 0) return 0;
    const sum = values.reduce((a, b) => a + b, 0);
    return Math.max(0, Math.min(1, sum / values.length));
  }
}
