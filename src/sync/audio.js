'use strict';
const { spawn } = require('child_process');

/** Path to ffmpeg: bundled ffmpeg-static (unpacked from asar) or the system one. */
function ffmpegPath() {
    try {
        let p = require('ffmpeg-static');
        if (p && p.includes('app.asar')) p = p.replace('app.asar', 'app.asar.unpacked');
        if (p) return p;
    } catch (e) { /* not installed */ }
    return 'ffmpeg';
}

/**
 * Decodes (a fragment of) any audio/video file to mono float32 PCM.
 * @param {string} file
 * @param {{ start?: number, duration?: number, sampleRate?: number, ffmpeg?: string }} [opts]
 * @returns {Promise<Float32Array>}
 */
function decodeAudio(file, opts = {}) {
    const sr = opts.sampleRate || 16000;
    const args = ['-v', 'error', '-nostdin'];
    if (opts.start > 0) args.push('-ss', String(opts.start));
    if (opts.duration > 0) args.push('-t', String(opts.duration));
    args.push('-i', file, '-vn', '-ac', '1', '-ar', String(sr), '-f', 'f32le', '-');
    return new Promise((resolve, reject) => {
        const p = spawn(opts.ffmpeg || ffmpegPath(), args, { windowsHide: true });
        const chunks = []; let err = '';
        p.stdout.on('data', (d) => chunks.push(d));
        p.stderr.on('data', (d) => { err += d; });
        p.on('error', reject);
        p.on('close', (code) => {
            if (code !== 0) return reject(new Error('ffmpeg: ' + (err.trim() || `код ${code}`)));
            const b = Buffer.concat(chunks);
            const ab = b.buffer.slice(b.byteOffset, b.byteOffset + (b.byteLength - (b.byteLength % 4)));
            resolve(new Float32Array(ab));
        });
    });
}

/**
 * Compact waveform for drawing: peak amplitude per bucket.
 * @returns {Promise<{ peaks: number[], duration: number, bucketSec: number }>}
 */
async function waveformPeaks(file, opts = {}) {
    const sr = 8000;
    const x = await decodeAudio(file, Object.assign({}, opts, { sampleRate: sr }));
    const bucketSec = opts.bucketSec || 0.01;
    const n = Math.max(1, Math.round(sr * bucketSec));
    const peaks = [];
    for (let i = 0; i < x.length; i += n) {
        let m = 0;
        for (let j = i; j < Math.min(x.length, i + n); j++) { const v = Math.abs(x[j]); if (v > m) m = v; }
        peaks.push(Math.round(m * 1000) / 1000);
    }
    return { peaks, duration: x.length / sr, bucketSec };
}

/** Media duration in seconds via ffmpeg (no ffprobe needed). */
function probeDuration(file, opts = {}) {
    return new Promise((resolve, reject) => {
        const p = spawn(opts.ffmpeg || ffmpegPath(), ['-nostdin', '-i', file], { windowsHide: true });
        let err = '';
        p.stderr.on('data', (d) => { err += d; });
        p.on('error', reject);
        p.on('close', () => {
            const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
            if (!m) return reject(new Error('Не удалось прочитать длительность файла'));
            resolve(+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]));
        });
    });
}

module.exports = { decodeAudio, waveformPeaks, probeDuration, ffmpegPath };
