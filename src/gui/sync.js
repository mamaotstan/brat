// --- v2: track + lyrics editor ---------------------------------------------
// Word times are stored in track time (seconds from the start of the file), so
// moving the clip borders never breaks timings. The render gets clip-relative times.

const api = window.electronAPI;
const Draw = window.BratSyncDraw;
const Text = window.BratText;
const $ = (id) => document.getElementById(id);

const DEFAULT_CONFIG = {
    width: 900, height: 900, fps: 30, textAlign: 'justify', exportFormat: 'mp4_green', backgroundColor: 'rgb(0,255,0)',
    textColor: '#ffffff', fontFamily: 'Arial Narrow', fontWeight: 500, lineHeight: 1, paddingRatio: 0.08, revealFrames: 3,
    revealOffsetPx: 18, blur: 2, autoWrap: true, motionBlur: 0, jitter: 0, chroma: 0, dropShadow: 0, animationStyle: 'default',
    showCursor: false, cursorStyle: '|', cursorSpeed: 1, glitchSpeed: 0.5, glitchCharset: 'symbols',
};

const state = {
    audioPath: null, audioSource: null, audioUrl: null, audioName: '', trackDuration: 0,
    start: 0, end: 0,
    lyrics: '',
    lines: null, // [{ text, words: [{ text, start, end }] }] in track time; start may be null
    offsetMs: 0,
};
let config = Object.assign({}, DEFAULT_CONFIG);
let peaks = null;
let pps = 120;
let selected = -1;
let tapMode = false, tapCursor = 0;
let playing = false;
let cursorAbs = 0;
let busy = false;

// ---------------------------------------------------------------- helpers
const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60), r = s - m * 60;
    return `${m}:${r.toFixed(2).padStart(5, '0')}`;
};
const clipDur = () => Math.max(0, state.end - state.start);
const flat = () => {
    const out = [];
    (state.lines || []).forEach((l, li) => l.words.forEach((w, wi) => out.push({ li, wi, w })));
    return out;
};
const keyOf = (s) => String(s).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '');

let saveTimer = null;
function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => api.syncSaveProject(state), 600);
}

// ---------------------------------------------------------------- lyrics <-> words
/** Re-parses lyrics, carrying timings over to words that did not change (LCS match). */
function reconcileLyrics(text) {
    const parsed = Text.parseLyrics(text);
    const lines = parsed.map((l) => ({ text: l.text, words: l.words.map((w) => ({ text: w.text, start: null, end: null })) }));
    const old = flat().map((x) => x.w);
    const nw = []; lines.forEach((l) => l.words.forEach((w) => nw.push(w)));
    if (old.length && nw.length) {
        const n = old.length, m = nw.length;
        const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
        for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = keyOf(old[i].text) === keyOf(nw[j].text) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
        for (let i = 0, j = 0; i < n && j < m;) {
            if (keyOf(old[i].text) === keyOf(nw[j].text)) { nw[j].start = old[i].start; nw[j].end = old[i].end; i++; j++; }
            else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
        }
    }
    state.lines = lines.length ? lines : null;
}

/** Copy of the lines with every word timed (untimed words are spread between neighbours). */
function timedLines() {
    if (!state.lines) return [];
    const lines = state.lines.map((l) => ({ text: l.text, words: l.words.map((w) => Object.assign({}, w)) }));
    const all = []; lines.forEach((l) => l.words.forEach((w) => all.push(w)));
    if (!all.some((w) => w.start != null)) return [];
    for (let i = 0; i < all.length;) {
        if (all[i].start != null) { i++; continue; }
        let j = i; while (j < all.length && all[j].start == null) j++;
        const a = i > 0 ? all[i - 1].start : null, b = j < all.length ? all[j].start : null;
        const n = j - i;
        for (let k = 0; k < n; k++) {
            if (a != null && b != null) all[i + k].start = a + (b - a) * (k + 1) / (n + 1);
            else if (a != null) all[i + k].start = a + 0.3 * (k + 1);
            else all[i + k].start = b - 0.3 * (n - k);
            all[i + k].end = null;
        }
        i = j;
    }
    return lines;
}

/** Clip-relative lines for the painter and the render. */
function relLines() {
    return timedLines().map((l) => ({
        text: l.text,
        words: l.words.map((w) => ({ text: w.text, start: w.start - state.start, end: w.end != null ? w.end - state.start : null })),
    }));
}

// ---------------------------------------------------------------- preview
const cv = $('previewCanvas');
const ctx = cv.getContext('2d');
let painter = null, painterKey = '';
let schedule = null, scheduleDirty = true;
let fontReady = Promise.resolve();

function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

function previewConfig() {
    const c = Object.assign({}, config);
    c.width = parseInt(c.width, 10) || 900; c.height = parseInt(c.height, 10) || 900;
    c.fps = parseInt(c.fps, 10) || 30;
    c.isPreview = true;
    return c;
}

function ensurePainter(c) {
    const key = c.width + 'x' + c.height;
    if (painter && key === painterKey) return;
    cv.width = c.width; cv.height = c.height;
    painter = Draw.createSyncPainter({ createCanvas: makeCanvas, canvas: cv, fullWidth: c.width, fullHeight: c.height });
    painterKey = key;
}

function drawPreview(continuous) {
    const c = previewConfig();
    ensurePainter(c);
    if (scheduleDirty) {
        schedule = Draw.buildSchedule(relLines(), { duration: clipDur(), offset: state.offsetMs / 1000 });
        scheduleDirty = false;
    }
    if (!continuous) painter.reset();
    painter.drawFrame(ctx, schedule, cursorAbs - state.start, c);
    const transparent = c.exportFormat === 'mov_prores';
    $('previewArea').classList.toggle('light', transparent && /^#(000000|000)$/i.test(c.textColor || ''));
    $('emptyHint').style.display = schedule.blocks.length ? 'none' : '';
}

function invalidate() { scheduleDirty = true; if (!playing) drawPreview(false); renderChips(); save(); }

function applyConfig(c) {
    if (c) config = Object.assign({}, DEFAULT_CONFIG, c);
    const fam = config.fontFamily || 'Arial';
    fontReady = document.fonts.load(`${config.fontWeight || 500} 48px "${fam}"`).catch(() => { });
    fontReady.then(() => { painter = null; scheduleDirty = true; if (!playing) drawPreview(false); });
    const fmtName = { mov_prores: 'MOV (прозрачный)', mp4_green: 'MP4 зелёный', mp4_black: 'MP4 чёрный', mp4_white: 'MP4 белый' }[config.exportFormat] || config.exportFormat;
    $('styleSummary').textContent = `Стиль из главного окна: ${fam}, ${config.width}×${config.height}, ${config.fps} fps, ${fmtName}. Поменяй там — превью обновится.`;
}

// ---------------------------------------------------------------- timeline
const scroll = $('tlScroll'), content = $('tlContent');
const wave = $('waveCanvas'), ruler = $('rulerCanvas');
const lanes = [$('lane0'), $('lane1')];
let chipEls = [];

function layoutTimeline() {
    const total = Math.max(state.trackDuration, state.end, 1);
    content.style.width = Math.ceil(total * pps + 200) + 'px';
    const L = state.start * pps, R = state.end * pps;
    const hasTrack = !!state.audioPath;
    for (const id of ['shadeL', 'shadeR', 'edgeL', 'edgeR']) $(id).style.display = hasTrack ? '' : 'none';
    $('shadeL').style.left = '0px'; $('shadeL').style.width = L + 'px';
    $('shadeR').style.left = R + 'px'; $('shadeR').style.width = Math.max(0, total * pps + 200 - R) + 'px';
    $('edgeL').style.left = (L - 1) + 'px'; $('edgeR').style.left = (R - 1) + 'px';
    drawWave();
    renderChips();
    movePlayhead();
}

function drawWave() {
    const w = scroll.clientWidth, h = Math.max(10, scroll.clientHeight - 18);
    const left = scroll.scrollLeft;
    for (const c of [wave, ruler]) { c.style.left = left + 'px'; c.width = w; c.style.width = w + 'px'; }
    wave.height = h; wave.style.height = h + 'px';
    ruler.height = 18; ruler.style.height = '18px';
    const wc = wave.getContext('2d');
    wc.clearRect(0, 0, w, h);
    if (peaks) {
        wc.fillStyle = 'rgba(142, 206, 0, 0.35)';
        const mid = h / 2;
        for (let x = 0; x < w; x++) {
            const t0 = (left + x) / pps, t1 = (left + x + 1) / pps;
            const i0 = Math.floor(t0 / peaks.bucketSec), i1 = Math.max(i0 + 1, Math.floor(t1 / peaks.bucketSec));
            let m = 0;
            for (let i = i0; i < i1 && i < peaks.peaks.length; i++) if (peaks.peaks[i] > m) m = peaks.peaks[i];
            const a = Math.min(1, m) * (h / 2 - 2);
            wc.fillRect(x, mid - a, 1, Math.max(1, a * 2));
        }
    }
    const rc = ruler.getContext('2d');
    rc.clearRect(0, 0, w, 18);
    rc.fillStyle = '#71717a'; rc.font = '10px sans-serif';
    const step = pps >= 200 ? 0.5 : pps >= 60 ? 1 : pps >= 25 ? 5 : 10;
    const labelEvery = pps >= 200 ? 1 : pps >= 60 ? 5 : pps >= 25 ? 10 : 30;
    for (let t = Math.floor(left / pps / step) * step; t * pps < left + w; t += step) {
        const x = t * pps - left;
        const isLabel = Math.abs(t / labelEvery - Math.round(t / labelEvery)) < 1e-6;
        rc.fillRect(x, isLabel ? 8 : 13, 1, isLabel ? 10 : 5);
        if (isLabel) rc.fillText(fmt(t).replace(/\.00$/, ''), x + 3, 9);
    }
}

function renderChips() {
    const words = flat();
    // reuse DOM nodes
    while (chipEls.length > words.length) chipEls.pop().remove();
    const times = words.map((x) => x.w.start);
    words.forEach((x, i) => {
        let el = chipEls[i];
        if (!el) { el = document.createElement('div'); el.className = 'chip'; el.dataset.idx = i; chipEls.push(el); }
        const lane = lanes[x.li % 2];
        if (el.parentNode !== lane) lane.appendChild(el);
        const untimed = x.w.start == null;
        let s = x.w.start;
        if (untimed) { // place it between neighbours for display
            const prev = times.slice(0, i).reverse().find((t) => t != null);
            s = (prev != null ? prev + 0.2 : state.start);
        }
        let next = null;
        for (let k = i + 1; k < words.length; k++) if (times[k] != null) { next = times[k]; break; }
        const width = Math.max(14, Math.min(((next != null ? next : s + 0.6) - s) * pps, 600));
        el.style.left = (s + state.offsetMs / 1000) * pps + 'px';
        el.style.width = width + 'px';
        el.textContent = x.w.text;
        el.title = `${x.w.text} — ${untimed ? 'нет тайминга' : fmt(s - state.start)}`;
        el.className = 'chip' + (x.li % 2 ? ' alt' : '') + (untimed ? ' untimed' : '') + (i === selected ? ' sel' : '') + (tapMode && i === tapCursor ? ' next-tap' : '');
    });
    const timed = words.filter((x) => x.w.start != null).length;
    $('tlInfo').textContent = words.length ? `${timed}/${words.length} слов с таймингом · ${state.lines.length} экран(ов)` : '';
    $('tapNext').textContent = words[tapCursor] ? words[tapCursor].w.text : '—';
}

function highlightActive() {
    const t = cursorAbs - state.offsetMs / 1000;
    const words = flat();
    let act = -1;
    for (let i = 0; i < words.length; i++) if (words[i].w.start != null && words[i].w.start <= t) act = i;
    chipEls.forEach((el, i) => el.classList.toggle('active', i === act));
}

function movePlayhead() {
    $('playhead').style.left = cursorAbs * pps + 'px';
    $('timeLabel').textContent = `${fmt(cursorAbs - state.start)} / ${fmt(clipDur())}`;
    highlightActive();
}

function ensureVisible(x) {
    const l = scroll.scrollLeft, w = scroll.clientWidth;
    if (x < l + 40 || x > l + w - 80) scroll.scrollLeft = Math.max(0, x - w * 0.3);
}

scroll.addEventListener('scroll', drawWave);
window.addEventListener('resize', () => { drawWave(); });
$('zoom').addEventListener('input', (e) => {
    const center = (scroll.scrollLeft + scroll.clientWidth / 2) / pps;
    pps = parseInt(e.target.value, 10);
    layoutTimeline();
    scroll.scrollLeft = Math.max(0, center * pps - scroll.clientWidth / 2);
});
scroll.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const z = $('zoom');
    z.value = Math.max(+z.min, Math.min(+z.max, pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    z.dispatchEvent(new Event('input'));
}, { passive: false });

// mouse on the timeline: drag a word / select the clip / seek
let drag = null;
content.addEventListener('mousedown', (e) => {
    const rect = content.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const chip = e.target.closest('.chip');
    if (chip) {
        const i = +chip.dataset.idx;
        selected = i;
        if (tapMode) tapCursor = i;
        const words = flat();
        const w = words[i].w;
        if (w.start == null) { w.start = x / pps - state.offsetMs / 1000; w.end = null; }
        const lineIdx = words[i].li;
        drag = {
            kind: e.shiftKey ? 'line' : 'word', idx: i, x0: x,
            orig: words.map((y) => y.w.start), line: lineIdx,
        };
        renderChips();
        e.preventDefault();
        return;
    }
    drag = { kind: 'pending', x0: x };
});
window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const rect = content.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const dt = (x - drag.x0) / pps;
    const words = flat();
    if (drag.kind === 'word') {
        const i = drag.idx;
        const prev = words.slice(0, i).reverse().find((y) => y.w.start != null);
        const next = words.slice(i + 1).find((y) => y.w.start != null);
        let s = drag.orig[i] + dt;
        if (prev) s = Math.max(s, prev.w.start + 0.02);
        if (next) s = Math.min(s, next.w.start - 0.02);
        words[i].w.start = Math.max(0, s); words[i].w.end = null;
        scheduleDirty = true; renderChips();
    } else if (drag.kind === 'line') {
        words.forEach((y, k) => { if (y.li === drag.line && drag.orig[k] != null) { y.w.start = Math.max(0, drag.orig[k] + dt); y.w.end = null; } });
        scheduleDirty = true; renderChips();
    } else if (drag.kind === 'pending' && Math.abs(x - drag.x0) > 4) {
        drag.kind = 'region';
    }
    if (drag.kind === 'region') {
        const a = Math.max(0, Math.min(drag.x0, x) / pps), b = Math.min(state.trackDuration || Infinity, Math.max(drag.x0, x) / pps);
        state.start = +a.toFixed(2); state.end = +b.toFixed(2);
        syncClipInputs(); layoutTimeline();
    }
});
window.addEventListener('mouseup', (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.kind === 'pending') {
        seek(d.x0 / pps);
    } else if (d.kind === 'region') {
        if (cursorAbs < state.start || cursorAbs > state.end) cursorAbs = state.start;
        invalidate(); movePlayhead();
    } else {
        invalidate();
    }
});

// ---------------------------------------------------------------- playback
const audio = $('audio');
let rafId = 0;

function seek(tAbs) {
    cursorAbs = Math.max(0, Math.min(tAbs, state.trackDuration || tAbs));
    if (playing) { audio.currentTime = cursorAbs; painter && painter.reset(); }
    else drawPreview(false);
    movePlayhead();
}

function play() {
    if (!state.audioUrl) return;
    if (cursorAbs < state.start || cursorAbs >= state.end - 0.05) cursorAbs = state.start;
    audio.currentTime = cursorAbs;
    audio.playbackRate = parseFloat($('rateSel').value) || 1;
    audio.play().then(() => {
        playing = true; $('playBtn').textContent = '⏸';
        if (painter) painter.reset();
        const loop = () => {
            if (!playing) return;
            cursorAbs = audio.currentTime;
            if (cursorAbs >= state.end) { pause(); cursorAbs = state.end; movePlayhead(); return; }
            drawPreview(true);
            movePlayhead();
            ensureVisible(cursorAbs * pps);
            rafId = requestAnimationFrame(loop);
        };
        loop();
    }).catch((e) => setStatus('alignStatus', 'Не удалось воспроизвести: ' + e.message, 'err'));
}

function pause() {
    playing = false; audio.pause(); cancelAnimationFrame(rafId);
    $('playBtn').textContent = '▶';
    drawPreview(false);
}

$('playBtn').addEventListener('click', () => (playing ? pause() : play()));
$('toStartBtn').addEventListener('click', () => { pause(); seek(state.start); });
$('rateSel').addEventListener('change', () => { audio.playbackRate = parseFloat($('rateSel').value) || 1; });

// ---------------------------------------------------------------- tap mode
function setTapMode(on) {
    tapMode = on;
    $('tapBtn').classList.toggle('on', on);
    $('tapBanner').style.display = on ? 'block' : 'none';
    if (on) {
        if (!state.lines) reconcileLyrics($('lyrics').value);
        tapCursor = selected >= 0 ? selected : 0;
        const w = flat()[tapCursor];
        if (w && w.w.start != null && !playing) seek(Math.max(state.start, w.w.start - 1.5));
    }
    renderChips();
}
$('tapBtn').addEventListener('click', () => setTapMode(!tapMode));

function tap() {
    const words = flat();
    if (!words.length) return;
    if (!playing) { play(); return; }
    const t = audio.currentTime - 0.03 - state.offsetMs / 1000; // typical key latency
    const cur = words[tapCursor];
    if (!cur) return;
    const prev = words.slice(0, tapCursor).reverse().find((y) => y.w.start != null);
    cur.w.start = prev ? Math.max(t, prev.w.start + 0.02) : t;
    cur.w.end = null;
    // keep later words in order
    for (let k = tapCursor + 1; k < words.length; k++) {
        const w = words[k].w;
        if (w.start != null && w.start < words[k - 1].w.start + 0.02) { w.start = words[k - 1].w.start + 0.02; w.end = null; }
    }
    selected = tapCursor;
    tapCursor++;
    scheduleDirty = true;
    renderChips();
    save();
    if (tapCursor >= words.length) { setTapMode(false); setStatus('alignStatus', 'Готово: все слова протыканы.'); }
}

// ---------------------------------------------------------------- keyboard
document.addEventListener('keydown', (e) => {
    const typing = ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement && document.activeElement.tagName);
    if (typing) return;
    if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); return; }
    if (tapMode && (e.code === 'KeyF' || e.code === 'KeyJ' || e.code === 'Enter')) { e.preventDefault(); if (!e.repeat) tap(); return; }
    if (e.code === 'Escape' && tapMode) { setTapMode(false); return; }
    if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && selected >= 0) {
        e.preventDefault();
        const words = flat();
        const w = words[selected] && words[selected].w;
        if (!w || w.start == null) return;
        const d = (e.code === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.1 : 0.01);
        const prev = words.slice(0, selected).reverse().find((y) => y.w.start != null);
        const next = words.slice(selected + 1).find((y) => y.w.start != null);
        let s = w.start + d;
        if (prev) s = Math.max(s, prev.w.start + 0.02);
        if (next) s = Math.min(s, next.w.start - 0.02);
        w.start = s; w.end = null;
        invalidate();
        if (!playing) seek(w.start + state.offsetMs / 1000);
    }
});

// ---------------------------------------------------------------- sidebar controls
function setStatus(id, text, kind) {
    const el = $(id);
    el.className = 'status' + (kind ? ' ' + kind : '');
    el.textContent = text;
}
function setProgress(id, v) {
    const el = $(id);
    el.style.display = v == null ? 'none' : 'block';
    el.firstElementChild.style.width = Math.round((v || 0) * 100) + '%';
}

function syncClipInputs() {
    $('clipStart').value = state.start.toFixed(2);
    $('clipEnd').value = state.end.toFixed(2);
}

async function loadAudio(info, keepClip) {
    state.audioPath = info.path; state.audioSource = info.original || info.path;
    state.audioUrl = info.url; state.audioName = info.name; state.trackDuration = info.duration;
    if (!keepClip || !(state.end > state.start)) { state.start = 0; state.end = +info.duration.toFixed(2); }
    $('audioName').textContent = `${info.name} · ${fmt(info.duration)}`;
    audio.src = info.url;
    syncClipInputs();
    peaks = null; layoutTimeline();
    const fit = Math.max(20, Math.min(600, (scroll.clientWidth - 40) / Math.max(1, clipDur())));
    pps = Math.round(fit); $('zoom').value = pps;
    cursorAbs = state.start;
    layoutTimeline();
    scroll.scrollLeft = Math.max(0, state.start * pps - 20);
    try { peaks = await api.syncWaveform(info.path); } catch (e) { peaks = null; }
    drawWave();
    invalidate();
}

$('pickAudioBtn').addEventListener('click', async () => {
    const info = await api.syncPickAudio();
    if (!info) return;
    if (info.error) { setStatus('alignStatus', info.error, 'err'); return; }
    pause();
    await loadAudio(info, false);
});

const clipInput = () => {
    let a = parseFloat($('clipStart').value) || 0, b = parseFloat($('clipEnd').value) || 0;
    a = Math.max(0, a); b = Math.max(a + 0.5, b);
    if (state.trackDuration) b = Math.min(b, state.trackDuration);
    state.start = a; state.end = b;
    layoutTimeline(); invalidate();
};
$('clipStart').addEventListener('change', clipInput);
$('clipEnd').addEventListener('change', clipInput);
$('wholeTrackBtn').addEventListener('click', () => { state.start = 0; state.end = state.trackDuration || state.end; syncClipInputs(); layoutTimeline(); invalidate(); });

let lyricsTimer = null;
$('lyrics').addEventListener('input', () => {
    clearTimeout(lyricsTimer);
    lyricsTimer = setTimeout(() => {
        const hadTimings = flat().some((x) => x.w.start != null);
        state.lyrics = $('lyrics').value;
        reconcileLyrics(state.lyrics);
        if (hadTimings && flat().some((x) => x.w.start == null)) {
            setStatus('alignStatus', 'Текст изменился: новые слова отмечены красным. Нажми «Расставить автоматически» или протыкай их.', 'warn');
        }
        invalidate();
    }, 300);
});

document.querySelectorAll('[data-shift]').forEach((b) => b.addEventListener('click', () => {
    $('offsetMs').value = (parseInt($('offsetMs').value, 10) || 0) + parseInt(b.dataset.shift, 10);
    $('offsetMs').dispatchEvent(new Event('change'));
}));
$('offsetMs').addEventListener('change', () => { state.offsetMs = parseInt($('offsetMs').value, 10) || 0; invalidate(); });

function setBusy(on) {
    busy = on;
    $('autoBtn').disabled = on; $('renderBtn').disabled = on; $('pickAudioBtn').disabled = on;
    $('cancelBtn').style.display = on ? '' : 'none';
}

$('autoBtn').addEventListener('click', async () => {
    if (busy) return;
    state.lyrics = $('lyrics').value;
    if (!state.audioPath) return setStatus('alignStatus', 'Сначала выбери трек.', 'err');
    if (!Text.parseLyrics(state.lyrics).length) return setStatus('alignStatus', 'Вставь текст отрывка.', 'err');
    if (clipDur() < 1) return setStatus('alignStatus', 'Отрывок слишком короткий.', 'err');
    pause();
    setBusy(true); setProgress('alignProgress', 0);
    setStatus('alignStatus', clipDur() > 90 ? 'Длинный отрывок — это займёт подольше…' : 'Слушаю трек…');
    const t0 = performance.now();
    const res = await api.syncAlign({ audioPath: state.audioPath, start: state.start, duration: clipDur(), lyrics: state.lyrics });
    setBusy(false); setProgress('alignProgress', null);
    if (!res || !res.success) return setStatus('alignStatus', 'Ошибка: ' + (res && res.error || 'неизвестно'), 'err');
    const r = res.result;
    state.lines = r.lines.map((l) => ({
        text: l.text,
        words: l.words.map((w) => ({ text: w.text, start: w.start != null ? +(w.start + state.start).toFixed(3) : null, end: w.end != null ? +(w.end + state.start).toFixed(3) : null })),
    }));
    selected = -1;
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    if (r.warnings && r.warnings.length) setStatus('alignStatus', r.warnings.join(' ') + ` (${sec} с)`, 'warn');
    else setStatus('alignStatus', `Готово за ${sec} с. Проверь на слух (Пробел) и подвинь слова, если нужно.`);
    cursorAbs = state.start;
    invalidate(); movePlayhead();
});

$('cancelBtn').addEventListener('click', () => api.syncCancel());

api.onSyncProgress((p) => {
    setProgress('alignProgress', p.value);
    const names = { audio: 'Читаю звук…', features: 'Готовлю звук…', encoder: 'Слушаю трек…', align: 'Расставляю слова…' };
    setStatus('alignStatus', `${names[p.stage] || ''} ${Math.round(p.value * 100)}%`);
});
api.onSyncRenderProgress((v) => { setProgress('renderProgress', v); setStatus('renderStatus', `Рендер… ${Math.round(v * 100)}%`); });

$('renderBtn').addEventListener('click', async () => {
    if (busy) return;
    if (!state.audioPath) return setStatus('renderStatus', 'Сначала выбери трек.', 'err');
    const lines = relLines();
    if (!lines.length) return setStatus('renderStatus', 'Сначала расставь тайминги.', 'err');
    pause();
    const fresh = await api.getMainConfig();
    if (fresh) applyConfig(fresh);
    setBusy(true); setProgress('renderProgress', 0); setStatus('renderStatus', 'Рендер…');
    const res = await api.syncRender({
        project: { audioPath: state.audioPath, start: state.start, end: state.end, lines, offset: state.offsetMs / 1000, name: state.audioName },
        config,
    });
    setBusy(false); setProgress('renderProgress', null);
    if (res && res.success) {
        const el = $('renderStatus');
        el.className = 'status';
        el.innerHTML = '✅ Готово! ';
        const pill = document.createElement('span');
        pill.className = 'drag-pill'; pill.draggable = true; pill.textContent = '⇱ Перетащить видео';
        pill.title = 'Потяни файл в CapCut или в папку';
        pill.addEventListener('dragstart', (ev) => { ev.preventDefault(); api.startDrag(res.outputPath); });
        el.appendChild(pill);
    } else if (res && (res.reason === 'cancelled' || res.error === 'Рендер отменён')) {
        setStatus('renderStatus', 'Рендер отменён.');
    } else {
        setStatus('renderStatus', 'Ошибка: ' + (res && res.error || 'неизвестно'), 'err');
    }
});

// ---------------------------------------------------------------- startup
api.onMainConfig((c) => applyConfig(c));

(async () => {
    applyConfig(await api.getMainConfig());
    const saved = await api.syncLoadProject();
    if (saved) {
        Object.assign(state, saved);
        $('lyrics').value = state.lyrics || '';
        $('offsetMs').value = state.offsetMs || 0;
        if (state.audioSource || state.audioPath) {
            const info = await api.syncAudioInfo(state.audioSource || state.audioPath);
            if (info && !info.error) await loadAudio(info, true);
            else { state.audioPath = null; $('audioName').textContent = 'Файл прошлого проекта не найден'; }
        }
        if (!state.lines && state.lyrics) reconcileLyrics(state.lyrics);
    }
    layoutTimeline();
    invalidate();
})();
