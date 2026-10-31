const { app, BrowserWindow, ipcMain, dialog, screen, desktopCapturer, shell } = require('electron');
require('dotenv').config();
const aptabase = require('@aptabase/electron/main');

// Initialize Analytics absolutely first (Electron SDK Requirement)
if (process.env.APTABASE_APP_KEY) {
    aptabase.initialize(process.env.APTABASE_APP_KEY, { appVersion: app.getVersion() });
    console.log('[Analytics] Aptabase initialized for appVersion:', app.getVersion());
} else {
    console.warn('[Analytics] APTABASE_APP_KEY is missing in .env! Telemetry disabled.');
}

const path = require('path');
const fs = require('fs-extra');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const { renderVideo } = require('../renderer');
const presets = require('../presets');

// Configure auto-updater logging
log.transports.file.level = 'debug';
autoUpdater.logger = log;
autoUpdater.autoDownload = false; // Require user consent before downloading

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        resizable: false,
        icon: path.join(__dirname, '../../assets/icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: false // allow loading local temp files for preview video <video src="file:///">
        },
        backgroundColor: '#000000', // UI dark mode
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.autoHideMenuBar = true;

    mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
    if (process.env.APTABASE_APP_KEY) {
        aptabase.trackEvent('app_started');
        console.log('[Analytics] app_started event dispatched');
    }

    createWindow();

    // Check for updates silently in the background
    autoUpdater.checkForUpdatesAndNotify().catch(err => {
        log.error("Check for updates failed:", err);
    });

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// Ensure temp directory exists for preview files
fs.ensureDirSync(app.getPath('temp'));

// --- AUTO UPDATER LOGIC ---
autoUpdater.on('update-available', (info) => {
    log.info('Update available:', info.version);

    dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'Доступно обновление!',
        message: `Новая версия 2Pizza Generator (${info.version}) доступна для скачивания. Хотите загрузить и установить её сейчас?`,
        buttons: ['Да, скачать', 'Позже'],
        defaultId: 0,
        cancelId: 1
    }).then((result) => {
        if (result.response === 0) {
            autoUpdater.downloadUpdate();
        }
    });
});

let progressWin = null;

autoUpdater.on('download-progress', (progressObj) => {
    let log_message = `Download speed: ${progressObj.bytesPerSecond} - Downloaded ${progressObj.percent}% (${progressObj.transferred}/${progressObj.total})`;
    log.info(log_message);

    if (mainWindow) {
        // We can show progress in the main window title as fallback
        mainWindow.setTitle(`2Pizza Generator - Downloading Update... ${Math.round(progressObj.percent)}%`);
        // Send the real progress to the renderer
        mainWindow.webContents.send('update-progress', {
            percent: progressObj.percent,
            transferred: progressObj.transferred,
            total: progressObj.total
        });
    }
});

autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded');

    if (mainWindow) {
        mainWindow.setTitle('2Pizza Generator'); // Reset title
    }

    // Prompt user to install the update
    dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Обновление готово',
        message: 'Обновление загружено. Перезапустить приложение для установки?',
        buttons: ['Перезапустить сейчас', 'Установить при следующем запуске']
    }).then((result) => {
        if (result.response === 0) {
            autoUpdater.quitAndInstall(false, true);
        }
    });
});

autoUpdater.on('error', (err) => {
    log.error('Error in auto-updater. ' + err);

    if (mainWindow) {
        mainWindow.setTitle('2Pizza Generator'); // Reset title in case it was showing progress
    }

    // Don't show error for "No published versions on GitHub" which happens natively occasionally in dev
    if (!err.toString().includes('No published versions on GitHub') && !err.toString().includes('net::ERR_INTERNET_DISCONNECTED')) {
        dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Ошибка обновления',
            message: 'Не удалось загрузить обновление.',
            detail: 'Произошла ошибка сети (возможно, VPN или блокировка провайдера). Пожалуйста, скачайте новую версию вручную с нашего GitHub.\n\nКод ошибки:\n' + err.toString().split('\n')[0],
            buttons: ['ОК', 'Скачать вручную', 'Сбросить кэш и повторить']
        }).then((result) => {
            if (result.response === 1) {
                require('electron').shell.openExternal('https://github.com/mamaotstan/brat/releases/latest');
            } else if (result.response === 2) {
                // Try again: clear cache and trigger update check
                try {
                    const localAppData = process.env.LOCALAPPDATA;
                    if (localAppData) {
                        const cacheDir1 = path.join(localAppData, 'brat-video-gen-updater');
                        const cacheDir2 = path.join(localAppData, 'Brat Video Generator-updater');
                        const cacheDir3 = path.join(localAppData, '2pizza-generator-updater'); // Just in case

                        [cacheDir1, cacheDir2, cacheDir3].forEach(dir => {
                            if (fs.existsSync(dir)) {
                                fs.rmSync(dir, { recursive: true, force: true });
                                log.info('Cleared updater cache: ' + dir);
                            }
                        });
                    }
                } catch (e) {
                    log.error('Failed to clear updater cache: ' + e);
                }

                // Trigger check again
                setTimeout(() => {
                    autoUpdater.checkForUpdates();
                }, 1000);
            }
        });
    }
});
// ----------------------------

// IPC Handlers

// Get all presets
ipcMain.handle('get-preset', () => presets);

// Get app version
// Test builds started by the launcher show their commit next to the version
ipcMain.handle('get-version', () => app.getVersion() + (process.env.BRAT_TEST_BUILD ? ` · тест ${process.env.BRAT_TEST_BUILD}` : ''));
ipcMain.handle('is-test-build', () => !!process.env.BRAT_TEST_BUILD);

// Pick color from screen (native eyedropper for outside app window)
ipcMain.handle('pick-screen-color', async () => {
    try {
        const point = screen.getCursorScreenPoint();
        const display = screen.getDisplayNearestPoint(point);

        // Capture the entire display
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: display.size.width, height: display.size.height }
        });

        // Find the source matching our display
        const source = sources.find(s => s.display_id === String(display.id)) || sources[0];
        if (!source) return null;

        const thumbnail = source.thumbnail;
        // Get the pixel at cursor position (relative to display bounds)
        const x = point.x - display.bounds.x;
        const y = point.y - display.bounds.y;
        const bitmap = thumbnail.toBitmap();
        const width = thumbnail.getSize().width;

        // BGRA format, 4 bytes per pixel
        const offset = (y * width + x) * 4;
        const b = bitmap[offset];
        const g = bitmap[offset + 1];
        const r = bitmap[offset + 2];

        const hex = '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
        return hex;
    } catch (e) {
        console.error('pick-screen-color error:', e);
        return null;
    }
});

// Get system fonts
ipcMain.handle('get-system-fonts', () => {
    try {
        const { GlobalFonts } = require('@napi-rs/canvas');
        const { loadFonts } = require('../renderer');
        loadFonts(path.join(__dirname, '../../assets/fonts/Inter-Medium.ttf'));
        const families = GlobalFonts.families.map(f => f.family).sort();
        return families;
    } catch (e) {
        console.error('Failed to get system fonts:', e);
        return ['Arial Narrow', 'Arial', 'Inter', 'Times New Roman', 'Comic Sans MS'];
    }
});

// Open link in default browser
ipcMain.handle('open-external', async (event, url) => {
    try {
        await shell.openExternal(url);
    } catch (e) {
        console.error('Failed to open external url:', e);
    }
});

// Drag and drop out of the app
ipcMain.on('start-drag', (event, filePath) => {
    const { nativeImage } = require('electron');
    const iconPath = path.join(__dirname, '../../assets/icon.png');
    const icon = nativeImage.createFromPath(iconPath);

    // Electron supports files: [] for multiple files (macOS/Windows)
    const dragPayload = { icon: icon };
    if (Array.isArray(filePath)) {
        dragPayload.files = filePath;
    } else {
        dragPayload.file = filePath;
    }

    event.sender.startDrag(dragPayload);
});

// Helper: auto-increment filename if it already exists
const getUniqueOutputPath = (filePath) => {
    if (!fs.existsSync(filePath)) return filePath;
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    let counter = 1;
    let candidate;
    do {
        candidate = path.join(dir, `${base}_${counter}${ext}`);
        counter++;
    } while (fs.existsSync(candidate));
    return candidate;
};

// Render Video
ipcMain.handle('render-video', async (event, { text, config, outputPath }) => {
    try {
        console.log('Rendering with config:', config);
        let textsToRender = Array.isArray(text) ? text : [text];
        let isBatch = false;
        if (config.batchMode && textsToRender.length >= 1) {
            isBatch = true;
        }

        if (!outputPath) {
            // Ensure default output folder exists
            const defaultDir = path.join(app.getPath('documents'), '2pizza');
            if (!fs.existsSync(defaultDir)) fs.mkdirSync(defaultDir, { recursive: true });

            if (isBatch) {
                const { filePaths } = await dialog.showOpenDialog(mainWindow, {
                    buttonLabel: 'Выбрать папку',
                    title: `Куда сохранить ${textsToRender.length} видео?`,
                    defaultPath: defaultDir,
                    properties: ['openDirectory']
                });
                if (!filePaths || filePaths.length === 0) return { success: false, reason: 'cancelled' };
                outputPath = filePaths[0];
            } else {
                // Use first word of text as default filename
                const baseText = Array.isArray(text) ? textsToRender[0] : text;
                const firstWord = (baseText || '').trim().split(/\s+/)[0] || '2pizza_video';
                const safeName = firstWord.replace(/[^a-zA-Zа-яА-ЯёЁ0-9_-]/g, '_');

                let dfExt = 'mp4';
                let dfName = 'MP4 Video';
                if (config.exportFormat === 'mov_prores') {
                    dfExt = 'mov';
                    dfName = 'MOV Video (ProRes with Alpha)';
                }
                const { filePath } = await dialog.showSaveDialog(mainWindow, {
                    buttonLabel: 'Save Video',
                    defaultPath: getUniqueOutputPath(path.join(defaultDir, `${safeName}.${dfExt}`)),
                    filters: [{ name: dfName, extensions: [dfExt] }]
                });

                if (!filePath) return { success: false, reason: 'cancelled' };
                outputPath = filePath;
            }
        }

        config.width = parseInt(config.width);
        config.height = parseInt(config.height);
        config.fps = parseInt(config.fps);
        config.charsPerSecond = parseFloat(config.charsPerSecond);
        config.fontSizeOverride = config.fontSizeOverride ? parseInt(config.fontSizeOverride) : null;

        const { loadFonts } = require('../renderer');
        loadFonts(path.join(__dirname, '../../assets/fonts/Inter-Medium.ttf'));

        const outputPaths = [];

        for (let i = 0; i < textsToRender.length; i++) {
            const lineText = textsToRender[i];
            let finalPath = outputPath;

            if (isBatch) {
                let dfExt = config.exportFormat === 'mov_prores' ? 'mov' : 'mp4';
                const safeName = lineText.split(/\s+/)[0].replace(/[^a-zA-Zа-яА-ЯёЁ0-9_-]/g, '_') || `video`;
                finalPath = getUniqueOutputPath(path.join(outputPath, `${safeName}.${dfExt}`));
                console.log(`Rendering batch video ${i + 1}/${textsToRender.length}: ${finalPath}`);
            }

            finalPath = await renderVideo(lineText, { ...config }, finalPath) || finalPath;
            outputPaths.push(finalPath);
        }

        if (process.env.APTABASE_APP_KEY) {
            aptabase.trackEvent('render_video', {
                format: config.exportFormat,
                batchMode: isBatch,
                count: textsToRender.length
            });
        }

        mainWindow.focus();
        return { success: true, outputPath: isBatch ? outputPaths : outputPaths[0] };
    } catch (err) {
        console.error(err);
        return { success: false, error: err.message };
    }
});

// Render Timeline Video
ipcMain.handle('render-timeline-video', async (event, { timelineData, config }) => {
    try {
        console.log('Rendering Timeline with config:', config);

        let dfExt = 'mp4';
        let dfName = 'MP4 Video';
        if (config.exportFormat === 'mov_prores') {
            dfExt = 'mov';
            dfName = 'MOV Video (ProRes with Alpha)';
        }

        const { filePath } = await dialog.showSaveDialog(mainWindow, {
            buttonLabel: 'Save Timeline Video',
            defaultPath: getUniqueOutputPath(path.join(app.getPath('documents'), '2pizza', `timeline_video.${dfExt}`)),
            filters: [{ name: dfName, extensions: [dfExt] }]
        });

        if (!filePath) return { success: false, reason: 'cancelled' };

        config.width = parseInt(config.width);
        config.height = parseInt(config.height);
        config.fps = parseInt(config.fps);
        config.charsPerSecond = parseFloat(config.charsPerSecond);
        config.fontSizeOverride = config.fontSizeOverride ? parseInt(config.fontSizeOverride) : null;

        const { loadFonts, renderTimeline } = require('../renderer');
        loadFonts(path.join(__dirname, '../../assets/fonts/Inter-Medium.ttf'));

        // Call specialized timeline renderer
        await renderTimeline(timelineData, config, filePath);

        if (process.env.APTABASE_APP_KEY) {
            aptabase.trackEvent('render_timeline_video', {
                format: config.exportFormat,
                blocksCount: timelineData.length,
                totalDuration: config.totalDuration
            });
        }

        mainWindow.focus();
        return { success: true, outputPath: filePath };
    } catch (err) {
        console.error(err);
        return { success: false, error: err.message };
    }
});

// Build Animated Preview (WebM chunk)
ipcMain.handle('build-live-preview', async (event, { text, config }) => {
    try {
        console.log('Building Live Preview Stream...');
        // Force settings for faster/lighter preview
        const previewConfig = { ...config };
        previewConfig.isPreview = true; // Tell ffmpeg to use webm, but keep original exportFormat for background clearing logic

        // If rendering for timeline, adjust the typing speed to match the block duration
        if (previewConfig.blockDuration) {
            const totalChars = text.length;
            previewConfig.charsPerSecond = totalChars / previewConfig.blockDuration;
            // Ensure it doesn't leave an empty trailing duration, preview should exactly match the block 
            // but renderer video also has endHold, we'll let renderVideo logic handle that or set it to 0
            // if we just want a tight preview. We'll leave endHold config as is for now.
        }

        const tmpPath = path.join(app.getPath('temp'), `2pizza_preview_${Date.now()}.webm`);

        const { loadFonts, renderVideo } = require('../renderer');
        loadFonts(path.join(__dirname, '../../assets/fonts/Inter-Medium.ttf'));

        await renderVideo(text, previewConfig, tmpPath);

        return { success: true, outputPath: tmpPath };
    } catch (e) {
        console.error("Build Live Preview Error:", e);
        return { success: false, error: e.message };
    }
});

// Preview Frame (generate single frame for UI preview)
ipcMain.handle('generate-preview', async (event, { text, config }) => {
    try {
        console.log('Preview config:', config);
        const { loadFonts } = require('../renderer');
        loadFonts(path.join(__dirname, '../../assets/fonts/Inter-Medium.ttf'));

        const { createCanvas } = require('@napi-rs/canvas');
        const { calculateLayout, getFlatCharacterPositions } = require('../layout');

        const canvas = createCanvas(config.width, config.height);
        const ctx = canvas.getContext('2d');

        // Draw background if not transparent
        if (config.exportFormat !== 'mov_prores' && config.exportFormat !== 'webm_preview') {
            ctx.fillStyle = config.backgroundColor || 'rgb(0,255,0)';
            ctx.fillRect(0, 0, config.width, config.height);
        } else {
            ctx.clearRect(0, 0, config.width, config.height);
        }

        // Calculate Layout
        const layout = calculateLayout(ctx, text, config);
        const { fontSize, lines, blockWidth, blockHeight, fontBase } = layout;
        const originX = (config.width - blockWidth) / 2;
        const originY = (config.height - blockHeight) / 2;

        ctx.fillStyle = config.textColor;
        ctx.font = `${config.fontWeight} ${fontSize}px "${fontBase}"`;
        ctx.textBaseline = 'top';

        if (config.dropShadow && config.dropShadow > 0) {
            // Shadow color will be handled per character
            ctx.shadowColor = config.textColor === '#ffffff' ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.8)';
            ctx.shadowBlur = config.dropShadow;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
        }

        if (config.blur && config.blur > 0) {
            ctx.filter = `blur(${config.blur}px)`;
        }

        const flatChars = getFlatCharacterPositions(
            ctx, lines, originX, originY, fontSize, config.lineHeight,
            fontBase, config.fontWeight, blockWidth, config.textAlign, layout.colorMap
        );

        // Chromatic Aberration
        if (config.chroma && config.chroma > 0) {
            ctx.globalCompositeOperation = (config.exportFormat && config.exportFormat.includes('mp4_green')) ? 'source-over' : 'screen';

            ctx.fillStyle = `rgba(255, 0, 0, 0.5)`;
            flatChars.forEach(charObj => {
                if (charObj.char.trim().length > 0) {
                    ctx.fillText(charObj.char, charObj.x - config.chroma, charObj.y);
                }
            });

            ctx.fillStyle = `rgba(0, 0, 255, 0.5)`;
            flatChars.forEach(charObj => {
                if (charObj.char.trim().length > 0) {
                    ctx.fillText(charObj.char, charObj.x + config.chroma, charObj.y);
                }
            });
            ctx.globalCompositeOperation = 'source-over';
        }

        flatChars.forEach(charObj => {
            if (charObj.char.trim().length > 0) {
                if (charObj.color) {
                    ctx.fillStyle = charObj.color;
                    if (config.dropShadow && config.dropShadow > 0) {
                        ctx.shadowColor = charObj.color === '#ffffff' ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.8)';
                    }
                } else {
                    ctx.fillStyle = config.textColor;
                    if (config.dropShadow && config.dropShadow > 0) {
                        ctx.shadowColor = config.textColor === '#ffffff' ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.8)';
                    }
                }
                ctx.fillText(charObj.char, charObj.x, charObj.y);
            }
        });

        return canvas.toDataURL('image/png');

    } catch (e) {
        console.error("Preview Error:", e);
        return null;
    }
});

// Save Screenshot (PNG of final rendered text)
ipcMain.handle('save-screenshot', async (event, { text, config }) => {
    try {
        const { loadFonts } = require('../renderer');
        loadFonts(path.join(__dirname, '../../assets/fonts/Inter-Medium.ttf'));

        const { createCanvas } = require('@napi-rs/canvas');
        const { calculateLayout, getFlatCharacterPositions } = require('../layout');

        const w = parseInt(config.width);
        const h = parseInt(config.height);

        const canvas = createCanvas(w, h);
        const ctx = canvas.getContext('2d');

        if (config.exportFormat !== 'mov_prores') {
            ctx.fillStyle = config.backgroundColor;
            ctx.fillRect(0, 0, w, h);
        } else {
            ctx.clearRect(0, 0, w, h);
        }

        const layout = calculateLayout(ctx, text, config);
        const { fontSize, lines, blockWidth, blockHeight, fontBase } = layout;
        const originX = (w - blockWidth) / 2;
        const originY = (h - blockHeight) / 2;

        ctx.fillStyle = config.textColor;
        ctx.font = `${config.fontWeight} ${fontSize}px "${fontBase}"`;
        ctx.textBaseline = 'top';

        if (config.dropShadow && config.dropShadow > 0) {
            ctx.shadowColor = config.textColor === '#ffffff' ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.8)';
            ctx.shadowBlur = config.dropShadow;
        }

        if (config.blur && config.blur > 0) {
            ctx.filter = `blur(${config.blur}px)`;
        }

        const flatChars = getFlatCharacterPositions(
            ctx, lines, originX, originY, fontSize, config.lineHeight,
            fontBase, config.fontWeight, blockWidth, config.textAlign, layout.colorMap
        );

        // Chromatic Aberration
        if (config.chroma && config.chroma > 0) {
            ctx.globalCompositeOperation = (config.exportFormat && config.exportFormat.includes('mp4_green')) ? 'source-over' : 'screen';

            ctx.fillStyle = `rgba(255, 0, 0, 0.5)`;
            flatChars.forEach(charObj => {
                if (charObj.char.trim().length > 0) {
                    ctx.fillText(charObj.char, charObj.x - config.chroma, charObj.y);
                }
            });

            ctx.fillStyle = `rgba(0, 0, 255, 0.5)`;
            flatChars.forEach(charObj => {
                if (charObj.char.trim().length > 0) {
                    ctx.fillText(charObj.char, charObj.x + config.chroma, charObj.y);
                }
            });
            ctx.globalCompositeOperation = 'source-over';
        }

        flatChars.forEach(charObj => {
            if (charObj.char.trim().length > 0) {
                if (charObj.color) {
                    ctx.fillStyle = charObj.color;
                    if (config.dropShadow && config.dropShadow > 0) {
                        ctx.shadowColor = charObj.color === '#ffffff' ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.8)';
                    }
                } else {
                    ctx.fillStyle = config.textColor;
                    if (config.dropShadow && config.dropShadow > 0) {
                        ctx.shadowColor = config.textColor === '#ffffff' ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.8)';
                    }
                }
                ctx.fillText(charObj.char, charObj.x, charObj.y);
            }
        });

        const { filePath } = await dialog.showSaveDialog(mainWindow, {
            buttonLabel: 'Save Screenshot',
            defaultPath: path.join(app.getPath('documents'), '2pizza', '2pizza_screenshot.png'),
            filters: [{ name: 'PNG Image', extensions: ['png'] }]
        });

        if (!filePath) return { success: false, reason: 'cancelled' };

        const buffer = canvas.toBuffer('image/png');
        await fs.writeFile(filePath, buffer);

        return { success: true, outputPath: filePath };
    } catch (e) {
        console.error("Screenshot Error:", e);
        return { success: false, error: e.message };
    }
});

// extractFontName removed (dead code)

let timelineWindow = null;
let globalTimelineData = { texts: [], config: {} };

ipcMain.handle('open-timeline', async (event, data) => {
    globalTimelineData = data;

    if (timelineWindow) {
        timelineWindow.focus();
        // Send an event incase they just updated texts while it was open?
        // timelineWindow.webContents.send('timeline-data-updated', globalTimelineData);
        return { success: true };
    }

    timelineWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        title: 'Редактор Таймлайна',
        icon: path.join(__dirname, '../../assets/icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: false
        },
        backgroundColor: '#000000'
    });

    timelineWindow.setMenuBarVisibility(false);
    timelineWindow.autoHideMenuBar = true;

    timelineWindow.loadFile(path.join(__dirname, 'timeline.html'));

    timelineWindow.on('closed', () => {
        timelineWindow = null;
    });

    return { success: true };
});

ipcMain.handle('get-timeline-data', () => {
    return globalTimelineData;
});

ipcMain.handle('save-timeline-data', (event, data) => {
    if (data) {
        globalTimelineData = data;
    }
    return { success: true };
});

ipcMain.handle('close-timeline', () => {
    if (timelineWindow) {
        timelineWindow.close();
    }
});

// --- V2: TRACK + TEXT (auto-sync) -----------------------------------------
// A mode of the main window: the user loads a track and types the lyrics, the
// aligner (offline, in a low-priority child process) places every word, and the
// video is rendered with the usual style settings and the track muxed in.

let syncJob = null;          // running auto-sync { cancel }
let syncRenderToken = null;  // running render { cancelled }

const PLAYABLE_EXT = new Set(['.mp3', '.wav', '.ogg', '.oga', '.opus', '.flac', '.m4a', '.aac', '.mp4', '.m4v', '.webm', '.mov']);

/** Path, playable URL, name and duration of an audio/video file. Formats Chromium cannot play are converted to WAV once. */
async function describeAudio(filePath) {
    const { pathToFileURL } = require('url');
    const { probeDuration, ffmpegPath } = require('../sync/audio');
    if (!filePath || !fs.existsSync(filePath)) return { error: 'Файл не найден' };
    let playable = filePath;
    if (!PLAYABLE_EXT.has(path.extname(filePath).toLowerCase())) {
        const out = path.join(app.getPath('temp'), `2pizza_track_${Date.now()}.wav`);
        await new Promise((resolve, reject) => {
            const { spawn } = require('child_process');
            const p = spawn(ffmpegPath(), ['-y', '-v', 'error', '-i', filePath, '-vn', '-ac', '2', '-ar', '44100', out], { windowsHide: true });
            let err = '';
            p.stderr.on('data', (d) => { err += d; });
            p.on('error', reject);
            p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || 'не удалось прочитать файл'))));
        });
        playable = out;
    }
    const duration = await probeDuration(playable);
    return { path: playable, original: filePath, url: pathToFileURL(playable).href, name: path.basename(filePath), duration };
}

ipcMain.handle('sync-pick-audio', async () => {
    const { filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: 'Выберите трек',
        properties: ['openFile'],
        filters: [
            { name: 'Аудио и видео', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aiff', 'aif', 'mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'] },
            { name: 'Все файлы', extensions: ['*'] },
        ],
    });
    if (!filePaths || !filePaths.length) return null;
    try { return await describeAudio(filePaths[0]); } catch (e) { return { error: 'Не удалось открыть файл: ' + e.message }; }
});

ipcMain.handle('sync-audio-info', async (event, filePath) => {
    try { return await describeAudio(filePath); } catch (e) { return { error: e.message }; }
});

ipcMain.handle('sync-align', async (event, job) => {
    const { runAutoSync } = require('../sync');
    if (syncJob) syncJob.cancel();
    const sender = event.sender;
    const t0 = Date.now();
    syncJob = runAutoSync(job, (value, stage) => {
        if (!sender.isDestroyed()) sender.send('sync-progress', { value, stage });
    });
    const current = syncJob;
    try {
        const result = await current.promise;
        if (process.env.APTABASE_APP_KEY) {
            aptabase.trackEvent('auto_sync', { seconds: Math.round(job.duration || 0), took: Math.round((Date.now() - t0) / 100) / 10 });
        }
        return { success: true, result };
    } catch (e) {
        log.error('Auto-sync failed:', e);
        return { success: false, error: e.message };
    } finally {
        if (syncJob === current) syncJob = null;
    }
});

ipcMain.handle('sync-cancel', () => {
    if (syncJob) { syncJob.cancel(); syncJob = null; }
    if (syncRenderToken) syncRenderToken.cancelled = true;
    return { success: true };
});

ipcMain.handle('sync-render', async (event, { project, config }) => {
    try {
        const ext = config.exportFormat === 'mov_prores' ? 'mov' : 'mp4';
        const base = String(project.name || 'track').replace(/\.[^.]+$/, '').replace(/[^a-zA-Zа-яА-ЯёЁ0-9_-]+/g, '_').slice(0, 60) || 'track';
        const defaultDir = path.join(app.getPath('documents'), '2pizza');
        fs.ensureDirSync(defaultDir);
        const { filePath } = await dialog.showSaveDialog(mainWindow, {
            buttonLabel: 'Сохранить видео',
            defaultPath: getUniqueOutputPath(path.join(defaultDir, `${base}_lyrics.${ext}`)),
            filters: [{ name: ext === 'mov' ? 'MOV Video (ProRes with Alpha)' : 'MP4 Video', extensions: [ext] }],
        });
        if (!filePath) return { success: false, reason: 'cancelled' };

        const cfg = Object.assign({}, config, {
            width: parseInt(config.width, 10) || 900,
            height: parseInt(config.height, 10) || 900,
            fps: parseInt(config.fps, 10) || 30,
        });
        delete cfg.isPreview;
        const { loadFonts } = require('../renderer');
        loadFonts(path.join(__dirname, '../../assets/fonts/Inter-Medium.ttf'));
        const { renderSyncedVideo } = require('../syncRenderer');

        const sender = event.sender;
        syncRenderToken = { cancelled: false };
        const token = syncRenderToken;
        const t0 = Date.now();
        const outputPath = await renderSyncedVideo(project, cfg, filePath, (v) => {
            if (!sender.isDestroyed()) sender.send('sync-render-progress', v);
        }, token);
        if (syncRenderToken === token) syncRenderToken = null;

        if (process.env.APTABASE_APP_KEY) {
            aptabase.trackEvent('render_sync_video', {
                format: cfg.exportFormat,
                seconds: Math.round((project.end || 0) - (project.start || 0)),
                took: Math.round((Date.now() - t0) / 1000),
            });
        }
        return { success: true, outputPath };
    } catch (err) {
        syncRenderToken = null;
        log.error('Sync render failed:', err);
        return { success: false, error: err.message };
    }
});
