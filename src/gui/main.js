const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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
        message: `Новая версия Brat Video Generator (${info.version}) доступна для скачивания. Хотите загрузить и установить её сейчас?`,
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

// Render Video
ipcMain.handle('render-video', async (event, { text, config, outputPath }) => {
    try {
        console.log('Rendering with config:', config);
        if (!outputPath) {
            // Use first word of text as default filename
            const firstWord = (text || '').trim().split(/\s+/)[0] || 'brat_video';
            const safeName = firstWord.replace(/[^a-zA-Zа-яА-ЯёЁ0-9_-]/g, '_');

            let dfExt = 'mp4';
            let dfName = 'MP4 Video';
            if (config.exportFormat === 'mov_prores') {
                dfExt = 'mov';
                dfName = 'MOV Video (ProRes with Alpha)';
            }
            const { filePath } = await dialog.showSaveDialog(mainWindow, {
                buttonLabel: 'Save Video',
                defaultPath: `${safeName}.${dfExt}`,
                filters: [{ name: dfName, extensions: [dfExt] }]
            });

            if (!filePath) return { success: false, reason: 'cancelled' };
            outputPath = filePath;
        }

        config.width = parseInt(config.width);
        config.height = parseInt(config.height);
        config.fps = parseInt(config.fps);
        config.charsPerSecond = parseFloat(config.charsPerSecond);
        config.fontSizeOverride = config.fontSizeOverride ? parseInt(config.fontSizeOverride) : null;

        const { loadFonts } = require('../renderer');
        loadFonts(path.join(__dirname, '../../assets/fonts/Inter-Medium.ttf'));

        await renderVideo(text, config, outputPath);

        mainWindow.focus();
        return { success: true, outputPath };
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
        previewConfig.width = Math.min(previewConfig.width, 500); // cap size
        previewConfig.height = Math.min(previewConfig.height, 500);
        previewConfig.isPreview = true; // Tell ffmpeg to use webm, but keep original exportFormat for background clearing logic

        const tmpPath = path.join(app.getPath('temp'), `brat_preview_${Date.now()}.webm`);

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
            fontBase, config.fontWeight, blockWidth, config.textAlign
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

        ctx.fillStyle = config.textColor;

        flatChars.forEach(charObj => {
            if (charObj.char.trim().length > 0) {
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
            fontBase, config.fontWeight, blockWidth, config.textAlign
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

        ctx.fillStyle = config.textColor;

        flatChars.forEach(charObj => {
            if (charObj.char.trim().length > 0) {
                ctx.fillText(charObj.char, charObj.x, charObj.y);
            }
        });

        const { filePath } = await dialog.showSaveDialog(mainWindow, {
            buttonLabel: 'Save Screenshot',
            defaultPath: 'brat_screenshot.png',
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

function extractFontName(fontFamily) {
    return fontFamily || "Arial";
}
