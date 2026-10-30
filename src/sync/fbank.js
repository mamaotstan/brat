'use strict';
/**
 * Kaldi-compatible log-mel filterbank (the same features sherpa-onnx /
 * kaldi-native-fbank compute for icefall zipformer models).
 *
 * Defaults: 16 kHz, 25 ms frames, 10 ms shift, 80 mel bins, povey window,
 * pre-emphasis 0.97, DC removal, FFT size rounded up to a power of two,
 * snip_edges = false (frames are centred, edges are reflected).
 *
 * Pure JS, no dependencies. Output is row-major Float32Array [frames x bins].
 */

const DEFAULTS = {
    sampleRate: 16000,
    frameLengthMs: 25,
    frameShiftMs: 10,
    numBins: 80,
    lowFreq: 20,
    highFreq: -400, // <= 0 means "nyquist + highFreq"
    window: 'povey',
    preemph: 0.97,
    removeDc: true,
};

const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };
const melScale = (f) => 1127.0 * Math.log(1.0 + f / 700.0);

function makeWindow(type, n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        if (type === 'povey') w[i] = Math.pow(0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)), 0.85);
        else if (type === 'hann') w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
        else if (type === 'hamming') w[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (n - 1));
        else w[i] = 1;
    }
    return w;
}

/** Sparse triangular mel filters over FFT bins 0..nfft/2-1 (Kaldi MelBanks). */
function makeMelBanks(o, nfft) {
    const numFftBins = nfft / 2;
    const nyquist = o.sampleRate / 2;
    const high = o.highFreq > 0 ? o.highFreq : nyquist + o.highFreq;
    const melLow = melScale(o.lowFreq);
    const melHigh = melScale(high);
    const delta = (melHigh - melLow) / (o.numBins + 1);
    const binMel = new Float64Array(numFftBins);
    for (let i = 0; i < numFftBins; i++) binMel[i] = melScale(i * o.sampleRate / nfft);
    const banks = [];
    for (let b = 0; b < o.numBins; b++) {
        const l = melLow + b * delta, c = melLow + (b + 1) * delta, r = melLow + (b + 2) * delta;
        let first = -1; const weights = [];
        for (let i = 0; i < numFftBins; i++) {
            const m = binMel[i];
            if (m > l && m < r) {
                if (first < 0) first = i;
                weights.push(m <= c ? (m - l) / (c - l) : (r - m) / (r - c));
            }
        }
        banks.push({ first: Math.max(0, first), weights: Float64Array.from(weights) });
    }
    return banks;
}

/** In-place iterative radix-2 complex FFT. */
function makeFft(n) {
    const levels = Math.log2(n);
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
        let r = 0;
        for (let j = 0; j < levels; j++) r |= ((i >>> j) & 1) << (levels - 1 - j);
        rev[i] = r;
    }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
    return (re, im) => {
        for (let i = 0; i < n; i++) {
            const j = rev[i];
            if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
        }
        for (let size = 2; size <= n; size <<= 1) {
            const half = size >>> 1, step = n / size;
            for (let i = 0; i < n; i += size) {
                for (let j = 0, k = 0; j < half; j++, k += step) {
                    const a = i + j, b = a + half;
                    const tre = re[b] * cos[k] + im[b] * sin[k];
                    const tim = -re[b] * sin[k] + im[b] * cos[k];
                    re[b] = re[a] - tre; im[b] = im[a] - tim;
                    re[a] += tre; im[a] += tim;
                }
            }
        }
    };
}

/**
 * @param {Float32Array} samples mono PCM in [-1, 1] at opts.sampleRate
 * @param {object} [options]
 * @returns {{ data: Float32Array, frames: number, dim: number }}
 */
function computeFbank(samples, options = {}) {
    const o = Object.assign({}, DEFAULTS, options);
    const flen = Math.round(o.sampleRate * o.frameLengthMs / 1000);
    const shift = Math.round(o.sampleRate * o.frameShiftMs / 1000);
    const nfft = nextPow2(flen);
    const n = samples.length;
    const frames = Math.floor((n + Math.floor(shift / 2)) / shift);
    const dim = o.numBins;
    const out = new Float32Array(frames * dim);
    if (frames === 0) return { data: out, frames: 0, dim };

    const win = makeWindow(o.window, flen);
    const banks = makeMelBanks(o, nfft);
    const fft = makeFft(nfft);
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    const frame = new Float64Array(flen);
    const power = new Float64Array(nfft / 2);
    const eps = 1.1920928955078125e-7; // float32 epsilon, as in Kaldi

    for (let f = 0; f < frames; f++) {
        const start = f * shift + Math.floor(shift / 2) - Math.floor(flen / 2);
        let mean = 0;
        for (let i = 0; i < flen; i++) {
            let s = start + i;
            if (s < 0) s = -s - 1;
            else if (s >= n) s = 2 * n - 1 - s;
            if (s < 0) s = 0; else if (s >= n) s = n - 1; // tiny inputs
            frame[i] = samples[s];
            mean += frame[i];
        }
        if (o.removeDc) {
            mean /= flen;
            for (let i = 0; i < flen; i++) frame[i] -= mean;
        }
        if (o.preemph) {
            for (let i = flen - 1; i > 0; i--) frame[i] -= o.preemph * frame[i - 1];
            frame[0] -= o.preemph * frame[0];
        }
        for (let i = 0; i < nfft; i++) { re[i] = i < flen ? frame[i] * win[i] : 0; im[i] = 0; }
        fft(re, im);
        for (let i = 0; i < nfft / 2; i++) power[i] = re[i] * re[i] + im[i] * im[i];
        const row = f * dim;
        for (let b = 0; b < dim; b++) {
            const { first, weights } = banks[b];
            let e = 0;
            for (let k = 0; k < weights.length; k++) e += weights[k] * power[first + k];
            out[row + b] = Math.log(e > eps ? e : eps);
        }
    }
    return { data: out, frames, dim };
}

module.exports = { computeFbank };
