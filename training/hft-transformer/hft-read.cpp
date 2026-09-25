// hft-read — read the published model's frame activations, whole-clip or at
// chosen decision points, with the pinned CrispASR runtime unmodified.
//
// This file includes CrispASR's `src/hft_transformer.cpp` (commit 0864a3e0)
// as a translation unit rather than patching it: the runtime's own mel front
// end, encoder/frequency-decoder chunks and time decoder are `static`, and
// reading activations at a chosen window alignment needs exactly those, not
// the transcribe() wrapper around them. Nothing in the included file is
// changed; build.sh links this against the same build's crispasr-core and
// ggml libraries and NOT against libhft-transformer.a, so there is one copy
// of the runtime in the binary.
//
// Two modes.
//
//   full <gguf> <pcm16k.f32> <prefix> [threads]
//     The whole clip exactly as hft_transformer_transcribe() runs it: log-mel,
//     32 margin frames of log(1e-8) each side, tail padded to a multiple of
//     128, one 192-frame window per 128 answered frames. Writes
//       <prefix>.mel.f32       T x 256, the log-mel before padding
//       <prefix>.onset.f32     Tpad x 88, post-sigmoid (likewise offset, mpe)
//       <prefix>.velocity.f32  Tpad x 88, the velocity head's argmax bin
//       <prefix>.notes.txt     the runtime's own decoded notes (onset, offset, midi, velocity)
//       <prefix>.meta.txt      frames, seconds, wall time
//     Answered frame i is centred on sample i*256 (torch.stft, center=True).
//
//   reads <gguf> <pcm16k.f32> <reads.txt> <out.bin> [threads]
//     One window per line of reads.txt, "<endSample> <ringStartSample>", both
//     16kHz sample indices, ringStart a multiple of 256. The model is handed
//     ONLY the audio in [ringStart, endSample): the log-mel is computed on that
//     slice alone, so every STFT frame near endSample sees zeros where audio has
//     not arrived, exactly as the centred STFT pads the end of any clip. The
//     window's 128 answered frames END on the last frame centred at or before
//     endSample; margin and frames outside the slice are log(1e-8), the value
//     the model was trained to read as "no audio". Writes, per read, an int32
//     first-answered-frame index (global frame numbering) followed by
//     onset, offset, mpe, velocity, each 128 x 88 float32.
//
// Frame f of the global grid is centred on sample 256*f of the 16kHz clip,
// so a slice starting at a multiple of 256 keeps the grid.

#include "hft_transformer.cpp"

#include <chrono>
#include <cstdio>
#include <fstream>
#include <sstream>

static std::vector<float> read_f32(const char* path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) {
        std::fprintf(stderr, "hft-read: cannot open %s\n", path);
        std::exit(2);
    }
    f.seekg(0, std::ios::end);
    const size_t n = (size_t)f.tellg() / sizeof(float);
    f.seekg(0);
    std::vector<float> v(n);
    f.read(reinterpret_cast<char*>(v.data()), (std::streamsize)(n * sizeof(float)));
    return v;
}

static void write_f32(const std::string& path, const float* p, size_t n) {
    FILE* f = std::fopen(path.c_str(), "wb");
    if (!f || std::fwrite(p, sizeof(float), n, f) != n) {
        std::fprintf(stderr, "hft-read: cannot write %s\n", path.c_str());
        std::exit(2);
    }
    std::fclose(f);
}

// One 192-frame window (row-major [192][256] log-mel) -> 128 answered frames.
// The body of hft_forward()'s window loop, taken verbatim in its arithmetic.
static bool run_window(hft_transformer_ctx* ctx, const float* window, hft_window_out& wout) {
    auto& hp = ctx->hp;
    const int bins = (int)hp.n_mels;
    const int taps = (int)hp.front_taps;
    const int NF = (int)hp.n_frame;
    const int K = (int)hp.classes_num;
    const int H = (int)hp.hidden;
    int chunk = ctx->params.frame_chunk > 0 ? ctx->params.frame_chunk : HFT_FRAME_CHUNK_DEFAULT;
    chunk = std::max(1, std::min(chunk, NF));
    std::vector<float> tapbuf, encbuf, pitch_major((size_t)H * NF * K);
    for (int c0 = 0; c0 < NF; c0 += chunk) {
        const int nc = std::min(chunk, NF - c0);
        tapbuf.resize((size_t)nc * bins * taps);
        for (int f = 0; f < nc; f++) {
            const int g = c0 + f;
            for (int b = 0; b < bins; b++) {
                float* dst = tapbuf.data() + ((size_t)f * bins + b) * taps;
                const float* src = window + (size_t)g * bins + b;
                for (int m = 0; m < taps; m++)
                    dst[m] = src[(size_t)m * bins];
            }
        }
        if (!hft_encode_chunk(ctx, tapbuf.data(), nc, encbuf))
            return false;
        for (int f = 0; f < nc; f++)
            for (int p = 0; p < K; p++)
                std::memcpy(pitch_major.data() + ((size_t)p * NF + c0 + f) * H,
                            encbuf.data() + ((size_t)f * K + p) * H, (size_t)H * sizeof(float));
    }
    return hft_decode_time(ctx, pitch_major.data(), wout);
}

static hft_transformer_ctx* open_model(const char* path, int threads) {
    hft_transformer_params p = hft_transformer_default_params();
    p.n_threads = threads;
    p.verbosity = 0;
    p.use_gpu = false;
    hft_transformer_ctx* ctx = hft_transformer_init_from_file(path, p);
    if (!ctx) {
        std::fprintf(stderr, "hft-read: cannot load %s\n", path);
        std::exit(2);
    }
    return ctx;
}

static int mode_full(int argc, char** argv) {
    const int threads = argc > 5 ? std::atoi(argv[5]) : 2;
    hft_transformer_ctx* ctx = open_model(argv[2], threads);
    const std::vector<float> pcm = read_f32(argv[3]);
    const std::string prefix = argv[4];

    const auto t0 = std::chrono::steady_clock::now();
    int T = 0;
    const std::vector<float> mel = hft_log_mel(ctx, pcm.data(), (int)pcm.size(), T);
    hft_heads heads;
    if (!hft_forward(ctx, pcm.data(), (int)pcm.size(), heads))
        return 3;
    std::vector<hft_transformer_note_event> notes;
    hft_extract_notes(heads, ctx->hp, ctx->params, notes);
    const double wall = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();

    write_f32(prefix + ".mel.f32", mel.data(), mel.size());
    write_f32(prefix + ".onset.f32", heads.onset.data(), heads.onset.size());
    write_f32(prefix + ".offset.f32", heads.offset.data(), heads.offset.size());
    write_f32(prefix + ".mpe.f32", heads.mpe.data(), heads.mpe.size());
    write_f32(prefix + ".velocity.f32", heads.velocity.data(), heads.velocity.size());
    FILE* nf = std::fopen((prefix + ".notes.txt").c_str(), "w");
    for (const auto& n : notes)
        std::fprintf(nf, "%.6f %.6f %d %d\n", n.onset_time, n.offset_time, n.midi_note, n.velocity);
    std::fclose(nf);
    FILE* mf = std::fopen((prefix + ".meta.txt").c_str(), "w");
    std::fprintf(mf, "frames %d\npadded_frames %d\naudio_seconds %.6f\nwall_seconds %.3f\nthreads %d\nnotes %zu\n", T,
                 heads.T, pcm.size() / 16000.0, wall, threads, notes.size());
    std::fclose(mf);
    std::printf("%s: %d frames (%d padded), %.2fs audio, %.1fs wall, %zu notes\n", prefix.c_str(), T, heads.T,
                pcm.size() / 16000.0, wall, notes.size());
    hft_transformer_free(ctx);
    return 0;
}

static int mode_reads(int argc, char** argv) {
    const int threads = argc > 6 ? std::atoi(argv[6]) : 2;
    hft_transformer_ctx* ctx = open_model(argv[2], threads);
    const std::vector<float> pcm = read_f32(argv[3]);
    std::ifstream in(argv[4]);
    std::vector<std::pair<long, long>> reads;
    for (std::string line; std::getline(in, line);) {
        if (line.empty() || line[0] == '#')
            continue;
        std::istringstream ss(line);
        long end = 0, ring = 0;
        ss >> end >> ring;
        reads.emplace_back(end, ring);
    }
    FILE* out = std::fopen(argv[5], "wb");
    if (!out)
        return 2;

    auto& hp = ctx->hp;
    const int bins = (int)hp.n_mels;
    const int NF = (int)hp.n_frame;
    const int M = (int)hp.n_margin;
    const int hop = (int)hp.hop_size;
    const float minv = std::log(hp.mel_eps);
    std::vector<float> window((size_t)(NF + 2 * M) * bins);
    hft_window_out wout;
    const auto t0 = std::chrono::steady_clock::now();
    for (size_t r = 0; r < reads.size(); r++) {
        const long end = std::min<long>(reads[r].first, (long)pcm.size());
        const long ring = std::max<long>(0, reads[r].second);
        if (ring % hop != 0 || end <= ring) {
            std::fprintf(stderr, "hft-read: bad read %ld %ld\n", reads[r].first, reads[r].second);
            return 4;
        }
        int T = 0;
        const std::vector<float> mel = hft_log_mel(ctx, pcm.data() + ring, (int)(end - ring), T);
        const long ringFrame = ring / hop;
        const long lastFrame = ringFrame + T - 1; // global index of the last frame centred <= end
        const long firstAnswered = lastFrame - (NF - 1);
        const long windowStart = firstAnswered - M;
        for (int w = 0; w < NF + 2 * M; w++) {
            const long local = windowStart + w - ringFrame;
            float* dst = window.data() + (size_t)w * bins;
            if (local >= 0 && local < T)
                std::memcpy(dst, mel.data() + (size_t)local * bins, (size_t)bins * sizeof(float));
            else
                std::fill(dst, dst + bins, minv);
        }
        if (!run_window(ctx, window.data(), wout))
            return 3;
        const int32_t first = (int32_t)firstAnswered;
        std::fwrite(&first, sizeof(first), 1, out);
        std::fwrite(wout.onset.data(), sizeof(float), wout.onset.size(), out);
        std::fwrite(wout.offset.data(), sizeof(float), wout.offset.size(), out);
        std::fwrite(wout.mpe.data(), sizeof(float), wout.mpe.size(), out);
        std::fwrite(wout.velocity.data(), sizeof(float), wout.velocity.size(), out);
        if ((r + 1) % 25 == 0 || r + 1 == reads.size()) {
            const double s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
            std::fprintf(stderr, "  %zu/%zu reads, %.1fs\n", r + 1, reads.size(), s);
        }
    }
    std::fclose(out);
    hft_transformer_free(ctx);
    return 0;
}

// take <gguf> <pcm16k.f32> <reads.txt> <prefix> [threads] [verify]
//   `full` and `reads` in one process, sharing the expensive half. The encoder
//   and frequency decoder are frame-local (each answered frame reads only its
//   own 65 log-mel frames), so an answered frame of a deep read whose 65 frames
//   all sit where the slice's log-mel equals the whole take's — at least 4
//   frames from either end of the slice, where the STFT window is whole —
//   has exactly the whole-take run's frequency-stage output. Those come from
//   one pass over the take; only the last 36 answered frames of a read (and
//   any near the ring's start) are recomputed, then the time decoder runs on
//   the read's own 128 frames as always. The first `verify` reads (default 3)
//   are also computed with no reuse at all and the largest difference printed.
//   Writes <prefix>.{mel,onset,offset,mpe,velocity}.f32 as `full` does, and
//   <prefix>.deep.bin in the `reads` layout.
static int mode_take(int argc, char** argv) {
    const int threads = argc > 6 ? std::atoi(argv[6]) : 2;
    const int verify = argc > 7 ? std::atoi(argv[7]) : 3;
    hft_transformer_ctx* ctx = open_model(argv[2], threads);
    const std::vector<float> pcm = read_f32(argv[3]);
    std::ifstream in(argv[4]);
    std::vector<std::pair<long, long>> reads;
    for (std::string line; std::getline(in, line);) {
        if (line.empty() || line[0] == '#')
            continue;
        std::istringstream ss(line);
        long end = 0, ring = 0;
        ss >> end >> ring;
        reads.emplace_back(end, ring);
    }
    const std::string prefix = argv[5];

    auto& hp = ctx->hp;
    const int bins = (int)hp.n_mels;
    const int NF = (int)hp.n_frame;
    const int M = (int)hp.n_margin;
    const int K = (int)hp.classes_num;
    const int H = (int)hp.hidden;
    const int taps = (int)hp.front_taps;
    const int hop = (int)hp.hop_size;
    const int edge = (int)(hp.n_fft / 2 / hp.hop_size); // frames whose STFT window crosses a slice end: 4
    const float minv = std::log(hp.mel_eps);
    int chunk = ctx->params.frame_chunk > 0 ? ctx->params.frame_chunk : HFT_FRAME_CHUNK_DEFAULT;
    const auto t0 = std::chrono::steady_clock::now();

    // Whole-take log-mel, padded as hft_forward pads it.
    int T = 0;
    const std::vector<float> mel = hft_log_mel(ctx, pcm.data(), (int)pcm.size(), T);
    const int total = ((T + NF - 1) / NF) * NF;
    std::vector<float> padded((size_t)(total + 2 * M) * bins, minv);
    std::memcpy(padded.data() + (size_t)M * bins, mel.data(), (size_t)T * bins * sizeof(float));

    // Frequency-stage output of every answered frame: enc[f][p][h].
    std::vector<float> enc((size_t)total * K * H);
    std::vector<float> tapbuf, encbuf;
    auto encode = [&](const std::vector<const float*>& rows0, std::vector<float>& outv) -> bool {
        // rows0[i] points at the first of frame i's 65 window rows ([taps][bins]).
        outv.assign(rows0.size() * (size_t)K * H, 0.0f);
        for (size_t c0 = 0; c0 < rows0.size(); c0 += (size_t)chunk) {
            const int nc = (int)std::min<size_t>((size_t)chunk, rows0.size() - c0);
            tapbuf.resize((size_t)nc * bins * taps);
            for (int f = 0; f < nc; f++) {
                const float* base = rows0[c0 + f];
                for (int b = 0; b < bins; b++) {
                    float* dst = tapbuf.data() + ((size_t)f * bins + b) * taps;
                    for (int m = 0; m < taps; m++)
                        dst[m] = base[(size_t)m * bins + b];
                }
            }
            if (!hft_encode_chunk(ctx, tapbuf.data(), nc, encbuf))
                return false;
            std::memcpy(outv.data() + c0 * (size_t)K * H, encbuf.data(), (size_t)nc * K * H * sizeof(float));
        }
        return true;
    };
    {
        std::vector<const float*> rows0((size_t)total);
        for (int f = 0; f < total; f++)
            rows0[f] = padded.data() + (size_t)f * bins; // frame f's window starts at padded row f
        if (!encode(rows0, enc))
            return 3;
    }
    const double tEnc = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();

    // Full reading: the time decoder on each 128-frame pass.
    std::vector<float> pitch_major((size_t)H * NF * K);
    hft_window_out wout;
    auto decode = [&](const float* frameMajor /* [NF][K][H] */) -> bool {
        for (int i = 0; i < NF; i++)
            for (int p = 0; p < K; p++)
                std::memcpy(pitch_major.data() + ((size_t)p * NF + i) * H, frameMajor + ((size_t)i * K + p) * H,
                            (size_t)H * sizeof(float));
        return hft_decode_time(ctx, pitch_major.data(), wout);
    };
    std::vector<float> fOn((size_t)total * K), fOff((size_t)total * K), fMpe((size_t)total * K), fVel((size_t)total * K);
    for (int base = 0; base < total; base += NF) {
        if (!decode(enc.data() + (size_t)base * K * H))
            return 3;
        std::memcpy(fOn.data() + (size_t)base * K, wout.onset.data(), (size_t)NF * K * sizeof(float));
        std::memcpy(fOff.data() + (size_t)base * K, wout.offset.data(), (size_t)NF * K * sizeof(float));
        std::memcpy(fMpe.data() + (size_t)base * K, wout.mpe.data(), (size_t)NF * K * sizeof(float));
        std::memcpy(fVel.data() + (size_t)base * K, wout.velocity.data(), (size_t)NF * K * sizeof(float));
    }
    write_f32(prefix + ".mel.f32", mel.data(), mel.size());
    write_f32(prefix + ".onset.f32", fOn.data(), fOn.size());
    write_f32(prefix + ".offset.f32", fOff.data(), fOff.size());
    write_f32(prefix + ".mpe.f32", fMpe.data(), fMpe.size());
    write_f32(prefix + ".velocity.f32", fVel.data(), fVel.size());

    // Deep reads.
    FILE* out = std::fopen((prefix + ".deep.bin").c_str(), "wb");
    if (!out)
        return 2;
    std::vector<float> window((size_t)(NF + 2 * M) * bins);
    std::vector<float> readEnc((size_t)NF * K * H), fresh;
    double worstVerify = 0.0;
    long recomputed = 0;
    for (size_t r = 0; r < reads.size(); r++) {
        const long end = std::min<long>(reads[r].first, (long)pcm.size());
        const long ring = std::max<long>(0, reads[r].second);
        if (ring % hop != 0 || end <= ring) {
            std::fprintf(stderr, "hft-read: bad read %ld %ld\n", reads[r].first, reads[r].second);
            return 4;
        }
        int Ts = 0;
        const std::vector<float> smel = hft_log_mel(ctx, pcm.data() + ring, (int)(end - ring), Ts);
        const long ringFrame = ring / hop;
        const long lastFrame = ringFrame + Ts - 1;
        const long firstAnswered = lastFrame - (NF - 1);
        const long windowStart = firstAnswered - M;
        for (int w = 0; w < NF + 2 * M; w++) {
            const long local = windowStart + w - ringFrame;
            float* dst = window.data() + (size_t)w * bins;
            if (local >= 0 && local < Ts)
                std::memcpy(dst, smel.data() + (size_t)local * bins, (size_t)bins * sizeof(float));
            else
                std::fill(dst, dst + bins, minv);
        }
        // Which answered frames can reuse the whole-take pass.
        std::vector<const float*> todo;
        std::vector<int> todoIdx;
        for (int i = 0; i < NF; i++) {
            const long f = firstAnswered + i;
            const bool lateOk = f + M <= lastFrame - edge;
            const bool earlyOk = ringFrame == 0 || f - M >= ringFrame + edge;
            if (f >= 0 && f < total && lateOk && earlyOk) {
                std::memcpy(readEnc.data() + (size_t)i * K * H, enc.data() + (size_t)f * K * H, (size_t)K * H * sizeof(float));
            } else {
                todo.push_back(window.data() + (size_t)i * bins);
                todoIdx.push_back(i);
            }
        }
        if (!todo.empty()) {
            if (!encode(todo, fresh))
                return 3;
            for (size_t j = 0; j < todo.size(); j++)
                std::memcpy(readEnc.data() + (size_t)todoIdx[j] * K * H, fresh.data() + j * (size_t)K * H,
                            (size_t)K * H * sizeof(float));
            recomputed += (long)todo.size();
        }
        if ((int)r < verify) {
            std::vector<const float*> all((size_t)NF);
            for (int i = 0; i < NF; i++)
                all[i] = window.data() + (size_t)i * bins;
            std::vector<float> check;
            if (!encode(all, check))
                return 3;
            for (size_t j = 0; j < check.size(); j++)
                worstVerify = std::max(worstVerify, (double)std::fabs(check[j] - readEnc[j]));
        }
        if (!decode(readEnc.data()))
            return 3;
        const int32_t first = (int32_t)firstAnswered;
        std::fwrite(&first, sizeof(first), 1, out);
        std::fwrite(wout.onset.data(), sizeof(float), wout.onset.size(), out);
        std::fwrite(wout.offset.data(), sizeof(float), wout.offset.size(), out);
        std::fwrite(wout.mpe.data(), sizeof(float), wout.mpe.size(), out);
        std::fwrite(wout.velocity.data(), sizeof(float), wout.velocity.size(), out);
    }
    std::fclose(out);
    const double wall = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    FILE* mf = std::fopen((prefix + ".meta.txt").c_str(), "w");
    std::fprintf(mf,
                 "frames %d\npadded_frames %d\naudio_seconds %.6f\nreads %zu\nrecomputed_frames %ld\n"
                 "verify_reads %d\nverify_worst_abs %.3e\nencoder_seconds %.1f\nwall_seconds %.1f\nthreads %d\n",
                 T, total, pcm.size() / 16000.0, reads.size(), recomputed, std::min<int>(verify, (int)reads.size()),
                 worstVerify, tEnc, wall, threads);
    std::fclose(mf);
    std::fprintf(stderr, "%s: %d frames, %zu reads (%ld frames recomputed), reuse check %.2e, %.0fs\n", prefix.c_str(), T,
                 reads.size(), recomputed, worstVerify, wall);
    hft_transformer_free(ctx);
    return 0;
}

int main(int argc, char** argv) {
    if (argc >= 5 && std::string(argv[1]) == "full")
        return mode_full(argc, argv);
    if (argc >= 6 && std::string(argv[1]) == "reads")
        return mode_reads(argc, argv);
    if (argc >= 6 && std::string(argv[1]) == "take")
        return mode_take(argc, argv);
    std::fprintf(stderr, "usage: hft-read full <gguf> <pcm16k.f32> <prefix> [threads]\n"
                         "       hft-read reads <gguf> <pcm16k.f32> <reads.txt> <out.bin> [threads]\n"
                         "       hft-read take <gguf> <pcm16k.f32> <reads.txt> <prefix> [threads] [verify]\n");
    return 1;
}
