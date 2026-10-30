/**
 * v2 render: lyrics synced to the track, with the track muxed into the file.
 */
const { createCanvas } = require('@napi-rs/canvas');
const fs = require('fs-extra');
const path = require('path');
const { spawnFfmpeg } = require('./ffmpeg');
const { buildSchedule, createSyncPainter } = require('./sync/draw');

const getUniqueOutputPath = (outputPath) => {
    if (!fs.existsSync(outputPath)) return outputPath;
    const dir = path.dirname(outputPath);
    const ext = path.extname(outputPath);
    const base = path.basename(outputPath, ext);
    let i = 1, candidate;
    do { candidate = path.join(dir, `${base}_${i}${ext}`); i++; } while (fs.existsSync(candidate));
    return candidate;
};

/**
 * @param {object} project { audioPath, start, end, lines, offset? }
 * @param {object} config  style config from the main window
 * @param {string} outputPath
 * @param {(fraction: number) => void} [onProgress]
 * @param {{ cancelled?: boolean }} [token] set token.cancelled = true to stop
 */
async function renderSyncedVideo(project, config, outputPath, onProgress, token = {}) {
    const width = Math.round(config.width), height = Math.round(config.height);
    const fps = config.fps || 30;
    const duration = Math.max(0.1, (project.end || 0) - (project.start || 0));

    // Safe-zone expansion, same as the classic renderer (not for previews)
    const padding = config.paddingRatio || 0;
    const marginX = padding > 0 && !config.isPreview ? Math.round(width * padding) : 0;
    const marginY = padding > 0 && !config.isPreview ? Math.round(height * padding) : 0;
    const fullWidth = width + marginX * 2, fullHeight = height + marginY * 2;

    const canvas = createCanvas(fullWidth, fullHeight);
    const ctx = canvas.getContext('2d');
    const painter = createSyncPainter({ createCanvas, canvas, fullWidth, fullHeight, marginX, marginY });
    const schedule = buildSchedule(project.lines, { duration, offset: project.offset || 0 });

    outputPath = getUniqueOutputPath(outputPath);
    const ffConfig = Object.assign({}, config, {
        width: fullWidth, height: fullHeight, fps,
        audio: project.audioPath ? { path: project.audioPath, start: project.start || 0, duration } : null,
    });
    const ff = spawnFfmpeg(ffConfig, outputPath);
    let ffExited = false;
    const closed = new Promise((resolve, reject) => {
        ff.on('close', (code) => { ffExited = true; code === 0 ? resolve(outputPath) : reject(new Error(`FFmpeg error ${code}`)); });
        ff.on('error', (e) => { ffExited = true; reject(e); });
    });
    ff.stdin.on('error', () => { /* reported through close */ });
    // wait for the pipe to drain, but never hang if ffmpeg is gone
    const drained = () => new Promise((resolve) => {
        const done = () => { ff.stdin.off('drain', done); ff.off('close', done); resolve(); };
        ff.stdin.once('drain', done);
        ff.once('close', done);
    });

    const totalFrames = Math.ceil(duration * fps);
    try {
        for (let f = 0; f < totalFrames; f++) {
            if (token.cancelled) throw new Error('Рендер отменён');
            if (ffExited) break;
            if (f % 10 === 0) await new Promise((r) => setImmediate(r));
            painter.drawFrame(ctx, schedule, f / fps, config);
            const buf = ctx.getImageData(0, 0, fullWidth, fullHeight).data;
            if (!ff.stdin.write(buf)) await drained();
            if (onProgress && f % 15 === 0) onProgress(f / totalFrames);
        }
        ff.stdin.end();
    } catch (e) {
        try { ff.kill(); } catch (_) { /* ignore */ }
        await closed.catch(() => { });
        try { fs.removeSync(outputPath); } catch (_) { /* ignore */ }
        throw e;
    }
    const out = await closed;
    if (onProgress) onProgress(1);
    return out;
}

module.exports = { renderSyncedVideo };
