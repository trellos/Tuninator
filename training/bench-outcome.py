"""
Door 3 (ledger row C3) on the corpus alone: does a small learned classifier,
judged on the OUTCOME target, rank surplus same-pitch Notes better than the
shipped rate feature, one take at a time?

Reads the rows `extract-outcome-rows.ts` writes and the decoded fixture audio.
Dev-side only; nothing under src/ imports it. Needs numpy and scikit-learn.

    python3 training/bench-outcome.py --rows training/out/outcome [--oof out.json]

Every model and setting here is fixed in advance. Nothing is chosen on the
leave-one-take-out column, which is the falsifier's own number.
"""

import argparse
import glob
import json
import os
import wave

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

HOP_MS = 5.0
REFERENCE_IOI_MS = 500.0
FIXED_BEFORE_MS = 100.0
FIXED_AFTER_MS = 200.0
RATE_BEFORE = 1.0
RATE_AFTER = 1.5
RATE_POINTS = 25
REASONS = ["sharpness", "envelope-rise", "ring-out-sharpness", "fine-onset", "chord-decay-excess", "chord-sharpness"]


def read_wav(path):
    with wave.open(path, "rb") as w:
        n = w.getnframes()
        sr = w.getframerate()
        ch = w.getnchannels()
        raw = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        raw = raw.reshape(-1, ch).mean(axis=1)
    return raw, sr


def audio_tracks(x, sr):
    """Fine envelope (dB) and three band log-flux tracks on a 5ms hop."""
    hop = int(round(sr * HOP_MS / 1000))
    win = 1024
    pad = np.concatenate([np.zeros(win // 2, np.float32), x, np.zeros(win, np.float32)])
    frames = (len(x)) // hop
    idx = np.arange(win)[None, :] + hop * np.arange(frames)[:, None]
    seg = pad[idx]
    rms = np.sqrt((seg[:, win // 2 - hop : win // 2 + hop] ** 2).mean(axis=1) + 1e-12)
    env_db = 20 * np.log10(rms + 1e-6)
    spec = np.abs(np.fft.rfft(seg * np.hanning(win)[None, :].astype(np.float32), axis=1))
    logs = np.log1p(100 * spec)
    diff = np.maximum(0, np.diff(logs, axis=0, prepend=logs[:1]))
    freqs = np.fft.rfftfreq(win, 1 / sr)
    bands = [(0, 500), (500, 2000), (2000, 8000)]
    flux = np.stack([diff[:, (freqs >= lo) & (freqs < hi)].mean(axis=1) for lo, hi in bands], axis=1)
    return env_db, flux


def window(track, start_ms, end_ms, points):
    t = np.linspace(start_ms, end_ms, points) / HOP_MS
    i = np.clip(t, 0, len(track) - 1)
    return np.interp(i, np.arange(len(track)), track)


def lg(v, floor=1e-3):
    return float(np.log(max(float(v), floor)))


def features(row, env_db, flux, openings):
    b = row["boundaryAt"]
    ioi = row["localIoiMs"] if row["localIoiMs"] else REFERENCE_IOI_MS
    frag = row["fragmentMs"]
    prev = row["previousOpenAt"]
    nxt = row["nextOnsetAt"]
    s = [
        lg(row["sharpness"]), lg(row["heldSharpness"]), lg(row["fluxRatio"]),
        lg(row["heldFluxRatio"]), lg(row["riseRatio"]), float(row["dipRatio"]),
        lg(row["envelopeOverBaseline"]),
        float(row["levelOverPeak"]) if row["levelOverPeak"] is not None else 1.0,
        1.0 if row["kernelOnset"] else 0.0,
        float(row["decayExcess"]) if row["decayExcess"] is not None else 0.0,
        0.0 if row["decayExcess"] is not None else 1.0,
        lg(row["soundedMs"], 1), lg(ioi, 1), 0.0 if row["localIoiMs"] else 1.0,
        lg(frag / ioi), lg(frag, 1),
        lg((b - prev) / ioi) if prev is not None else 0.0,
        lg((nxt - b) / ioi) if nxt is not None else 0.0,
        1.0 if row["bloomed"] else 0.0,
    ] + [1.0 if row["reason"] == r else 0.0 for r in REASONS]
    npts = int((FIXED_BEFORE_MS + FIXED_AFTER_MS) / HOP_MS)
    fixed_env = window(env_db, b - FIXED_BEFORE_MS, b + FIXED_AFTER_MS, npts)
    fixed_env = fixed_env - fixed_env.max()
    fixed_flux = np.log1p(20 * window(flux[:, 2], b - FIXED_BEFORE_MS, b + FIXED_AFTER_MS, npts))
    rate_env = window(env_db, b - RATE_BEFORE * ioi, b + RATE_AFTER * ioi, RATE_POINTS)
    rate_env = rate_env - rate_env.max()
    rate_flux = [
        np.log1p(20 * window(flux[:, k], b - RATE_BEFORE * ioi, b + RATE_AFTER * ioi, RATE_POINTS))
        for k in range(3)
    ]
    seq = np.concatenate([fixed_env, fixed_flux, rate_env] + rate_flux)
    return np.array(s, np.float64), seq.astype(np.float64)


def load(rows_dir, config, emitted_only=False):
    out = []
    audio = {}
    for path in sorted(glob.glob(os.path.join(rows_dir, f"*.{config}.json"))):
        d = json.load(open(path))
        if d["stem"] not in audio:
            x, sr = read_wav(d["wavPath"])
            audio[d["stem"]] = audio_tracks(x, sr)
        env_db, flux = audio[d["stem"]]
        for r in d["rows"]:
            if emitted_only and not r["emitted"]:
                continue
            s, q = features(r, env_db, flux, d["openings"])
            out.append((d["stem"], r, s, q))
    return out


def performance(stem):
    for suffix in ("-di", "-amped"):
        if stem.endswith(suffix):
            return stem[: -len(suffix)]
    return stem


MODELS = {
    "logistic, scalars": ("s", lambda: make_pipeline(StandardScaler(), LogisticRegression(C=1.0, max_iter=2000))),
    "logistic, scalars + audio": ("sq", lambda: make_pipeline(StandardScaler(), LogisticRegression(C=1.0, max_iter=4000))),
    "MLP 16, scalars + audio": ("sq", lambda: make_pipeline(StandardScaler(), MLPClassifier((16,), alpha=1e-3, max_iter=800, random_state=0))),
    "boosted trees d3 (probe)": ("sq", lambda: HistGradientBoostingClassifier(max_depth=3, random_state=0)),
}


def oof(data, y, groups, make):
    scores = np.full(len(y), np.nan)
    thresholds = {}
    for g in sorted(set(groups)):
        test = groups == g
        train = ~test
        if len(set(y[train])) < 2:
            continue
        m = make()
        m.fit(data[train], y[train])
        scores[test] = m.predict_proba(data[test])[:, 1]
        tr = m.predict_proba(data[train])[:, 1]
        # Zero label cost on the TRAINING takes: above every paired row there.
        thresholds[g] = float(tr[y[train] == 0].max()) if (y[train] == 0).any() else 1.0
    return scores, thresholds


def zero_cost(scores, y):
    ok = ~np.isnan(scores)
    top = scores[ok & (y == 0)].max()
    return int((scores[ok & (y == 1)] > top).sum())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", default="training/out/outcome")
    ap.add_argument("--config", default="off")
    ap.add_argument("--oof")
    ap.add_argument("--emitted-only", action="store_true",
                    help="only Notes the engine emitted: at the shipped config, the gate's survivors")
    a = ap.parse_args()
    data = load(a.rows, a.config, a.emitted_only)
    stems = np.array([d[0] for d in data])
    y = np.array([0 if d[1]["paired"] else 1 for d in data])
    S = np.stack([d[2] for d in data])
    Q = np.stack([d[3] for d in data])
    X = {"s": S, "sq": np.concatenate([S, Q], axis=1)}
    rate = np.array([d[1]["fragmentMs"] / (d[1]["localIoiMs"] or REFERENCE_IOI_MS) for d in data])
    print(f"config {a.config}: {len(y)} rows, {y.sum()} surplus, {len(set(stems))} takes; "
          f"{S.shape[1]} scalars, {Q.shape[1]} audio values")
    base = roc_auc_score(y, -rate)
    print(f"  rate feature (fragment / local interval), no fitting: AUC {base:.3f}; "
          f"surplus above every paired row: {zero_cost(-rate, y)}")
    per_take = {}
    for st in sorted(set(stems)):
        m = stems == st
        if 0 < y[m].sum() < m.sum():
            per_take[st] = roc_auc_score(y[m], -rate[m])
    results = {"rate": {"loto": base}}
    for name, (cols, make) in MODELS.items():
        for gname, groups in (("take", stems), ("performance", np.array([performance(s) for s in stems]))):
            sc, th = oof(X[cols], y, groups, make)
            ok = ~np.isnan(sc)
            auc = roc_auc_score(y[ok], sc[ok])
            folds = []
            for g in sorted(set(groups)):
                m = (groups == g) & ok
                if 0 < y[m].sum() < m.sum():
                    folds.append(roc_auc_score(y[m], sc[m]) - roc_auc_score(y[m], -rate[m]))
            removed = sum(int(((sc > th.get(g, 2)) & (groups == g) & (y == 1)).sum()) for g in set(groups))
            cost = sum(int(((sc > th.get(g, 2)) & (groups == g) & (y == 0)).sum()) for g in set(groups))
            print(f"  {name:28s} leave-one-{gname:11s} AUC {auc:.3f}  "
                  f"(per-take gain over rate: median {np.median(folds):+.3f}, "
                  f"range {min(folds):+.3f}..{max(folds):+.3f}, {len(folds)} takes)  "
                  f"train-zero-cost threshold removes {removed} surplus, costs {cost} paired")
            results[f"{name} / {gname}"] = {"loto": auc, "scores": sc.tolist(), "thresholds": th}
    print("  rate feature AUC per take:", {k: round(v, 3) for k, v in per_take.items()})
    if a.oof:
        json.dump({"ids": [[d[0], d[1]["id"]] for d in data], "y": y.tolist(), "results": results},
                  open(a.oof, "w"))


if __name__ == "__main__":
    main()
