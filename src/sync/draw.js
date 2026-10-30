/**
 * v2 "track + lyrics" frame painter.
 *
 * Shared by the final render (Node + @napi-rs/canvas) and the live preview in
 * the sync window (browser canvas), so what you see while editing is what you
 * get in the file. Visual effects mirror the classic renderer: pizza/textFit
 * growth, typewriter, glitch, cursor, jitter, motion blur, blur, chroma, shadow.
 *
 * Timing: every word has a start time; its letters are typed while the word
 * is sung (capped so long notes do not crawl). One lyrics line = one screen.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('../layout'));
    else root.BratSyncDraw = factory(root.BratLayout);
})(typeof self !== 'undefined' ? self : this, function (layout) {
    'use strict';
    const { calculateLayout, getFlatCharacterPositions } = layout;

    const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);

    /**
     * @param {Array<{ text?: string, words: Array<{ text: string, start: number, end?: number }> }>} lines
     * @param {object} [o]
     * @param {number} [o.duration]   clip length (s)
     * @param {number} [o.clearGap=3] if the singer pauses longer than this, the screen is cleared
     * @param {number} [o.hold=1.2]   how long a line stays after its last word before such a pause
     * @param {number} [o.perChar=0.09] slowest typing: seconds per letter (v1 default is 0.1)
     * @param {number} [o.minGap=1/30] at most one new letter per this many seconds
     * @param {number} [o.offset=0]   global shift of all timings (s)
     *
     * Letters of a word are spread over the whole gap until the next word (but not slower
     * than perChar), not just over the sung part: typing the word only while the model
     * hears it made short words pop in within 2-3 frames (36% of letters < 67 ms apart,
     * bursts of 25 letters/s on 15 test clips; now 22% and 19/s, word starts unchanged).
     * Lines may carry `colors`: one CSS colour (or null) per non-space letter.
     */
    function buildSchedule(lines, o = {}) {
        const clearGap = o.clearGap != null ? o.clearGap : 3;
        const hold = o.hold != null ? o.hold : 1.2;
        const perChar = o.perChar != null ? o.perChar : 0.09;
        const minGap = o.minGap != null ? o.minGap : 1 / 30;
        const offset = o.offset || 0;

        // flatten + enforce order
        const blocks = [];
        let prevStart = -Infinity;
        for (const line of lines || []) {
            const words = (line.words || []).filter((w) => w && typeof w.start === 'number' && isFinite(w.start) && String(w.text || '').trim());
            if (!words.length) continue;
            const ws = words.map((w) => {
                let s = w.start + offset;
                if (s <= prevStart) s = prevStart + 0.01;
                prevStart = s;
                const e = typeof w.end === 'number' && isFinite(w.end) ? Math.max(s + 0.05, w.end + offset) : null;
                return { text: String(w.text).trim().replace(/\s+/g, ' '), start: s, end: e };
            });
            const nLetters = ws.reduce((n, w) => n + w.text.replace(/\s+/g, '').length, 0);
            const colors = Array.isArray(line.colors) && line.colors.length === nLetters && words.length === line.words.length ? line.colors : null;
            blocks.push({ words: ws, colors });
        }

        for (let b = 0; b < blocks.length; b++) {
            const blk = blocks[b];
            const ws = blk.words;
            const nextBlockStart = b + 1 < blocks.length ? blocks[b + 1].words[0].start : Infinity;
            const nsTimes = [];
            ws.forEach((w, i) => {
                const letters = w.text.replace(/\s+/g, '');
                const L = letters.length;
                const nextStart = i + 1 < ws.length ? ws[i + 1].start : nextBlockStart;
                const window = Math.max(0, Math.min(nextStart - w.start, L * perChar));
                for (let k = 0; k < L; k++) nsTimes.push(w.start + (L > 1 ? window * k / L : 0));
            });
            for (let k = 1; k < nsTimes.length; k++) nsTimes[k] = Math.max(nsTimes[k], nsTimes[k - 1] + minGap);
            const last = ws[ws.length - 1];
            const lastEnd = Math.max(nsTimes[nsTimes.length - 1], last.end != null ? last.end : last.start + 0.3);
            let end;
            if (b + 1 < blocks.length) {
                end = nextBlockStart - lastEnd > clearGap ? lastEnd + hold : nextBlockStart;
            } else {
                end = o.duration != null ? Math.max(o.duration, lastEnd) : lastEnd + hold + 1;
            }
            blk.text = ws.map((w) => w.text).join(' ');
            blk.start = ws[0].start;
            blk.end = Math.max(blk.start + 0.05, end);
            blk.nsTimes = nsTimes;
        }
        return { blocks, duration: o.duration != null ? o.duration : (blocks.length ? blocks[blocks.length - 1].end : 0) };
    }

    /** Index of the block shown at time t (or -1). */
    function blockAt(schedule, t) {
        const bl = schedule.blocks;
        for (let i = bl.length - 1; i >= 0; i--) {
            if (t >= bl[i].start) return t < bl[i].end ? i : -1;
        }
        return -1;
    }

    /** Text prefix that contains the first `n` non-space characters. */
    function prefixByLetters(text, n) {
        if (n <= 0) return '';
        let seen = 0;
        for (let i = 0; i < text.length; i++) {
            if (!/\s/.test(text[i])) { seen++; if (seen === n) return text.slice(0, i + 1); }
        }
        return text;
    }

    const isTransparent = (config) => config.exportFormat === 'mov_prores' || config.exportFormat === 'webm_preview';

    /**
     * Stateful painter (keeps jitter and motion-blur history between frames).
     * @param {object} env
     * @param {(w: number, h: number) => any} env.createCanvas
     * @param {number} env.fullWidth  canvas width including safe-zone margins
     * @param {number} env.fullHeight
     * @param {number} [env.marginX=0]
     * @param {number} [env.marginY=0]
     * @param {any} [env.canvas]     the canvas drawn into (needed for motion blur in Node)
     * @param {() => number} [env.random=Math.random]
     */
    function createSyncPainter(env) {
        const marginX = env.marginX || 0, marginY = env.marginY || 0;
        const random = env.random || Math.random;
        const history = env.createCanvas(env.fullWidth, env.fullHeight);
        const historyCtx = history.getContext('2d');
        let hasHistory = false;
        let shakeTrauma = 0;
        let lastKey = null;
        let cache = null; // { key, layout, chars }
        let glide = null; // displayed letter positions/size while the text re-fits

        function reset() {
            hasHistory = false; shakeTrauma = 0; lastKey = null; cache = null; glide = null;
            historyCtx.clearRect(0, 0, env.fullWidth, env.fullHeight);
        }

        /**
         * Draws the frame for time t. The context must be untransformed;
         * the painter applies the safe-zone margins itself.
         */
        function drawFrame(ctx, schedule, t, config) {
            const { width, height } = config;
            const fps = config.fps || 30;
            const fontWeight = config.fontWeight || 500;
            const lineHeight = config.lineHeight || 1;
            const fontBase = config.fontBase || config.fontFamily || 'Arial';
            const textAlign = config.textAlign || 'justify';
            const style = config.animationStyle || 'default';
            const revealSec = (config.revealFrames || 3) / fps;
            const revealOffsetPx = config.revealOffsetPx != null ? config.revealOffsetPx : 18;

            const bi = blockAt(schedule, t);
            const block = bi >= 0 ? schedule.blocks[bi] : null;
            const glitchLead = style === 'glitch' ? revealSec : 0;
            let visible = 0;
            if (block) { while (visible < block.nsTimes.length && block.nsTimes[visible] <= t + glitchLead) visible++; }
            const settled = block ? block.nsTimes.filter((x) => x <= t).length : 0;

            // jitter: a kick on every new letter, decaying
            shakeTrauma *= 0.9;
            const key = bi + ':' + settled;
            if (key !== lastKey && settled > 0 && config.jitter > 0) shakeTrauma = config.jitter;
            lastKey = key;
            let shakeX = 0, shakeY = 0;
            if (shakeTrauma > 0.5) { shakeX = (random() - 0.5) * shakeTrauma * 2; shakeY = (random() - 0.5) * shakeTrauma * 2; }

            // layout (re-computed only when the visible text changes)
            let chars = [];
            let layoutRes = null;
            if (block && visible > 0) {
                const layoutText = style === 'default' ? prefixByLetters(block.text, visible) : block.text;
                const ckey = bi + '|' + layoutText + '|' + width + 'x' + height + '|' + fontBase + '|' + textAlign + '|' + config.autoWrap + '|' + config.paddingRatio;
                if (!cache || cache.key !== ckey) {
                    const cfg = Object.assign({}, config, { fontBase, fontWeight, lineHeight, textAlign });
                    const L = calculateLayout(ctx, layoutText, cfg, []);
                    const originX = (width - L.blockWidth) / 2;
                    const originY = (height - L.blockHeight) / 2;
                    const flat = getFlatCharacterPositions(ctx, L.lines, originX, originY, L.fontSize, lineHeight, fontBase, fontWeight, L.blockWidth, textAlign, []);
                    const lineYs = [...new Set(flat.map((c) => c.y))].sort((a, b) => a - b);
                    let j = 0;
                    for (const c of flat) {
                        c.line = lineYs.indexOf(c.y);
                        if (/\s/.test(c.char)) { c.time = null; continue; }
                        c.time = block.nsTimes[j] != null ? block.nsTimes[j] : 0;
                        if (block.colors && block.colors[j]) c.color = block.colors[j];
                        j++;
                    }
                    cache = { key: ckey, layout: L, chars: flat };
                }
                layoutRes = cache.layout; chars = cache.chars;
            }

            // Smooth re-fit. In the pizza style the block re-fits (shrinks) on every new letter;
            // with sung timing that can be 15-20 times a second, and instant jumps read as
            // shaking. Letters glide to their new place and size instead (time constant
            // refitSec, 60 ms by default: ~80% there after 3 frames, the snap stays). When a
            // word moves to another line the text snaps as in v1: gliding across lines overlaps.
            let fontSize = layoutRes ? layoutRes.fontSize : 10;
            const refitSec = config.refitSec != null ? config.refitSec : 0.06;
            if (style === 'default' && block && chars.length && refitSec > 0) {
                const letters = chars.filter((c) => c.time !== null);
                const rewrapped = glide && letters.some((c, j) => j < glide.line.length && glide.line[j] !== c.line);
                if (!glide || glide.bi !== bi || t < glide.t || t - glide.t > 0.25 || rewrapped) {
                    glide = { bi, t, fs: fontSize, x: letters.map((c) => c.x), y: letters.map((c) => c.y), line: letters.map((c) => c.line) };
                } else {
                    const a = 1 - Math.exp(-(t - glide.t) / refitSec);
                    const scale = glide.fs / fontSize;
                    for (let j = 0; j < letters.length; j++) {
                        const c = letters[j];
                        if (j < glide.x.length) {
                            glide.x[j] += (c.x - glide.x[j]) * a;
                            glide.y[j] += (c.y - glide.y[j]) * a;
                        } else if (j > 0) { // a new letter keeps its offset from the previous one, at the shown size
                            const p = letters[j - 1];
                            glide.x[j] = glide.x[j - 1] + (c.x - p.x) * scale;
                            glide.y[j] = glide.y[j - 1] + (c.y - p.y) * scale;
                        } else { glide.x[j] = c.x; glide.y[j] = c.y; }
                    }
                    glide.x.length = letters.length; glide.y.length = letters.length;
                    glide.line = letters.map((c) => c.line);
                    glide.fs += (fontSize - glide.fs) * a;
                    glide.t = t;
                }
                fontSize = glide.fs;
                chars = letters.map((c, j) => Object.assign({}, c, { x: glide.x[j], y: glide.y[j] }));
            }

            // background
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            if (isTransparent(config)) ctx.clearRect(0, 0, env.fullWidth, env.fullHeight);
            else { ctx.fillStyle = config.backgroundColor || 'rgb(0,255,0)'; ctx.fillRect(0, 0, env.fullWidth, env.fullHeight); }
            if (config.motionBlur > 0 && hasHistory) {
                ctx.globalAlpha = config.motionBlur;
                ctx.drawImage(history, 0, 0);
                ctx.globalAlpha = 1;
            }
            ctx.restore();

            const motionSamples = config.motionBlur > 0 ? Math.max(2, Math.floor(config.motionBlur * 40)) : 1;
            const frameSec = 1 / fps;

            ctx.save();
            ctx.setTransform(1, 0, 0, 1, marginX + shakeX, marginY + shakeY);
            ctx.textBaseline = 'top';
            ctx.font = `${fontWeight} ${fontSize}px "${fontBase}"`;
            ctx.filter = config.blur > 0 ? `blur(${config.blur}px)` : 'none';

            const glyph = (c, tt) => {
                // returns { opacity, xOffset, ch } for char c at time tt
                if (c.time === null) return null;
                const age = tt - c.time;
                if (style === 'default') {
                    if (age < 0) return null; // not typed yet
                    if (age < revealSec) { const e = easeOutCubic(age / revealSec); return { opacity: e, xOffset: revealOffsetPx * (1 - e), ch: c.char }; }
                    return { opacity: 1, xOffset: 0, ch: c.char };
                }
                if (style === 'typewriter') return age >= 0 ? { opacity: 1, xOffset: 0, ch: c.char } : null;
                if (style === 'glitch') {
                    const p = age / revealSec;
                    if (p <= -1) return null;
                    if (p <= 1.5) {
                        let set = '!@#$%^&*<>/?010101XY';
                        if (config.glitchCharset === 'letters') set = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
                        else if (config.glitchCharset === 'numbers') set = '0123456789';
                        else if (config.glitchCharset === 'mixed') set = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*<>/?';
                        const f = Math.floor(tt * fps);
                        const phase = Math.floor(f * (config.glitchSpeed || 0.5) + (c.index || 0) * 13.37);
                        const r1 = Math.sin(phase) * 10000, r2 = Math.cos(phase) * 10000;
                        return { opacity: 1, xOffset: ((r2 - Math.floor(r2)) - 0.5) * 6, ch: set[Math.floor((r1 - Math.floor(r1)) * set.length)] };
                    }
                    return { opacity: 1, xOffset: 0, ch: c.char };
                }
                return age >= 0 ? { opacity: 1, xOffset: 0, ch: c.char } : null;
            };

            const drawLayer = (color, dx, dy, main) => {
                const one = (c, tt, mult) => {
                    const g = glyph(c, tt);
                    if (!g || g.opacity <= 0.01 || !g.ch || !g.ch.trim()) return;
                    ctx.globalAlpha = g.opacity * mult;
                    if (main) {
                        const col = c.color || color;
                        ctx.fillStyle = col;
                        if (config.dropShadow > 0) {
                            ctx.shadowColor = col === '#ffffff' ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.8)';
                            ctx.shadowBlur = config.dropShadow; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
                        } else { ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; }
                    } else { ctx.fillStyle = color; ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; }
                    ctx.fillText(g.ch, c.x + g.xOffset + dx, c.y + dy);
                };
                for (const c of chars) {
                    if (c.time === null) continue;
                    const moving = main && motionSamples > 1 && t - c.time < revealSec + frameSec && t - c.time > -revealSec;
                    if (moving) { for (let s = 0; s < motionSamples; s++) one(c, t - (s / motionSamples) * frameSec, 1 / motionSamples); }
                    else one(c, t, 1);
                }
                // blinking cursor after the last visible letter
                if (main && config.showCursor && block) {
                    const blinkOn = Math.floor(t * 2 * (config.cursorSpeed || 1)) % 2 === 0;
                    if (blinkOn) {
                        let cx, cy;
                        const shown = chars.filter((c) => c.time !== null && c.time <= t);
                        if (shown.length) { const lc = shown[shown.length - 1]; cx = lc.x + ctx.measureText(lc.char).width; cy = lc.y; }
                        else if (layoutRes) { cx = (width - layoutRes.blockWidth) / 2; cy = (height - layoutRes.blockHeight) / 2; }
                        if (cx !== undefined) {
                            ctx.globalAlpha = 1; ctx.fillStyle = color; ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
                            ctx.fillText(config.cursorStyle || '|', cx + dx, cy + dy);
                        }
                    }
                }
                ctx.globalAlpha = 1;
            };

            if (config.chroma > 0) {
                ctx.globalCompositeOperation = config.exportFormat && config.exportFormat.includes('mp4_green') ? 'source-over' : 'screen';
                drawLayer('rgba(255, 0, 0, 0.5)', -config.chroma, 0, false);
                drawLayer('rgba(0, 0, 255, 0.5)', config.chroma, 0, false);
                ctx.globalCompositeOperation = 'source-over';
            }
            drawLayer(config.textColor || '#ffffff', 0, 0, true);
            ctx.restore();
            ctx.filter = 'none'; ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';

            if (config.motionBlur > 0) {
                historyCtx.clearRect(0, 0, env.fullWidth, env.fullHeight);
                historyCtx.drawImage(env.canvas || ctx.canvas, 0, 0);
                hasHistory = true;
            }
        }

        return { drawFrame, reset };
    }

    return { buildSchedule, blockAt, createSyncPainter, prefixByLetters };
});
