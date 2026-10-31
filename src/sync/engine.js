'use strict';
/**
 * Lyrics-to-audio alignment engine.
 *
 * Model: Russian zipformer transducer (Vosk small, int8, ~27 MB) run with
 * onnxruntime. We do not transcribe: the lyrics are known, so the model is
 * only asked *where* each token is (forced alignment): one encoder pass, then
 * a Viterbi search over (frame, token). Measured on 2 server cores (2.1 GHz):
 * ~2 s for a 30 s excerpt, ~20 s for a 3-4 minute song.
 */
const fs = require('fs');
const path = require('path');
const { computeFbank } = require('./fbank');
const { UnigramTokenizer } = require('./tokenizer');
const { transducerAlign, coarseAlign, bandAround, pathFromEmit, touchesBand } = require('./align');

const SAMPLE_RATE = 16000;
const PAD_SEC = 0.5;          // silence added on both sides (the model misbehaves on the very first frames)
const MIN_FRAME = 0;          // (alignment runs only over frames of the real audio, see below)
// Cost (nats) of every 40 ms frame of waiting between the first and the second piece of a word.
// Without it a word's first piece could break away into the pause before its line: "снимаю"
// started 1.4 s before "ни-ма-ю", "куски" at 0 s on a track whose vocal starts at ~0.8 s.
// Only the first gap: penalising every gap inside words broke held notes (excerpt MAE 131 -> 173 ms).
// With it: 79 excerpts within 0.3 s 93.2% -> 93.4%, 8 full songs 91.8% -> 93.0%.
const IN_WORD_WAIT = 0.15;
const FRAME_SEC = 0.04;       // encoder frame = 4 feature frames of 10 ms
const CHUNK_FRAMES = 1800;    // the exported encoder accepts up to ~2000 feature frames
const CHUNK_CONTEXT = 200;    // overlap on each side of a chunk
const EXACT_MAX_CELLS = 120000; // above this (frames x tokens, ~30 s with 150 tokens) align inside a band around a first pass
// Half-width of that band in tokens. On 79 sung 30 s excerpts the first pass strayed <= 29
// tokens and band 48 gave the exact result; on full songs a repeated chorus led it ~60 tokens
// astray, band 96 matched the exact result on all 8 test songs (144 changed nothing).
const bandWidth = (U) => Math.min(96, Math.max(48, Math.round(U / 6)));
const COARSE_BATCH = 256;      // frames per joiner call in the first pass
const MAX_REFINE = 4;          // extra banded passes when the path presses against the band
// Measured on 40 sung 30 s excerpts with hand-labelled word onsets: the model
// fires ~76 ms early (median). Shift by 50 ms, keeping text a hair ahead of the voice.
const START_OFFSET_SEC = 0.05;

class AlignEngine {
    /**
     * @param {object} opts
     * @param {string} opts.modelDir folder with encoder/decoder/joiner .onnx and tokens.json
     * @param {object} [opts.ort]    onnxruntime module (default: require('onnxruntime-node'))
     * @param {number} [opts.threads]
     */
    constructor(opts) {
        this.modelDir = opts.modelDir;
        this.ort = opts.ort || require('onnxruntime-node');
        this.threads = Math.max(1, opts.threads || 1);
        this.tokenizer = new UnigramTokenizer(JSON.parse(fs.readFileSync(path.join(this.modelDir, 'tokens.json'), 'utf8')));
    }

    async load() {
        if (this.encoder) return;
        const ort = this.ort;
        const mk = (file, threads) => {
            const p = path.join(this.modelDir, file);
            const options = { intraOpNumThreads: threads, interOpNumThreads: 1, executionMode: 'sequential', graphOptimizationLevel: 'all' };
            // Native code cannot read inside app.asar: fall back to an in-memory copy.
            const src = p.includes('.asar' + path.sep) ? fs.readFileSync(p) : p;
            return ort.InferenceSession.create(src, options);
        };
        [this.encoder, this.decoder, this.joiner] = await Promise.all([
            mk('encoder.int8.onnx', this.threads),
            mk('decoder.int8.onnx', 1),
            mk('joiner.int8.onnx', this.threads),
        ]);
    }

    async release() {
        for (const s of [this.encoder, this.decoder, this.joiner]) {
            if (s && s.release) { try { await s.release(); } catch (e) { /* ignore */ } }
        }
        this.encoder = this.decoder = this.joiner = null;
    }

    /** Encoder over the whole clip in overlapping chunks. Returns frames + their times (padded timeline). */
    async encode(feats, onProgress) {
        const { data, frames: T, dim } = feats;
        const ort = this.ort;
        const outFrames = []; const times = [];
        let encDim = 0;
        const total = Math.max(1, Math.ceil(T / (CHUNK_FRAMES - 2 * CHUNK_CONTEXT)));
        let done = 0;
        const hop = T <= CHUNK_FRAMES ? T : CHUNK_FRAMES - 2 * CHUNK_CONTEXT;
        for (let c0 = 0; c0 < T; c0 += hop) {
            const c1 = Math.min(T, c0 + hop);
            const a = T <= CHUNK_FRAMES ? 0 : Math.max(0, c0 - CHUNK_CONTEXT);
            const b = T <= CHUNK_FRAMES ? T : Math.min(T, c1 + CHUNK_CONTEXT);
            const n = b - a;
            const x = new ort.Tensor('float32', data.slice(a * dim, b * dim), [1, n, dim]);
            const xl = new ort.Tensor('int64', BigInt64Array.from([BigInt(n)]), [1]);
            const res = await this.encoder.run({ [this.encoder.inputNames[0]]: x, [this.encoder.inputNames[1]]: xl });
            const enc = res[this.encoder.outputNames[0]];
            const lens = res[this.encoder.outputNames[1]];
            const len = lens ? Number(lens.data[0]) : enc.dims[1];
            encDim = enc.dims[2];
            for (let k = 0; k < len; k++) {
                const fr = a + 4 * k;
                if (fr < c0 || fr >= c1) continue;
                outFrames.push(enc.data.subarray(k * encDim, (k + 1) * encDim));
                times.push(fr * 0.01);
            }
            done++;
            if (onProgress) onProgress(Math.min(1, done / total));
        }
        const out = new Float32Array(outFrames.length * encDim);
        outFrames.forEach((f, i) => out.set(f, i * encDim));
        return { data: out, frames: outFrames.length, dim: encDim, times };
    }

    /** Decoder outputs for every prefix of the token sequence (context = last 2 tokens). */
    async decoderStates(ys) {
        const ort = this.ort;
        const U = ys.length;
        const ctx = new BigInt64Array((U + 1) * 2);
        let p1 = 0, p2 = 0; // blank context at the start
        for (let u = 0; u <= U; u++) {
            ctx[u * 2] = BigInt(p1); ctx[u * 2 + 1] = BigInt(p2);
            if (u < U) { p1 = p2; p2 = ys[u]; }
        }
        const res = await this.decoder.run({ [this.decoder.inputNames[0]]: new ort.Tensor('int64', ctx, [U + 1, 2]) });
        const d = res[this.decoder.outputNames[0]];
        return { data: d.data, dim: d.dims[1] };
    }

    /**
     * @param {Float32Array} samples mono 16 kHz PCM of the clip
     * @param {Array<{ words: Array<{ spoken: string[] }> }>} lines from parseLyrics()
     * @param {(stage: string, fraction: number) => void} [onProgress]
     * @returns {Promise<{ words: Array<{ line: number, word: number, start: number, end: number }>, warnings: string[] }>}
     */
    async align(samples, lines, onProgress = () => { }) {
        await this.load();
        const duration = samples.length / SAMPLE_RATE;

        // tokens of every word
        const ys = []; const wordTok = [];
        lines.forEach((line, li) => line.words.forEach((w, wi) => {
            const first = ys.length;
            for (const sw of w.spoken) ys.push(...this.tokenizer.encodeWord(sw));
            wordTok.push({ line: li, word: wi, first, last: ys.length - 1 });
        }));
        if (ys.length === 0) throw new Error('В тексте нет слов для выравнивания');

        onProgress('features', 0);
        const pad = new Float32Array(Math.round(PAD_SEC * SAMPLE_RATE));
        const padded = new Float32Array(samples.length + 2 * pad.length);
        padded.set(samples, pad.length);
        const feats = computeFbank(padded);
        onProgress('features', 1);

        const full = await this.encode(feats, (f) => onProgress('encoder', f));
        // The padding is there to give the encoder context, never for words: align only over
        // frames of the real audio.
        let f0 = 0, f1 = full.frames;
        while (f0 < f1 && full.times[f0] < PAD_SEC - 0.02) f0++;
        while (f1 > f0 && full.times[f1 - 1] > PAD_SEC + duration) f1--;
        const enc = { data: full.data.subarray(f0 * full.dim, f1 * full.dim), frames: f1 - f0, dim: full.dim, times: full.times.slice(f0, f1) };
        const T = enc.frames, U = ys.length;
        if (T - MIN_FRAME < U) throw new Error('Текста больше, чем помещается в этот отрывок. Проверьте, что текст соответствует звуку.');

        const dec = await this.decoderStates(ys);
        // waiting cost between pieces of one word (state u = u pieces emitted)
        const stay = new Float64Array(U + 1);
        const wait = this.inWordWait !== undefined ? this.inWordWait : IN_WORD_WAIT;
        const tokWord = new Int32Array(U);
        wordTok.forEach((w, i) => { for (let k = w.first; k <= w.last; k++) tokWord[k] = i; });
        for (let u = 1; u < U; u++) {
            // only after the first piece of a word; between words and later inside a word waiting is free
            if (tokWord[u - 1] === tokWord[u] && (u < 2 || tokWord[u - 2] !== tokWord[u])) stay[u] = wait;
        }
        const ort = this.ort;
        const E = enc.dim, D = dec.dim;
        const vocab = this.tokenizer.pieces.length;
        const logits = async (rows) => {
            const n = rows.length;
            const e = new Float32Array(n * E), d = new Float32Array(n * D);
            for (let i = 0; i < n; i++) {
                const [t, u] = rows[i];
                e.set(enc.data.subarray(t * E, (t + 1) * E), i * E);
                d.set(dec.data.subarray(u * D, (u + 1) * D), i * D);
            }
            const res = await this.joiner.run({
                [this.joiner.inputNames[0]]: new ort.Tensor('float32', e, [n, E]),
                [this.joiner.inputNames[1]]: new ort.Tensor('float32', d, [n, D]),
            });
            return res[this.joiner.outputNames[0]].data;
        };

        // Short clips: exact Viterbi over every (frame, token) pair. Long clips: a
        // context-free first pass, then the exact pass inside a band around it.
        const forceBand = this.bandOverride !== undefined;
        const useBand = forceBand || T * (U + 1) > EXACT_MAX_CELLS;
        let band = {};
        if (useBand) {
            const mean = new Float32Array(D);
            for (let u = 0; u <= U; u++) for (let k = 0; k < D; k++) mean[k] += dec.data[u * D + k];
            for (let k = 0; k < D; k++) mean[k] /= U + 1;
            const rows = new Float32Array(T * vocab);
            for (let t0 = 0; t0 < T; t0 += COARSE_BATCH) {
                const n = Math.min(COARSE_BATCH, T - t0);
                const e = enc.data.subarray(t0 * E, (t0 + n) * E);
                const d = new Float32Array(n * D);
                for (let i = 0; i < n; i++) d.set(mean, i * D);
                const res = await this.joiner.run({
                    [this.joiner.inputNames[0]]: new ort.Tensor('float32', Float32Array.from(e), [n, E]),
                    [this.joiner.inputNames[1]]: new ort.Tensor('float32', d, [n, D]),
                });
                rows.set(res[this.joiner.outputNames[0]].data, t0 * vocab);
                onProgress('align', 0.15 * (t0 + n) / T);
            }
            const path = coarseAlign({ T, U, ys, rows, vocab, blank: 0, minFrame: MIN_FRAME, stay });
            band = bandAround(path, U, forceBand ? this.bandOverride : bandWidth(U));
        }
        const p0 = useBand ? 0.15 : 0, p1 = useBand ? 0.8 : 1;
        let emit = await transducerAlign({
            T, U, ys, logits, vocab, blank: 0, minFrame: MIN_FRAME, stay,
            bandLo: band.bandLo, bandHi: band.bandHi,
            onProgress: (f) => onProgress('align', p0 + (p1 - p0) * f),
        });
        // Repeated choruses can lead the first pass astray by more than the band. If the
        // best path presses against a band edge, move the band onto it and search again.
        this.lastRefinePasses = 0;
        for (let pass = 0; useBand && pass < MAX_REFINE; pass++) {
            const path = pathFromEmit(emit, T);
            if (!touchesBand(path, band, U, MIN_FRAME)) break;
            band = bandAround(path, U, forceBand ? this.bandOverride : bandWidth(U));
            const a = p1 + (1 - p1) * pass / MAX_REFINE, b = p1 + (1 - p1) * (pass + 1) / MAX_REFINE;
            emit = await transducerAlign({
                T, U, ys, logits, vocab, blank: 0, minFrame: MIN_FRAME, stay,
                bandLo: band.bandLo, bandHi: band.bandHi,
                onProgress: (f) => onProgress('align', a + (b - a) * f),
            });
            this.lastRefinePasses = pass + 1;
        }
        onProgress('align', 1);

        const tokTime = (k) => enc.times[emit[k]] - PAD_SEC;
        const words = wordTok.map((w) => {
            if (w.last < w.first) return { line: w.line, word: w.word, start: null, end: null };
            const start = Math.max(0, tokTime(w.first) + START_OFFSET_SEC);
            const end = Math.max(start + 0.08, tokTime(w.last) + 2 * FRAME_SEC);
            return { line: w.line, word: w.word, start, end: Math.min(end, duration) };
        });
        fillMissing(words, duration);
        return { words, warnings: checkPlausibility(words, duration) };
    }
}

/** Words with nothing to pronounce take the time of their neighbours. */
function fillMissing(words, duration) {
    for (let i = 0; i < words.length; i++) {
        if (words[i].start !== null) continue;
        const prev = words.slice(0, i).reverse().find((w) => w.start !== null);
        const next = words.slice(i + 1).find((w) => w.start !== null);
        const t = prev ? prev.end : next ? next.start : 0;
        words[i].start = t; words[i].end = Math.min(duration, t + 0.1);
    }
}

/** Detects the typical symptom of lyrics that do not match the clip: words crammed together at an edge. */
function checkPlausibility(words, duration) {
    const warnings = [];
    if (words.length < 6) return warnings;
    const crammed = (list) => {
        let n = 0;
        for (let i = 1; i < list.length; i++) if (Math.abs(list[i].start - list[i - 1].start) < 0.07) n++; else break;
        return n;
    };
    const tail = crammed(words.slice().reverse());
    const head = crammed(words);
    if (tail >= 4) warnings.push(`Последние ${tail + 1} слов сжаты в самый конец: похоже, их нет в этом отрывке.`);
    if (head >= 4) warnings.push(`Первые ${head + 1} слов сжаты в начало: похоже, отрывок начинается позже текста.`);
    return warnings;
}

module.exports = { AlignEngine, SAMPLE_RATE };
