'use strict';
/**
 * v2 must draw "our" pizza animation: fed the classic renderer's own timing
 * (one letter every 1/cps seconds), the v2 painter has to produce the very same
 * frames as src/renderer.js, pixel for pixel.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

let canvasMod = null;
try { canvasMod = require('@napi-rs/canvas'); } catch (e) { /* dependencies not installed */ }

const TEXT = 'Снова я не высыпаюсь мои глаза слипаются';

async function compare(cps, extra) {
    const { createCanvas } = canvasMod;
    const { renderSegmentToStream, loadFonts } = require('../src/renderer');
    const Draw = require('../src/sync/draw');
    loadFonts(path.join(__dirname, '..', 'assets', 'fonts', 'Inter-Medium.ttf'));
    const cfg = Object.assign({
        width: 360, height: 360, fps: 30, charsPerSecond: cps, textAlign: 'justify', exportFormat: 'mp4_green',
        backgroundColor: 'rgb(0,255,0)', textColor: '#ffffff', fontFamily: 'Arial Narrow', fontWeight: 500, lineHeight: 1,
        paddingRatio: 0.08, revealFrames: 3, revealOffsetPx: 18, endHold: 0.5, blur: 2, autoWrap: true, motionBlur: 0,
        jitter: 0, chroma: 0, dropShadow: 0, animationStyle: 'default', showCursor: false,
    }, extra);
    const v1 = [];
    const c1 = createCanvas(cfg.width, cfg.height);
    await renderSegmentToStream(c1.getContext('2d'), c1, TEXT, cfg, { write: (b) => { v1.push(Buffer.from(b)); return true; }, once() { } }, 0, 0);

    const nsTimes = [];
    for (let i = 0; i < TEXT.length; i++) if (!/\s/.test(TEXT[i])) nsTimes.push((i + 1) / cps - 1e-9);
    const schedule = { blocks: [{ text: TEXT, start: 0, end: 1e9, nsTimes }], duration: 1e9 };
    const c2 = createCanvas(cfg.width, cfg.height);
    const ctx2 = c2.getContext('2d');
    const painter = Draw.createSyncPainter({ createCanvas, canvas: c2, fullWidth: cfg.width, fullHeight: cfg.height });
    let differing = 0;
    for (let f = 0; f < v1.length; f++) {
        painter.drawFrame(ctx2, schedule, f / cfg.fps, cfg);
        const a = v1[f], b = ctx2.getImageData(0, 0, cfg.width, cfg.height).data;
        for (let k = 0; k < a.length; k++) if (Math.abs(a[k] - b[k]) > 8) { differing++; break; }
    }
    return { frames: v1.length, differing };
}

const cases = [[10, {}], [20, {}], [10, { motionBlur: 0.3 }], [17, { motionBlur: 0.6, textAlign: 'center' }]];
for (const [cps, extra] of cases) {
    test(`pizza in v2 = v1 at ${cps} letters/s ${JSON.stringify(extra)}`, { skip: !canvasMod && 'npm install first' }, async () => {
        const { frames, differing } = await compare(cps, extra);
        assert.ok(frames > 30);
        assert.strictEqual(differing, 0, `${differing} of ${frames} frames differ from the classic renderer`);
    });
}
