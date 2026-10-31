'use strict';
/**
 * Child process that runs auto-sync, so the app window never freezes and the
 * model's memory is returned to the system as soon as the job ends.
 *
 * Message in:  { cmd: 'align', audioPath, start, duration, lyrics, modelDir, threads, ffmpeg }
 * Messages out: { type: 'progress', stage, value } ... { type: 'result', result } | { type: 'error', message }
 */
const { parseLyrics } = require('./text');
const { decodeAudio } = require('./audio');
const { AlignEngine } = require('./engine');

// Overall progress: audio 5%, features 5%, encoder 30%, alignment 60%.
const STAGES = { audio: [0, 0.05], features: [0.05, 0.1], encoder: [0.1, 0.4], align: [0.4, 1] };
const send = (m) => { if (process.send) process.send(m); };
const progress = (stage, f) => {
    const [a, b] = STAGES[stage] || [0, 1];
    send({ type: 'progress', stage, value: a + (b - a) * Math.max(0, Math.min(1, f)) });
};

async function run(msg) {
    progress('audio', 0);
    const samples = await decodeAudio(msg.audioPath, { start: msg.start, duration: msg.duration, ffmpeg: msg.ffmpeg });
    if (samples.length < 16000 * 0.5) throw new Error('Отрывок слишком короткий или файл не читается');
    progress('audio', 1);
    const lines = parseLyrics(msg.lyrics);
    if (!lines.length) throw new Error('Вставьте текст песни');
    // BRAT_TEST_ORT lets tests swap in an onnxruntime test double.
    const ort = process.env.BRAT_TEST_ORT ? require(process.env.BRAT_TEST_ORT) : undefined;
    const engine = new AlignEngine({ modelDir: msg.modelDir, threads: msg.threads, ort });
    const res = await engine.align(samples, lines, progress);
    await engine.release();
    const out = lines.map((line) => ({ text: line.text, words: line.words.map((w) => ({ text: w.text })) }));
    for (const w of res.words) Object.assign(out[w.line].words[w.word], { start: round(w.start), end: round(w.end) });
    return { lines: out, duration: samples.length / 16000, warnings: res.warnings };
}
const round = (x) => Math.round(x * 1000) / 1000;

process.on('message', (msg) => {
    if (!msg || msg.cmd !== 'align') return;
    run(msg)
        .then((result) => { send({ type: 'result', result }); setTimeout(() => process.exit(0), 50); })
        .catch((e) => { send({ type: 'error', message: e && e.message ? e.message : String(e) }); setTimeout(() => process.exit(1), 50); });
});
