#!/usr/bin/env node
'use strict';
/**
 * Runs auto-sync on a file from the command line and prints word timings.
 *   node test/align-cli.js track.mp3 lyrics.txt [--start 12.5] [--dur 30] [--threads 2] [--json out.json]
 * Uses onnxruntime-node when installed, otherwise the Python-backed test double.
 */
const fs = require('fs');
const path = require('path');
const { parseLyrics } = require('../src/sync/text');
const { decodeAudio } = require('../src/sync/audio');
const { AlignEngine } = require('../src/sync/engine');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const [audioFile, lyricsFile] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

(async () => {
    let ort;
    try { if (process.env.FAKE_ORT) throw new Error('forced'); ort = require('onnxruntime-node'); } catch (e) { ort = require('./helpers/fake-ort'); }
    const lines = parseLyrics(fs.readFileSync(lyricsFile, 'utf8'));
    const start = parseFloat(opt('start', '0')); const dur = parseFloat(opt('dur', '0'));
    const samples = await decodeAudio(audioFile, { start, duration: dur });
    const engine = new AlignEngine({ modelDir: path.join(__dirname, '..', 'assets', 'models', 'ru-small'), ort, threads: parseInt(opt('threads', '2')) });
    const t0 = Date.now();
    let last = '';
    const res = await engine.align(samples, lines, (stage, f) => {
        const s = `${stage} ${Math.round(f * 100)}%`;
        if (s !== last && (f === 0 || f === 1)) { process.stderr.write(s + '\n'); last = s; }
    });
    const sec = (Date.now() - t0) / 1000;
    for (const w of res.words) {
        const word = lines[w.line].words[w.word];
        console.log(`${w.start.toFixed(2)}\t${w.end.toFixed(2)}\t${word.text}`);
    }
    for (const m of res.warnings) console.log('WARN', m);
    console.error(`audio ${(samples.length / 16000).toFixed(1)}s, align ${sec.toFixed(2)}s`);
    if (opt('json')) fs.writeFileSync(opt('json'), JSON.stringify(res));
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
