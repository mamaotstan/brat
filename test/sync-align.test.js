'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { transducerAlign, coarseAlign, bandAround } = require('../src/sync/align');

// Synthetic "model": vocab of 6 (0 = blank). Token u is likely only at its true
// frame; elsewhere blank dominates. Mild context-dependence so that the exact
// and the context-free passes see slightly different scores.
function makeProblem(T, truth, ys, V = 6, seed = 1) {
    let s = seed;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const noise = Float32Array.from({ length: T * V }, () => rnd() * 0.5);
    const at = new Map(truth.map((t, u) => [t, u]));
    const row = (t, u, out, off) => {
        for (let k = 0; k < V; k++) out[off + k] = noise[t * V + k];
        out[off] += 3; // blank
        if (at.has(t)) out[off + ys[at.get(t)]] += 6 + 0.2 * (u === at.get(t) ? 1 : 0);
    };
    const logits = async (rows) => {
        const out = new Float32Array(rows.length * V);
        rows.forEach(([t, u], i) => row(t, u, out, i * V));
        return out;
    };
    const coarseRows = new Float32Array(T * V);
    for (let t = 0; t < T; t++) row(t, -1, coarseRows, t * V);
    return { logits, coarseRows, V };
}

test('exact alignment finds the frame of every token', async () => {
    const ys = [1, 2, 3, 4, 5, 1, 2, 3];
    const truth = [5, 9, 14, 20, 21, 30, 41, 47];
    const { logits, V } = makeProblem(60, truth, ys);
    const emit = await transducerAlign({ T: 60, U: ys.length, ys, logits, vocab: V, minFrame: 3 });
    assert.deepStrictEqual(Array.from(emit), truth);
});

test('banded alignment around the first pass equals the exact one', async () => {
    const ys = Array.from({ length: 40 }, (_, i) => 1 + (i % 5));
    const truth = ys.map((_, u) => 4 + u * 5 + (u % 3));
    const T = truth[truth.length - 1] + 12;
    const { logits, coarseRows, V } = makeProblem(T, truth, ys);
    const exact = await transducerAlign({ T, U: ys.length, ys, logits, vocab: V, minFrame: 3 });
    const path = coarseAlign({ T, U: ys.length, ys, rows: coarseRows, vocab: V, minFrame: 3 });
    assert.strictEqual(path.length, T + 1);
    assert.strictEqual(path[0], 0);
    assert.strictEqual(path[T], ys.length);
    for (let t = 1; t <= T; t++) assert.ok(path[t] - path[t - 1] === 0 || path[t] - path[t - 1] === 1);
    const { bandLo, bandHi } = bandAround(path, ys.length, 4);
    const banded = await transducerAlign({ T, U: ys.length, ys, logits, vocab: V, minFrame: 3, bandLo, bandHi });
    assert.deepStrictEqual(Array.from(banded), Array.from(exact));
    assert.deepStrictEqual(Array.from(exact), truth);
});

test('too much text for the clip is reported, not crammed', async () => {
    const ys = [1, 2, 3, 4, 5];
    const { logits, V } = makeProblem(6, [3, 4, 5, 6, 7], ys);
    await assert.rejects(() => transducerAlign({ T: 6, U: 5, ys, logits, vocab: V, minFrame: 3 }));
});

test('pieces of one word stay together: the first piece does not break away into the pause before it', async () => {
    // one word of 3 pieces; piece 1 has a slightly stronger false peak early (frame 5, e.g. music
    // in the pause) than its true place (frame 28), pieces 2 and 3 are clear at 30 and 32
    const ys = [1, 2, 3], V = 4, T = 40;
    const peaks = { 5: [1, 4.5], 28: [1, 4.0], 30: [2, 6], 32: [3, 6] };
    const logits = async (rows) => {
        const out = new Float32Array(rows.length * V);
        rows.forEach(([t], i) => { out[i * V] = 3; const pk = peaks[t]; if (pk) out[i * V + pk[0]] += pk[1]; });
        return out;
    };
    const free = await transducerAlign({ T, U: 3, ys, logits, vocab: V });
    assert.deepStrictEqual(Array.from(free), [5, 30, 32]); // the old behaviour
    const stay = Float64Array.from([0, 0.15, 0.15, 0]);   // waiting inside the word costs 0.15 per frame
    const kept = await transducerAlign({ T, U: 3, ys, logits, vocab: V, stay });
    assert.deepStrictEqual(Array.from(kept), [28, 30, 32]);
});
