// --- TIMELINE EDITOR LOGIC ---
const loadTimelineAudioBtn = document.getElementById('loadTimelineAudioBtn');
const timelineAudioInput = document.getElementById('timelineAudioInput');
const waveformCanvas = document.getElementById('waveform-canvas');
const waveCtx = waveformCanvas.getContext('2d');
const timelineBlocksContainer = document.getElementById('timeline-blocks-container');
const timelineScrollContainer = document.getElementById('timeline-scroll-container');
const timelineStatus = document.getElementById('timeline-status');
const renderTimelineBtn = document.getElementById('renderTimelineBtn');
const playTimelineBtn = document.getElementById('playTimelineBtn');
const playhead = document.getElementById('playhead');
const videosCountSpan = document.getElementById('videos-count');

let audioContext = null;
let audioBuffer = null;
let audioDuration = 0; // seconds
let pixelsPerSecond = 100; // Zoom level
let timelineBlocksData = []; // Array of { id, text, start (sec), duration (sec), element, textSpan }
let globalConfig = {};

const liveVideoCache = {};
let isPreloadingVideos = false;

async function preloadLiveVideosSeq() {
    if (isPreloadingVideos) return;
    isPreloadingVideos = true;
    for (const b of timelineBlocksData) {
        if (!liveVideoCache[b.text]) {
            liveVideoCache[b.text] = 'loading';
            try {
                const bConfig = { ...globalConfig, blockDuration: b.duration };
                const res = await window.electronAPI.buildLivePreview({ text: b.text, config: bConfig });
                if (res.success) {
                    liveVideoCache[b.text] = `file://${res.outputPath}?t=${Date.now()}`;
                } else {
                    delete liveVideoCache[b.text];
                }
            } catch (e) {
                delete liveVideoCache[b.text];
            }
        }
    }
    isPreloadingVideos = false;
}

window.addEventListener('DOMContentLoaded', async () => {
    const data = await window.electronAPI.getTimelineData();
    if (data) {
        globalConfig = data.config || {};
        const savedBlocks = data.blocks || [];
        const texts = data.texts || [];

        videosCountSpan.innerText = texts.length;
        if (savedBlocks.length > 0 && texts.length === savedBlocks.length) {
            timelineBlocksContainer.innerHTML = '';
            timelineBlocksData = [];
            savedBlocks.forEach(sb => {
                const b = createTimelineBlockObject(sb.id, sb.text, sb.start, sb.duration);
                timelineBlocksData.push(b);
            });
            recalcTimelineWidth();
            preloadLiveVideosSeq();
        } else if (texts.length > 0) {
            initTimelineBlocks(texts);
        }
    }
});

loadTimelineAudioBtn.addEventListener('click', () => {
    timelineAudioInput.click();
});

timelineAudioInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    timelineStatus.innerText = "Загрузка и декодирование аудио...";
    try {
        const arrayBuffer = await file.arrayBuffer();
        if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();

        audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        audioDuration = audioBuffer.duration;

        timelineStatus.innerText = `Аудио: ${file.name} (${audioDuration.toFixed(1)} сек)`;

        // Resize canvas to fit whole audio at current zoom
        waveformCanvas.width = Math.max(timelineScrollContainer.clientWidth, audioDuration * pixelsPerSecond);
        document.getElementById('timeline-content').style.width = waveformCanvas.width + 'px';

        drawWaveform();
    } catch (err) {
        console.error("Audio Load Error:", err);
        timelineStatus.innerText = "Ошибка загрузки аудио!";
    }
});

function drawWaveform() {
    if (!audioBuffer) return;
    const width = waveformCanvas.width;
    const height = waveformCanvas.height;
    const channelData = audioBuffer.getChannelData(0); // Left channel

    waveCtx.clearRect(0, 0, width, height);
    waveCtx.fillStyle = 'rgba(142, 206, 0, 0.4)'; // Brat green faintly

    const step = Math.ceil(channelData.length / width);
    const amp = height / 2;

    waveCtx.beginPath();
    waveCtx.moveTo(0, amp);

    // Draw upper half
    for (let i = 0; i < width; i++) {
        let min = 1.0;
        let max = -1.0;
        for (let j = 0; j < step; j++) {
            const datum = channelData[(i * step) + j];
            if (datum < min) min = datum;
            if (datum > max) max = datum;
        }
        waveCtx.lineTo(i, (1 + min) * amp);
        waveCtx.lineTo(i, (1 + max) * amp);
    }

    waveCtx.lineTo(width, amp);
    waveCtx.stroke();
    waveCtx.fill();
}

function createTimelineBlockObject(id, text, startSec, durationSec) {
    const block = document.createElement('div');
    block.className = 'timeline-block';

    const textSpan = document.createElement('span');
    textSpan.className = 'block-text';
    textSpan.innerText = text;
    textSpan.style.pointerEvents = 'none'; // so we don't mess up drags
    block.appendChild(textSpan);

    const leftHandle = document.createElement('div');
    leftHandle.className = 'resize-handle left';

    const rightHandle = document.createElement('div');
    rightHandle.className = 'resize-handle right';

    block.appendChild(leftHandle);
    block.appendChild(rightHandle);
    timelineBlocksContainer.appendChild(block);

    const blockData = { id, text, start: startSec, duration: durationSec, element: block, textSpan: textSpan };

    updateBlockDOM(blockData);
    setupBlockInteraction(blockData, leftHandle, rightHandle);

    return blockData;
}

function initTimelineBlocks(texts) {
    timelineBlocksContainer.innerHTML = '';
    timelineBlocksData = [];
    let currentStart = 0;

    texts.forEach((text, i) => {
        const blockDuration = 2.0;
        const b = createTimelineBlockObject(i, text, currentStart, blockDuration);
        timelineBlocksData.push(b);
        currentStart += blockDuration + 0.5;
    });

    syncTimelineData();
    recalcTimelineWidth();
    preloadLiveVideosSeq();
}

function syncTimelineData() {
    const exportBlocks = timelineBlocksData.map(b => ({
        id: b.id,
        text: b.text,
        start: parseFloat(b.start.toFixed(3)),
        duration: parseFloat(b.duration.toFixed(3))
    })).sort((a, b) => a.start - b.start);
    window.electronAPI.saveTimelineData({ blocks: exportBlocks, texts: exportBlocks.map(b => b.text), config: globalConfig });
}

function recalcTimelineWidth() {
    let maxRight = audioDuration > 0 ? audioDuration : 0;
    timelineBlocksData.forEach(b => {
        const right = b.start + b.duration;
        if (right > maxRight) maxRight = right;
    });
    const reqWidth = Math.max(timelineScrollContainer.clientWidth, maxRight * pixelsPerSecond + 100);

    if (reqWidth > waveformCanvas.width) {
        waveformCanvas.width = reqWidth;
        document.getElementById('timeline-content').style.width = reqWidth + 'px';
        if (audioBuffer) drawWaveform();
    }
}

function updateBlockDOM(blockData) {
    const leftPx = blockData.start * pixelsPerSecond;
    const widthPx = blockData.duration * pixelsPerSecond;
    blockData.element.style.left = leftPx + 'px';
    blockData.element.style.width = widthPx + 'px';
}

function setupBlockInteraction(blockData, leftHandle, rightHandle) {
    let isDragging = false;
    let isResizingLeft = false;
    let isResizingRight = false;
    let startX = 0;
    let initialStart = 0;
    let initialDuration = 0;

    blockData.element.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('resize-handle')) return;
        isDragging = true;
        startX = e.clientX;
        initialStart = blockData.start;
        e.preventDefault(); // prevent selection
    });

    leftHandle.addEventListener('mousedown', (e) => {
        isResizingLeft = true;
        startX = e.clientX;
        initialStart = blockData.start;
        initialDuration = blockData.duration;
        e.preventDefault();
        e.stopPropagation();
    });

    rightHandle.addEventListener('mousedown', (e) => {
        isResizingRight = true;
        startX = e.clientX;
        initialDuration = blockData.duration;
        e.preventDefault();
        e.stopPropagation();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging && !isResizingLeft && !isResizingRight) return;

        const deltaPx = e.clientX - startX;
        const deltaSec = deltaPx / pixelsPerSecond;

        if (isDragging) {
            let newStart = initialStart + deltaSec;
            if (newStart < 0) newStart = 0;
            blockData.start = newStart;
        } else if (isResizingLeft) {
            let newStart = initialStart + deltaSec;
            let newDuration = initialDuration - deltaSec;

            if (newStart < 0) {
                newStart = 0;
                newDuration = initialDuration + initialStart;
            }
            if (newDuration < 0.2) {
                newDuration = 0.2;
                newStart = initialStart + initialDuration - 0.2;
            }

            blockData.start = newStart;
            blockData.duration = newDuration;
        } else if (isResizingRight) {
            let newDuration = initialDuration + deltaSec;
            if (newDuration < 0.2) newDuration = 0.2;
            blockData.duration = newDuration;
        }

        updateBlockDOM(blockData);
    });

    document.addEventListener('mouseup', () => {
        if (isDragging || isResizingLeft || isResizingRight) {
            recalcTimelineWidth();

            // If they changed the duration, we need to invalidate cache to rerender new speed video
            if (isResizingLeft || isResizingRight) {
                if (Math.abs(blockData.duration - initialDuration) > 0.1) {
                    delete liveVideoCache[blockData.text];
                    preloadLiveVideosSeq(); // Trigger a rebuild for this block's speed
                }
            }
            // Save state on any move
            syncTimelineData();
        }
        isDragging = false;
        isResizingLeft = false;
        isResizingRight = false;
    });
}

// --- TIMELINE AUDIO PLAYBACK & PREVIEW ---
let isPlaying = false;
let audioSource = null;
let playStartTime = 0;
let pauseTimeOffset = 0;
let animationFrameId = null;
let activePreviewBlock = null;

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

function updatePlayheadPreview(timeSec) {
    document.getElementById('preview-time').innerText = formatTime(timeSec);

    let foundBlock = null;
    // Find which block is under playhead
    for (let b of timelineBlocksData) {
        if (timeSec >= b.start && timeSec <= b.start + b.duration) {
            foundBlock = b;
            break;
        }
    }

    const img = document.getElementById('preview-img');
    const vid = document.getElementById('preview-video');

    if (foundBlock !== activePreviewBlock) {
        if (activePreviewBlock) activePreviewBlock.element.classList.remove('active');
        activePreviewBlock = foundBlock;

        if (foundBlock) {
            foundBlock.element.classList.add('active');

            const vidUrl = liveVideoCache[foundBlock.text];
            if (vidUrl && vidUrl !== 'loading') {
                if (vid.dataset.cachedUrl !== vidUrl) {
                    vid.src = vidUrl;
                    vid.dataset.cachedUrl = vidUrl;
                }
                img.style.opacity = '0';
                vid.style.opacity = '1';
                vid.currentTime = Math.max(0, timeSec - foundBlock.start);
                if (isPlaying) {
                    vid.play().catch(e => console.error("Autoplay error", e));
                } else {
                    vid.pause();
                }
            } else {
                vid.style.opacity = '0';
                vid.pause();
                img.style.opacity = '1';
                window.electronAPI.generatePreview({ text: foundBlock.text, config: globalConfig }).then(dataUrl => {
                    if (dataUrl && document.getElementById('preview-img').src !== dataUrl) {
                        document.getElementById('preview-img').src = dataUrl;
                    }
                });
            }
        } else {
            img.src = '';
            img.style.opacity = '1';
            vid.style.opacity = '0';
            vid.pause();
        }
    } else {
        if (foundBlock) {
            const vidUrl = liveVideoCache[foundBlock.text];
            if (vidUrl && vidUrl !== 'loading') {
                if (vid.dataset.cachedUrl !== vidUrl) {
                    vid.src = vidUrl;
                    vid.dataset.cachedUrl = vidUrl;
                    img.style.opacity = '0';
                    vid.style.opacity = '1';
                }

                if (!isPlaying) {
                    vid.currentTime = Math.max(0, timeSec - foundBlock.start);
                } else {
                    const expectedTime = timeSec - foundBlock.start;
                    if (Math.abs(vid.currentTime - expectedTime) > 0.2) {
                        vid.currentTime = Math.max(0, expectedTime);
                        vid.play().catch(e => { });
                    } else if (vid.paused) {
                        vid.play().catch(e => { });
                    }
                }
            }
        }
    }
}

function stopPreviewPlayback() {
    if (audioSource) {
        try { audioSource.stop(); } catch (e) { }
    }
    isPlaying = false;
    cancelAnimationFrame(animationFrameId);
    playTimelineBtn.innerHTML = '▶ Плей / Пауза (Пробел)';

    // Pause video
    const vid = document.getElementById('preview-video');
    if (vid) vid.pause();
}

function togglePlayback() {
    if (!audioBuffer) return;

    if (isPlaying) {
        // Pause
        stopPreviewPlayback();
        pauseTimeOffset += audioContext.currentTime - playStartTime;
    } else {
        // Play
        if (pauseTimeOffset >= audioBuffer.duration) {
            pauseTimeOffset = 0;
        }
        audioSource = audioContext.createBufferSource();
        audioSource.buffer = audioBuffer;
        audioSource.connect(audioContext.destination);

        audioSource.start(0, pauseTimeOffset);
        playStartTime = audioContext.currentTime;
        isPlaying = true;
        playTimelineBtn.innerHTML = '⏸ Пауза (Пробел)';

        audioSource.onended = () => {
            // when reached end naturally and not stopped by pause
            if (isPlaying) {
                isPlaying = false;
                pauseTimeOffset = 0;
                playTimelineBtn.innerHTML = '▶ Плей / Пауза (Пробел)';
                cancelAnimationFrame(animationFrameId);
                playhead.style.display = 'none';
                updatePlayheadPreview(0);
            }
        };

        playhead.style.display = 'block';
        const loop = () => {
            if (!isPlaying) return;
            const elapsed = pauseTimeOffset + (audioContext.currentTime - playStartTime);
            playhead.style.left = (elapsed * pixelsPerSecond) + 'px';

            // Auto-scroll
            const container = timelineScrollContainer;
            const playheadPx = elapsed * pixelsPerSecond;
            if (playheadPx > container.scrollLeft + container.clientWidth * 0.8) {
                container.scrollLeft = playheadPx - container.clientWidth * 0.2;
            } else if (playheadPx < container.scrollLeft) {
                container.scrollLeft = playheadPx;
            }

            updatePlayheadPreview(elapsed);

            animationFrameId = requestAnimationFrame(loop);
        };
        loop();
    }
}

playTimelineBtn.addEventListener('click', togglePlayback);

// Spacebar controls playback
document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
        e.preventDefault(); // prevent scrolling
        if (audioBuffer) togglePlayback();
    }
});

// Seek by clicking on timeline
document.getElementById('timeline-content').addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('resize-handle')) return;
    if (e.target.classList.contains('timeline-block')) return;

    if (!audioBuffer) return;
    const contentRect = document.getElementById('timeline-content').getBoundingClientRect();
    let clickX = e.clientX - contentRect.left;
    let timeSec = clickX / pixelsPerSecond;
    if (timeSec < 0) timeSec = 0;
    if (timeSec > audioBuffer.duration) timeSec = audioBuffer.duration;

    pauseTimeOffset = timeSec;

    playhead.style.display = 'block';
    playhead.style.left = (pauseTimeOffset * pixelsPerSecond) + 'px';
    activePreviewBlock = null; // force preview generation refresh
    updatePlayheadPreview(pauseTimeOffset);

    if (isPlaying) {
        stopPreviewPlayback();
        // play again
        audioSource = audioContext.createBufferSource();
        audioSource.buffer = audioBuffer;
        audioSource.connect(audioContext.destination);
        audioSource.start(0, pauseTimeOffset);
        playStartTime = audioContext.currentTime;
        isPlaying = true;
        playTimelineBtn.innerHTML = '⏸ Пауза (Пробел)';

        audioSource.onended = () => {
            if (isPlaying) {
                isPlaying = false;
                pauseTimeOffset = 0;
                playTimelineBtn.innerHTML = '▶ Плей / Пауза (Пробел)';
                cancelAnimationFrame(animationFrameId);
                playhead.style.display = 'none';
                updatePlayheadPreview(0);
            }
        };
    }
});

// --- RENDER TIMELINE (FFMPEG) ---
let isTimelineRendering = false;
renderTimelineBtn.addEventListener('click', async () => {
    if (isTimelineRendering) return;
    if (!audioBuffer) {
        alert("Пожалуйста, сначала загрузите аудио-файл.");
        return;
    }
    if (timelineBlocksData.length === 0) {
        alert("Нет блоков для рендера.");
        return;
    }

    if (isPlaying) stopPreviewPlayback();

    isTimelineRendering = true;
    renderTimelineBtn.disabled = true;
    timelineStatus.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" class="spin" style="stroke:var(--accent)"><circle cx="12" cy="12" r="10"></circle></svg> Рендеринг таймлайна...`;

    const audioPath = timelineAudioInput.files[0].path;

    const timelineExportData = timelineBlocksData.map(b => ({
        text: b.text,
        startTime: parseFloat(b.start.toFixed(3)),
        duration: parseFloat(b.duration.toFixed(3))
    })).sort((a, b) => a.startTime - b.startTime);

    const config = Object.assign({}, globalConfig);
    config.totalDuration = audioDuration;
    config.audioPath = audioPath;
    config.isTimelineMode = true;

    try {
        const result = await window.electronAPI.renderTimelineVideo({
            timelineData: timelineExportData,
            config: config
        });

        if (result.success) {
            const pathsArg = `'${result.outputPath.replace(/\\/g, '\\\\')}'`;
            timelineStatus.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                <div>✅ Рендер таймлайна успешен!</div>
                <div draggable="true" 
                        style="cursor: grab; display: inline-flex; align-items: center; gap: 4px; background: rgba(0, 255, 68, 0.1); border: 1px solid rgba(0, 255, 68, 0.3); padding: 4px 10px; border-radius: 6px; user-select: none;"
                        ondragstart="event.preventDefault(); window.electronAPI.startDrag(${pathsArg});"
                        title="Потяните этот файл в CapCut или папку">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                        Перетащить видео 
                </div>
            </div>`;
        } else {
            timelineStatus.innerHTML = `<span style="color:var(--danger)">Ошибка: ${result.error || result.reason}</span>`;
        }
    } catch (err) {
        timelineStatus.innerHTML = `<span style="color:var(--danger)">Критическая ошибка: ${err.message}</span>`;
    }

    renderTimelineBtn.disabled = false;
    isTimelineRendering = false;
});
