'use strict';
/**
 * Forced alignment of a known token sequence to transducer (RNN-T) model
 * outputs. Topology: at every encoder frame the model either emits blank or
 * the next token of the lyrics (at most one token per frame). Viterbi finds
 * the most likely frame for every token.
 *
 * Unlike free recognition this never "invents" words: every lyric token gets
 * a frame, in order. It works even when the model cannot recognise the sung
 * words, because only the relative likelihood of the right tokens matters.
 */

/**
 * @param {object} p
 * @param {number} p.T              number of encoder frames
 * @param {number} p.U              number of tokens
 * @param {Int32Array|number[]} p.ys token ids
 * @param {(rows: Array<[number, number]>) => Promise<Float32Array>} p.logits
 *        returns joiner logits [rows.length x V] for (frame, u) pairs
 * @param {number} p.vocab          V
 * @param {number} [p.blank=0]
 * @param {number} [p.minFrame=0]   no token may be emitted before this frame
 * @param {number} [p.beam=0]       0 = exact Viterbi over the full band;
 *                                  otherwise keep only the `beam` best states per frame
 *                                  (biased towards lagging paths, kept for experiments only)
 * @param {Int32Array} [p.bandLo]   optional per-frame limits on the state (tokens emitted
 * @param {Int32Array} [p.bandHi]   before frame t), length T + 1; see coarseAlign()
 * @param {number} [p.batchFrames=8] frames per joiner call in exact mode
 * @param {(done: number) => void} [p.onProgress] fraction 0..1
 * @returns {Promise<Int32Array>} emission frame of every token
 */
async function transducerAlign(p) {
    const { T, U, ys, logits, vocab: V } = p;
    const blank = p.blank || 0;
    const minFrame = p.minFrame || 0;
    const beam = p.beam || 0;
    if (U === 0) return new Int32Array(0);
    if (T - minFrame < U) throw new Error(`Слишком много текста для такого короткого звука (${U} токенов на ${T} кадров)`);

    const NEG = -1e30;
    let score = new Float64Array(U + 1).fill(NEG);
    let next = new Float64Array(U + 1);
    score[0] = 0;
    // back[t*(U+1)+u] = 1 if state u at frame t+1 was reached by emitting token u-1 at frame t
    const back = new Uint8Array(T * (U + 1));

    // The states that can still finish: u <= t (one token per frame after minFrame)
    // and U - u <= T - t (enough frames left), optionally narrowed to a band.
    const bandLo = p.bandLo, bandHi = p.bandHi;
    const lo = (t) => Math.max(0, U - (T - t), bandLo ? bandLo[Math.min(t, T)] : 0);
    const hi = (t) => Math.min(U, Math.max(0, t - minFrame), bandHi ? bandHi[Math.min(t, T)] : U);

    const logsoftmaxPick = (row, off, y) => {
        let m = -Infinity;
        for (let k = 0; k < V; k++) if (row[off + k] > m) m = row[off + k];
        let s = 0;
        for (let k = 0; k < V; k++) s += Math.exp(row[off + k] - m);
        const lse = m + Math.log(s);
        return [row[off + blank] - lse, y >= 0 ? row[off + y] - lse : NEG];
    };

    const step = (t, us, out, base) => {
        next.fill(NEG);
        for (let i = 0; i < us.length; i++) {
            const u = us[i];
            const s = score[u];
            if (s <= NEG / 2) continue;
            const [lb, ly] = logsoftmaxPick(out, (base + i) * V, u < U ? ys[u] : -1);
            const vb = s + lb;
            if (vb > next[u]) { next[u] = vb; back[t * (U + 1) + u] = 0; }
            if (u < U && t >= minFrame) {
                const ve = s + ly;
                if (ve > next[u + 1]) { next[u + 1] = ve; back[t * (U + 1) + u + 1] = 1; }
            }
        }
        // states outside the band of frame t+1 can never finish
        const l1 = lo(t + 1), h1 = hi(t + 1);
        for (let u = 0; u <= U; u++) if (u < l1 || u > h1) next[u] = NEG;
        const tmp = score; score = next; next = tmp;
    };

    if (!beam) {
        const B = Math.max(1, p.batchFrames || 8);
        for (let t0 = 0; t0 < T; t0 += B) {
            const t1 = Math.min(T, t0 + B);
            const rows = []; const perFrame = [];
            for (let t = t0; t < t1; t++) {
                const us = [];
                for (let u = lo(t); u <= hi(t); u++) us.push(u);
                perFrame.push({ t, us, base: rows.length });
                for (const u of us) rows.push([t, u]);
            }
            const out = await logits(rows);
            for (const f of perFrame) step(f.t, f.us, out, f.base);
            if (p.onProgress) p.onProgress(t1 / T);
        }
    } else {
        for (let t = 0; t < T; t++) {
            let us = [];
            for (let u = lo(t); u <= hi(t); u++) if (score[u] > NEG / 2) us.push(u);
            if (us.length > beam) {
                us.sort((a, b) => score[b] - score[a]);
                us = us.slice(0, beam).sort((a, b) => a - b);
                const keep = new Set(us);
                for (let u = 0; u <= U; u++) if (!keep.has(u)) score[u] = NEG;
            }
            const out = await logits(us.map((u) => [t, u]));
            step(t, us, out, 0);
            if (p.onProgress && (t % 25 === 0 || t === T - 1)) p.onProgress((t + 1) / T);
        }
    }

    if (score[U] <= NEG / 2) throw new Error('Не удалось выровнять текст по звуку');
    const emit = new Int32Array(U);
    let u = U;
    for (let t = T - 1; t >= 0 && u > 0; t--) {
        if (back[t * (U + 1) + u] === 1) { u--; emit[u] = t; }
    }
    return emit;
}

/**
 * Cheap first pass for long clips: the same one-token-per-frame Viterbi, but
 * with context-free scores (one joiner row per frame, computed with an
 * averaged decoder state). On 79 sung 30 s excerpts its path stayed within
 * 29 tokens of the exact one (p95: 10), so the exact pass only needs a narrow
 * band around it.
 *
 * @param {object} p
 * @param {number} p.T
 * @param {number} p.U
 * @param {Int32Array|number[]} p.ys
 * @param {Float32Array} p.rows   joiner logits [T x V] for the averaged decoder state
 * @param {number} p.vocab
 * @param {number} [p.blank=0]
 * @param {number} [p.minFrame=0]
 * @returns {Int32Array} path[t] = tokens emitted before frame t (length T + 1)
 */
function coarseAlign(p) {
    const { T, U, ys, rows, vocab: V } = p;
    const blank = p.blank || 0;
    const minFrame = p.minFrame || 0;
    const NEG = -1e30;
    const path = new Int32Array(T + 1);
    if (U === 0) return path;

    let score = new Float64Array(U + 1).fill(NEG);
    let next = new Float64Array(U + 1);
    score[0] = 0;
    const back = new Uint8Array(T * (U + 1));
    for (let t = 0; t < T; t++) {
        const off = t * V;
        let m = -Infinity;
        for (let k = 0; k < V; k++) if (rows[off + k] > m) m = rows[off + k];
        let s = 0;
        for (let k = 0; k < V; k++) s += Math.exp(rows[off + k] - m);
        const lse = m + Math.log(s);
        const lb = rows[off + blank] - lse;
        const lo = Math.max(0, U - (T - t)), hi = Math.min(U, Math.max(0, t - minFrame));
        const lo1 = Math.max(0, U - (T - t - 1)), hi1 = Math.min(U, Math.max(0, t + 1 - minFrame));
        next.fill(NEG);
        for (let u = lo; u <= hi; u++) {
            const sc = score[u];
            if (sc <= NEG / 2) continue;
            const vb = sc + lb;
            if (vb > next[u]) { next[u] = vb; back[t * (U + 1) + u] = 0; }
            if (u < U && t >= minFrame) {
                const ve = sc + rows[off + ys[u]] - lse;
                if (ve > next[u + 1]) { next[u + 1] = ve; back[t * (U + 1) + u + 1] = 1; }
            }
        }
        for (let u = 0; u <= U; u++) if (u < lo1 || u > hi1) next[u] = NEG;
        const tmp = score; score = next; next = tmp;
    }
    if (score[U] <= NEG / 2) throw new Error('Не удалось выровнять текст по звуку');
    let u = U;
    path[T] = U;
    for (let t = T - 1; t >= 0; t--) {
        if (back[t * (U + 1) + u] === 1) u--;
        path[t] = u;
    }
    return path;
}

/** Band [path - width, path + width] for transducerAlign(). */
function bandAround(path, U, width) {
    const n = path.length;
    const bandLo = new Int32Array(n), bandHi = new Int32Array(n);
    for (let t = 0; t < n; t++) {
        bandLo[t] = Math.max(0, path[t] - width);
        bandHi[t] = Math.min(U, path[t] + width);
    }
    return { bandLo, bandHi };
}

/** path[t] = tokens emitted before frame t, from per-token emission frames. */
function pathFromEmit(emit, T) {
    const path = new Int32Array(T + 1);
    let k = 0;
    for (let t = 0; t <= T; t++) {
        while (k < emit.length && emit[k] < t) k++;
        path[t] = k;
    }
    return path;
}

/**
 * True if the path runs along an edge of the band somewhere (where the edge is
 * the band's, not the natural limit), i.e. the band may have cut off a better
 * path and should be moved.
 */
function touchesBand(path, band, U, minFrame = 0) {
    const T = path.length - 1;
    for (let t = 0; t <= T; t++) {
        const feasLo = Math.max(0, U - (T - t));
        const feasHi = Math.min(U, Math.max(0, t - minFrame));
        if (band.bandLo[t] > feasLo && path[t] <= band.bandLo[t]) return true;
        if (band.bandHi[t] < feasHi && path[t] >= band.bandHi[t]) return true;
    }
    return false;
}

module.exports = { transducerAlign, coarseAlign, bandAround, pathFromEmit, touchesBand };
