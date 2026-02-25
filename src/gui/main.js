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

autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded');

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
});
// ----------------------------

// IPC Handlers

// Get all presets
ipcMain.handle('get-preset', () => presets);

// Get app version
ipcMain.handle('get-version', () => app.getVersion());

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
