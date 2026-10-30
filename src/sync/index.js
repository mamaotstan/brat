'use strict';
/**
 * Main-process API for auto-sync. Runs the aligner in a separate low-priority
 * process with at most half of the CPU cores (max 4), so weak machines stay
 * responsive.
 */
const { fork } = require('child_process');
const os = require('os');
const path = require('path');
const { ffmpegPath } = require('./audio');

const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

function defaultModelDir() {
    return unpacked(path.join(__dirname, '..', '..', 'assets', 'models', 'ru-small'));
}

function defaultThreads() {
    const cores = (os.cpus() || []).length || 2;
    return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}

/**
 * @param {object} job { audioPath, start, duration, lyrics, threads?, modelDir? }
 * @param {(value: number, stage: string) => void} [onProgress]
 * @returns {{ promise: Promise<object>, cancel: () => void }}
 */
function runAutoSync(job, onProgress) {
    // src/sync is unpacked from app.asar (see build.asarUnpack): the child runs plain files
    // and loads onnxruntime-node and the model from app.asar.unpacked.
    const child = fork(unpacked(path.join(__dirname, 'worker.js')), [], {
        env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        windowsHide: true,
    });
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* not critical */ }

    let settled = false;
    const promise = new Promise((resolve, reject) => {
        child.on('message', (m) => {
            if (m.type === 'progress' && onProgress) onProgress(m.value, m.stage);
            else if (m.type === 'result') { settled = true; resolve(m.result); }
            else if (m.type === 'error') { settled = true; reject(new Error(m.message)); }
        });
        child.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
        child.on('exit', (code) => {
            if (!settled) { settled = true; reject(new Error(code === null ? 'Отменено' : `Процесс распознавания завершился с кодом ${code}`)); }
        });
    });
    child.send({
        cmd: 'align',
        audioPath: job.audioPath,
        start: job.start || 0,
        duration: job.duration || 0,
        lyrics: job.lyrics,
        modelDir: job.modelDir || defaultModelDir(),
        threads: job.threads || defaultThreads(),
        ffmpeg: ffmpegPath(),
    });
    return { promise, cancel: () => { try { child.kill(); } catch (e) { /* already gone */ } } };
}

module.exports = { runAutoSync, defaultThreads, defaultModelDir };
