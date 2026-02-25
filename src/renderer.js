const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const fs = require('fs-extra');
const path = require('path');
const { calculateLayout, getFlatCharacterPositions, extractTextAndColors } = require('./layout');
const { spawnFfmpeg } = require('./ffmpeg');
const { easeOutCubic } = require('./utils');

let fontsLoaded = false;

const loadFonts = (fontPath) => {
    if (fontsLoaded) return 'Inter';
    // Helper to safely load font from ASAR or disk using Buffer
    const safeRegisterFont = (filePath, familyName) => {
        try {
            if (fs.existsSync(filePath)) {
                // We read the file into a Node.js buffer first. 
                // fs.readFileSync CAN read from inside .asar.
                // The native @napi-rs C++ code cannot read .asar paths directly.
                const fontBuffer = fs.readFileSync(filePath);
                GlobalFonts.register(fontBuffer, familyName);
                return true;
            }
        } catch (e) {
            console.error(`Error loading font ${familyName} from ${filePath}`, e);
        }
        return false;
    };

    // Register bundled Inter font (if it exists)
    if (fontPath) {
        safeRegisterFont(fontPath, 'Inter');
    }

    // Try to register Arial Narrow from multiple sources
    const arialNarrowPaths = [
        // Bundled in project (dev mode)
        path.join(__dirname, '..', 'assets', 'fonts', 'ArialNarrow.ttf'),
        path.join(__dirname, '..', 'assets', 'fonts', 'arial-narrow.ttf'),
        path.join(__dirname, '..', 'assets', 'fonts', 'ARIALN.TTF'),
        // Packaged app extraResources (physically unpacked just in case)
        ...(process.resourcesPath ? [
            path.join(process.resourcesPath, 'fonts', 'ARIALN.TTF'),
            path.join(process.resourcesPath, 'fonts', 'ArialNarrow.ttf'),
            path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'fonts', 'ARIALN.TTF')
        ] : []),
        // Windows system fonts (fallback)
        'C:\\Windows\\Fonts\\ARIALN.TTF',
        'C:\\Windows\\Fonts\\arialn.ttf',
    ];

    let narrowRegistered = false;
    for (const anPath of arialNarrowPaths) {
        if (safeRegisterFont(anPath, 'Arial Narrow')) {
            console.log('Registered Arial Narrow from:', anPath);
            narrowRegistered = true;
            break;
        }
    }

    if (!narrowRegistered) {
        console.warn('WARNING: Arial Narrow font not found! Place ARIALN.TTF in assets/fonts/');
        console.warn('Falling back to Arial (will look wider than the reference)');
    }

    // Try to register Impact from bundled assets or system fonts
    const impactPaths = [
        // Bundled in project (dev mode)
        path.join(__dirname, '..', 'assets', 'fonts', 'impact.ttf'),
        path.join(__dirname, '..', 'assets', 'fonts', 'Impact.ttf'),
        path.join(__dirname, '..', 'assets', 'fonts', 'IMPACT.TTF'),
        // Packaged app extraResources
        ...(process.resourcesPath ? [
            path.join(process.resourcesPath, 'fonts', 'impact.ttf'),
            path.join(process.resourcesPath, 'fonts', 'Impact.ttf'),
            path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'fonts', 'impact.ttf')
        ] : []),
        // Windows system fonts (fallback)
        'C:\\Windows\\Fonts\\impact.ttf',
        'C:\\Windows\\Fonts\\Impact.ttf',
    ];

    let impactRegistered = false;
    for (const ipPath of impactPaths) {
        if (safeRegisterFont(ipPath, 'Impact')) {
            console.log('Registered Impact from:', ipPath);
            impactRegistered = true;
            break;
        }
    }

    if (!impactRegistered) {
        console.warn('WARNING: Impact font not found! Place impact.ttf in assets/fonts/');
    }

    // Try to register Gabriola from bundled assets or system fonts (elegant calligraphic font with Cyrillic)
    const gabriolaPaths = [
        path.join(__dirname, '..', 'assets', 'fonts', 'Gabriola.ttf'),
        ...(process.resourcesPath ? [
            path.join(process.resourcesPath, 'fonts', 'Gabriola.ttf'),
            path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'fonts', 'Gabriola.ttf')
        ] : []),
        'C:\\Windows\\Fonts\\Gabriola.ttf',
    ];

    for (const gpPath of gabriolaPaths) {
        if (safeRegisterFont(gpPath, 'Gabriola')) {
            console.log('Registered Gabriola from:', gpPath);
            break;
        }
    }

    // Try to register Monotype Corsiva from bundled assets or system/user fonts
    const corsivaPaths = [
        path.join(__dirname, '..', 'assets', 'fonts', 'Monotype-Corsiva-Regular.ttf'),
        ...(process.resourcesPath ? [
            path.join(process.resourcesPath, 'fonts', 'Monotype-Corsiva-Regular.ttf'),
            path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'fonts', 'Monotype-Corsiva-Regular.ttf')
        ] : []),
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts', 'Monotype-Corsiva-Regular.ttf'),
        'C:\\Windows\\Fonts\\MTCORSVA.TTF',
    ];

    for (const cpPath of corsivaPaths) {
        if (safeRegisterFont(cpPath, 'Monotype Corsiva')) {
            console.log('Registered Monotype Corsiva from:', cpPath);
            break;
        }
    }

    // Load standard system fonts so the user can use Arial, Times New Roman, Comic Sans etc.
    try {
        console.log('Loading system fonts...');
        GlobalFonts.loadSystemFonts();
    } catch (e) {
        console.error('Failed to load system fonts:', e);
    }

    fontsLoaded = true;
    return 'Inter';
};

// Reset font cache (if needed externally)
const resetFontCache = () => { fontsLoaded = false; };

/**
 * If outputPath already exists, appends _1, _2, etc. until a free name is found.
 */
const getUniqueOutputPath = (outputPath) => {
    if (!fs.existsSync(outputPath)) return outputPath;
    const dir = path.dirname(outputPath);
    const ext = path.extname(outputPath);
    const base = path.basename(outputPath, ext);
    let counter = 1;
    let candidate;
    do {
        candidate = path.join(dir, `${base}_${counter}${ext}`);
        counter++;
    } while (fs.existsSync(candidate));
    return candidate;
};

const renderSegmentToStream = async (ctx, canvas, rawText, config, stream, marginX = 0, marginY = 0) => {
    const { cleanText, colorMap } = extractTextAndColors(rawText);
    const text = cleanText;

    const { width, height, fps, backgroundColor, textColor, fontWeight, lineHeight, charsPerSecond = 10, revealFrames = 3, revealOffsetPx = 18, textAlign = 'left' } = config;
    const fontBase = config.fontBase || config.fontFamily || 'Arial';

    const fullWidth = width + marginX * 2;
    const fullHeight = height + marginY * 2;

    console.log(`[Renderer] Segment starting. Style: ${config.animationStyle}, Cursor: ${config.showCursor}, text: ${text.substring(0, 5)}...`);

    const totalChars = text.length;
    const typeDuration = totalChars / charsPerSecond;
    const totalDuration = typeDuration + (config.endHold || 1.5);
    const totalFrames = Math.ceil(totalDuration * fps);

    let lastVisibleCount = -1;
    let cachedLayout = null;
    let cachedFlatChars = [];

    // Effects State
    const { createCanvas } = require('@napi-rs/canvas'); // Ensure we can make temp canvas
    const historyCanvas = createCanvas(fullWidth, fullHeight);
    const historyCtx = historyCanvas.getContext('2d');
    let shakeTrauma = 0;

    for (let f = 0; f < totalFrames; f++) {
        // Yield to event loop every 10 frames to prevent UI freeze
        if (f % 10 === 0) {
            await new Promise(r => setImmediate(r));
        }

        // Add a small offset so the first frame isn't 100% blank if fps/speed allow
        let time = f / fps;

        let visibleCount = Math.min(totalChars, Math.floor(time * charsPerSecond));
        // Calculate partial progress to next character for smoother tracking
        const fractionalVisible = time * charsPerSecond;

        // Update Shake
        shakeTrauma *= 0.9; // Decay
        if (visibleCount !== lastVisibleCount) {
            if (visibleCount > 0 && config.jitter > 0) {
                shakeTrauma = config.jitter;
            }
        }

        let shakeX = 0;
        let shakeY = 0;
        if (shakeTrauma > 0.5) {
            shakeX = (Math.random() - 0.5) * shakeTrauma * 2;
            shakeY = (Math.random() - 0.5) * shakeTrauma * 2;
        }

        // Recalculate layout when visible count changes (dynamic resize like textFit)
        if (visibleCount !== lastVisibleCount) {
            const style = config.animationStyle || 'default';
            let layoutText = text;
            if (style === 'default') {
                layoutText = text.substring(0, visibleCount);
            }
            // We pass clean text to calculateLayout to avoid double parsing which was leading to tag leakage.
            // But layout.js calculateLayout expects raw text to parse colors, let's bypass it via direct logic 
            // since we already have clean text and color map. Or we can just rebuild the layout from cleanText.
            // Wait, calculateLayout expects raw text if we just call it.
            // Let's modify the call to calculateLayout to handle pre-parsed cleanText to avoid re-parsing partial tags.
            cachedLayout = calculateLayout(ctx, layoutText, config, colorMap);
            const { fontSize, lines, blockWidth, blockHeight } = cachedLayout;
            const originX = (width - blockWidth) / 2;
            const originY = (height - blockHeight) / 2;
            // Pass colorMap from the fully parsed string to map correctly
            cachedFlatChars = getFlatCharacterPositions(ctx, lines, originX, originY, fontSize, lineHeight, fontBase, fontWeight, blockWidth, textAlign, colorMap);
            lastVisibleCount = visibleCount;
        }

        // Draw Background
        if (config.exportFormat !== 'mov_prores' && config.exportFormat !== 'webm_preview') {
            ctx.fillStyle = config.backgroundColor || 'rgb(0,255,0)';
            ctx.fillRect(-marginX, -marginY, fullWidth, fullHeight);
        } else {
            ctx.clearRect(-marginX, -marginY, fullWidth, fullHeight);
        }

        // Sub-sample motion blur for smooth character movement and typing
        const motionSamples = (config.motionBlur && config.motionBlur > 0) ? Math.max(2, Math.floor(config.motionBlur * 40)) : 1;
        const motionWeight = 1.0 / motionSamples;

        // Motion Blur: Draw history (previous frames) with opacity
        if (config.motionBlur > 0 && f > 0) {
            ctx.globalAlpha = config.motionBlur;
            ctx.drawImage(historyCanvas, 0, 0);
            ctx.globalAlpha = 1.0;
        }

        ctx.save();
        ctx.translate(shakeX, shakeY);

        ctx.textBaseline = 'top';
        ctx.font = `${fontWeight} ${cachedLayout ? cachedLayout.fontSize : 10}px "${fontBase}"`;

        // Apply static blur
        let currentBlur = config.blur || 0;

        if (currentBlur > 0) {
            ctx.filter = `blur(${currentBlur}px)`;
        } else {
            ctx.filter = 'none';
        }

        const drawTextLayer = (baseColor, offsetX, offsetY, isMainText = false) => {
            // Reusable render code for a single character at a specific interpolation time
            const renderChar = (charObj, sampleProgress, opacityMult = 1) => {
                let opacity = 1;
                let xOffset = 0;
                let charToDraw = charObj.char;

                const startTime = (charObj.index) / charsPerSecond;
                const startFrame = startTime * fps;
                const frameWithSubstep = f + sampleProgress;
                const progress = (frameWithSubstep - startFrame) / revealFrames;

                const style = config.animationStyle || 'default';

                if (style === 'default') {
                    // Hide chars not yet visible in default due to text scaling mask
                    if (charObj.index >= visibleCount) {
                        opacity = 0;
                    } else if (charObj.index === visibleCount - 1 && visibleCount < totalChars) {
                        if (progress < 1 && progress > 0) {
                            const eased = easeOutCubic(progress);
                            opacity = eased;
                            // Slide in from right purely based on reveal offset
                            xOffset = revealOffsetPx * (1 - eased);
                        } else if (progress <= 0) {
                            opacity = 0;
                        }
                    }
                } else if (style === 'typewriter') {
                    if (progress <= 0) opacity = 0;
                } else if (style === 'glitch') {
                    if (progress <= -1) {
                        opacity = 0;
                    } else if (progress > -1 && progress <= 1.5) {
                        let cSet = '!@#$%^&*<>/?010101XY';
                        if (config.glitchCharset === 'letters') cSet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
                        else if (config.glitchCharset === 'numbers') cSet = '0123456789';
                        else if (config.glitchCharset === 'mixed') cSet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*<>/?';

                        const speed = config.glitchSpeed || 0.5;
                        const phase = Math.floor(f * speed + charObj.index * 13.37);
                        const r1 = Math.sin(phase) * 10000;
                        const seed1 = r1 - Math.floor(r1);
                        const r2 = Math.cos(phase) * 10000;
                        const seed2 = r2 - Math.floor(r2);

                        charToDraw = cSet[Math.floor(seed1 * cSet.length)];
                        opacity = 1;
                        xOffset = (seed2 - 0.5) * 6;
                    }
                }

                if (opacity > 0.01 && charToDraw.trim().length > 0) {
                    ctx.globalAlpha = opacity * opacityMult;

                    if (isMainText) {
                        ctx.fillStyle = charObj.color || baseColor;
                        if (config.dropShadow && config.dropShadow > 0) {
                            ctx.shadowColor = (charObj.color || baseColor) === '#ffffff' ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.8)';
                            ctx.shadowBlur = parseFloat(config.dropShadow);
                            ctx.shadowOffsetX = 0;
                            ctx.shadowOffsetY = 0;
                        } else {
                            ctx.shadowBlur = 0;
                            ctx.shadowColor = 'transparent';
                        }
                    } else {
                        ctx.fillStyle = baseColor; // e.g. red or blue for chroma
                        ctx.shadowBlur = 0;
                        ctx.shadowColor = 'transparent';
                    }
                    ctx.fillText(charToDraw, charObj.x + xOffset + offsetX, charObj.y + offsetY);
                }
            };

            // Multi-sampling for motion blur during active typing 
            // (When visibleCount changes or we are in the middle of a reveal)
            // motionSamples>1 smooths out the sliding and layout bouncing
            const isTypingActive = visibleCount < totalChars || (f - ((totalChars - 1) / charsPerSecond) * fps) < revealFrames;

            if (isMainText && motionSamples > 1 && isTypingActive) {
                for (let s = 0; s < motionSamples; s++) {
                    const sampleProgress = - (s / motionSamples);
                    for (let i = 0; i < cachedFlatChars.length; i++) {
                        // Only apply motion weight if the character is currently moving/appearing
                        // If it's already fully visible (progress >= 1 on previous frame), render it at full opacity once
                        const charObj = cachedFlatChars[i];
                        const startTime = (charObj.index) / charsPerSecond;
                        const startFrame = startTime * fps;

                        // Check if the character was already fully revealed a frame ago
                        const fullyRevealed = ((f - 1) - startFrame) / revealFrames >= 1;

                        if (fullyRevealed) {
                            // If fully stabilized, don't sub-sample its opacity, just draw it once at 1.0
                            if (s === 0) renderChar(charObj, 0, 1.0);
                        } else {
                            // Moving/appearing character gets sub-sampled motion blur
                            renderChar(charObj, sampleProgress, motionWeight);
                        }
                    }
                }
            } else {
                // Standard single pass (no typing active or motion blur disabled)
                for (let i = 0; i < cachedFlatChars.length; i++) {
                    renderChar(cachedFlatChars[i], 0, 1.0);
                }
            }

            // Draw Typewriter Cursor
            if (isMainText && config.showCursor && cachedLayout) {
                // Blink rate: twice per second default, modified by cursorSpeed
                const cSpeed = config.cursorSpeed || 1.0;
                const blinkOn = Math.floor(f / (fps / (2 * cSpeed))) % 2 === 0;
                if (blinkOn) {
                    let cursorX = 0;
                    let cursorY = 0;
                    if (cachedFlatChars.length > 0 && visibleCount > 0) {
                        const style = config.animationStyle || 'default';
                        let targetIdx = Math.min(visibleCount - 1, cachedFlatChars.length - 1);
                        if (style === 'default') {
                            targetIdx = cachedFlatChars.length - 1;
                        }
                        const lastVisibleChar = cachedFlatChars[targetIdx];
                        cursorX = lastVisibleChar.x + ctx.measureText(lastVisibleChar.char).width;
                        cursorY = lastVisibleChar.y;
                    } else if (cachedLayout.lines.length > 0) {
                        // Start of first line
                        cursorX = (width - cachedLayout.blockWidth) / 2;
                        cursorY = (height - cachedLayout.blockHeight) / 2;
                    }

                    ctx.globalAlpha = 1.0;
                    ctx.fillStyle = baseColor;
                    ctx.shadowBlur = 0;
                    ctx.shadowColor = 'transparent';
                    const cStyle = config.cursorStyle || '|';
                    ctx.fillText(cStyle, cursorX + offsetX, cursorY + offsetY);
                }
            }


            ctx.globalAlpha = 1.0;
        };

        // Chromatic Aberration
        if (config.chroma > 0) {
            // Cyan/Red offset effect.
            // On green background, multiply looks terrible. 
            // Better to use source-over with lower opacity or screen on black bg
            if (config.exportFormat && config.exportFormat.includes('mp4_green')) {
                ctx.globalCompositeOperation = 'source-over'; // Multiply ruins green chromakey
            } else {
                ctx.globalCompositeOperation = 'screen';
            }

            drawTextLayer(`rgba(255, 0, 0, 0.5)`, -config.chroma, 0);
            drawTextLayer(`rgba(0, 0, 255, 0.5)`, config.chroma, 0);
            ctx.globalCompositeOperation = 'source-over';
        }

        // Main Text
        drawTextLayer(textColor, 0, 0, true);

        // Re-apply static blur AFTER shadow pass (draw blurred text on top)
        // This ensures shadow renders cleanly AND blur still applies
        ctx.shadowBlur = 0;
        ctx.shadowColor = 'transparent';

        ctx.restore();
        ctx.filter = 'none';
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;

        // Save current frame to history buffer
        if (config.motionBlur > 0) {
            historyCtx.clearRect(0, 0, fullWidth, fullHeight);
            ctx.resetTransform();
            historyCtx.drawImage(canvas, 0, 0);
            ctx.translate(marginX, marginY);
        }

        ctx.resetTransform();
        const buffer = ctx.getImageData(0, 0, fullWidth, fullHeight).data;
        ctx.translate(marginX, marginY);
        const drained = stream.write(buffer);
        if (!drained) {
            await new Promise(r => stream.once('drain', r));
        }
    }
};

const renderVideo = async (text, config, outputPath) => {
    let { width, height } = config;

    // Apply Safe Zone Expansion (only for actual exports, keeps text exact size in UI preview)
    let marginX = 0;
    let marginY = 0;
    const padding = config.paddingRatio || 0;
    if (padding > 0 && !config.isPreview) {
        marginX = Math.round(width * padding);
        marginY = Math.round(height * padding);
        width += marginX * 2;
        height += marginY * 2;
    }

    // Pass the expanded dimensions to FFmpeg config
    const exportConfig = { ...config, width: Math.round(width), height: Math.round(height) };

    const canvas = createCanvas(exportConfig.width, exportConfig.height);
    const ctx = canvas.getContext('2d');

    // Translate the context to the center so all old layout/render math works untouched
    if (marginX > 0 || marginY > 0) {
        ctx.translate(marginX, marginY);
    }

    // Auto-increment filename if file already exists to avoid overwrite corruption
    outputPath = getUniqueOutputPath(outputPath);

    const ffmpegProcess = spawnFfmpeg(exportConfig, outputPath);

    try {
        await renderSegmentToStream(ctx, canvas, text, config, ffmpegProcess.stdin, marginX, marginY);
        ffmpegProcess.stdin.end();
    } catch (err) {
        ffmpegProcess.kill();
        throw err;
    }

    return new Promise((resolve, reject) => {
        ffmpegProcess.on('close', (code) => {
            if (code === 0) resolve(outputPath);
            else reject(new Error(`FFmpeg error ${code}`));
        });
    });
};

const renderTimelineToStream = async (ctx, canvas, timelineData, config, stream, marginX = 0, marginY = 0) => {
    const { width, height, fps, backgroundColor, textColor, fontWeight, lineHeight, revealFrames = 3, revealOffsetPx = 18, textAlign = 'left', totalDuration } = config;
    const fontBase = config.fontBase || config.fontFamily || 'Arial';

    const fullWidth = width + marginX * 2;
    const fullHeight = height + marginY * 2;

    const totalFrames = Math.ceil(totalDuration * fps);

    // Sort timeline data by start time to ensure correct order
    timelineData.sort((a, b) => a.startTime - b.startTime);

    let activeBlockIndex = -1;
    let cachedLayout = null;
    let cachedFlatChars = [];
    let lastVisibleCount = -1;

    const { createCanvas } = require('@napi-rs/canvas');
    const historyCanvas = createCanvas(fullWidth, fullHeight);
    const historyCtx = historyCanvas.getContext('2d');
    let shakeTrauma = 0;

    for (let f = 0; f < totalFrames; f++) {
        if (f % 10 === 0) {
            await new Promise(r => setImmediate(r));
        }

        const time = f / fps;

        // Find the active block for the current frame
        let currentBlockIndex = -1;
        for (let i = 0; i < timelineData.length; i++) {
            const block = timelineData[i];
            if (time >= block.startTime && time <= (block.startTime + block.duration)) {
                currentBlockIndex = i;
                break;
            }
        }

        const isNewBlock = currentBlockIndex !== -1 && currentBlockIndex !== activeBlockIndex;
        activeBlockIndex = currentBlockIndex;

        // Draw Background
        if (config.exportFormat !== 'mov_prores' && config.exportFormat !== 'webm_preview') {
            ctx.fillStyle = config.backgroundColor || 'rgb(0,255,0)';
            ctx.fillRect(-marginX, -marginY, fullWidth, fullHeight);
        } else {
            ctx.clearRect(-marginX, -marginY, fullWidth, fullHeight);
        }

        if (activeBlockIndex !== -1) {
            const block = timelineData[activeBlockIndex];
            const rawText = block.text;
            const { cleanText, colorMap } = extractTextAndColors(rawText);
            const text = cleanText;
            const totalChars = text.length;

            // In timeline mode, the duration of the block dictates the speed of the text.
            // If the block is 2 seconds long and text is 10 chars, speed is 5 chars/sec.
            // We want the text to finish revealing at exactly block.duration
            const blockCharsPerSecond = totalChars / block.duration;

            // Local time within the block
            const localTime = time - block.startTime;

            let visibleCount = Math.min(totalChars, Math.floor(localTime * blockCharsPerSecond));

            // Update Shake
            shakeTrauma *= 0.9;
            if (visibleCount !== lastVisibleCount || isNewBlock) {
                if (visibleCount > 0 && config.jitter > 0) {
                    shakeTrauma = config.jitter;
                }
            }

            let shakeX = 0;
            let shakeY = 0;
            if (shakeTrauma > 0.5) {
                shakeX = (Math.random() - 0.5) * shakeTrauma * 2;
                shakeY = (Math.random() - 0.5) * shakeTrauma * 2;
            }

            // Recalculate layout
            if (visibleCount !== lastVisibleCount || isNewBlock) {
                const style = config.animationStyle || 'default';
                let layoutText = text;
                if (style === 'default') {
                    layoutText = text.substring(0, visibleCount);
                }
                cachedLayout = calculateLayout(ctx, layoutText, config, colorMap);
                const { fontSize, lines, blockWidth, blockHeight } = cachedLayout;
                const originX = (width - blockWidth) / 2;
                const originY = (height - blockHeight) / 2;
                cachedFlatChars = getFlatCharacterPositions(ctx, lines, originX, originY, fontSize, lineHeight, fontBase, fontWeight, blockWidth, textAlign, colorMap);
                lastVisibleCount = visibleCount;
            }

            // Motion Blur logic
            const motionSamples = (config.motionBlur && config.motionBlur > 0) ? Math.max(2, Math.floor(config.motionBlur * 40)) : 1;
            const motionWeight = 1.0 / motionSamples;

            if (config.motionBlur > 0 && f > 0) {
                ctx.globalAlpha = config.motionBlur;
                ctx.drawImage(historyCanvas, 0, 0);
                ctx.globalAlpha = 1.0;
            }

            ctx.save();
            ctx.translate(shakeX, shakeY);
            ctx.textBaseline = 'top';
            ctx.font = `${fontWeight} ${cachedLayout ? cachedLayout.fontSize : 10}px "${fontBase}"`;

            let currentBlur = config.blur || 0;
            if (currentBlur > 0) {
                ctx.filter = `blur(${currentBlur}px)`;
            } else {
                ctx.filter = 'none';
            }

            const drawTextLayer = (baseColor, offsetX, offsetY, isMainText = false) => {
                const renderChar = (charObj, sampleProgress, opacityMult = 1) => {
                    let opacity = 1;
                    let xOffset = 0;

                    let charToDraw = charObj.char;

                    const startTime = (charObj.index) / blockCharsPerSecond;
                    const startFrame = startTime * fps + (block.startTime * fps); // Global frame start
                    const frameWithSubstep = f + sampleProgress;
                    const progress = (frameWithSubstep - startFrame) / revealFrames;

                    const style = config.animationStyle || 'default';

                    if (style === 'default') {
                        if (charObj.index >= visibleCount) {
                            opacity = 0;
                        } else if (charObj.index === visibleCount - 1 && visibleCount < totalChars) {
                            if (progress < 1 && progress > 0) {
                                const eased = easeOutCubic(progress);
                                opacity = eased;
                                xOffset = revealOffsetPx * (1 - eased);
                            } else if (progress <= 0) {
                                opacity = 0;
                            }
                        }
                    } else if (style === 'typewriter') {
                        if (progress <= 0) opacity = 0;
                    } else if (style === 'glitch') {
                        if (progress <= -1) {
                            opacity = 0;
                        } else if (progress > -1 && progress <= 1.5) {
                            let cSet = '!@#$%^&*<>/?010101XY';
                            if (config.glitchCharset === 'letters') cSet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
                            else if (config.glitchCharset === 'numbers') cSet = '0123456789';
                            else if (config.glitchCharset === 'mixed') cSet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*<>/?';

                            const speed = config.glitchSpeed || 0.5;
                            const phase = Math.floor(f * speed + charObj.index * 13.37);
                            const r1 = Math.sin(phase) * 10000;
                            const seed1 = r1 - Math.floor(r1);
                            const r2 = Math.cos(phase) * 10000;
                            const seed2 = r2 - Math.floor(r2);

                            charToDraw = cSet[Math.floor(seed1 * cSet.length)];
                            opacity = 1;
                            xOffset = (seed2 - 0.5) * 6;
                        }
                    }

                    if (opacity > 0.01 && charObj.char.trim().length > 0) {
                        ctx.globalAlpha = opacity * opacityMult;
                        if (isMainText) {
                            ctx.fillStyle = charObj.color || baseColor;
                            if (config.dropShadow && config.dropShadow > 0) {
                                ctx.shadowColor = (charObj.color || baseColor) === '#ffffff' ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.8)';
                            }
                        } else {
                            ctx.fillStyle = baseColor;
                        }
                        ctx.fillText(charToDraw, charObj.x + xOffset + offsetX, charObj.y + offsetY);
                    }
                };

                // Motion blur sub-sampling simplification
                const isTypingActive = visibleCount < totalChars || (f - (((totalChars - 1) / blockCharsPerSecond) + block.startTime) * fps) < revealFrames;

                if (isMainText && motionSamples > 1 && isTypingActive) {
                    for (let s = 0; s < motionSamples; s++) {
                        const sampleProgress = - (s / motionSamples);
                        for (let i = 0; i < cachedFlatChars.length; i++) {
                            const charObj = cachedFlatChars[i];
                            const startTime = (charObj.index) / blockCharsPerSecond;
                            const startFrame = startTime * fps + (block.startTime * fps);
                            const fullyRevealed = ((f - 1) - startFrame) / revealFrames >= 1;

                            if (fullyRevealed) {
                                if (s === 0) renderChar(charObj, 0, 1.0);
                            } else {
                                renderChar(charObj, sampleProgress, motionWeight);
                            }
                        }
                    }
                } else {
                    for (let i = 0; i < cachedFlatChars.length; i++) {
                        renderChar(cachedFlatChars[i], 0, 1.0);
                    }
                }

                // Draw Typewriter Cursor for timeline block
                if (isMainText && config.showCursor && cachedLayout) {
                    const blockPhaseFps = f - (block.startTime * fps);
                    if (blockPhaseFps >= 0) {
                        const cSpeed = config.cursorSpeed || 1.0;
                        const blinkOn = Math.floor(f / (fps / (2 * cSpeed))) % 2 === 0;
                        if (blinkOn) {
                            let cursorX = 0;
                            let cursorY = 0;
                            if (cachedFlatChars.length > 0 && visibleCount > 0) {
                                const style = config.animationStyle || 'default';
                                let targetIdx = Math.min(visibleCount - 1, cachedFlatChars.length - 1);
                                if (style === 'default') {
                                    targetIdx = cachedFlatChars.length - 1;
                                }
                                const lastVisibleChar = cachedFlatChars[targetIdx];
                                cursorX = lastVisibleChar.x + ctx.measureText(lastVisibleChar.char).width;
                                cursorY = lastVisibleChar.y;
                            } else if (cachedLayout.lines.length > 0) {
                                cursorX = (width - cachedLayout.blockWidth) / 2;
                                cursorY = (height - cachedLayout.blockHeight) / 2;
                            }
                            ctx.globalAlpha = 1.0;
                            ctx.fillStyle = baseColor;
                            const cStyle = config.cursorStyle || '|';
                            ctx.fillText(cStyle, cursorX + offsetX, cursorY + offsetY);
                        }
                    }
                }

                ctx.globalAlpha = 1.0;
            };

            // Drop Shadow setup (shadow color updated per-char in drawTextLayer if enabled)
            if (config.dropShadow && config.dropShadow > 0) {
                ctx.shadowColor = config.textColor === '#ffffff' ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.8)';
                ctx.shadowBlur = config.dropShadow;
                ctx.shadowOffsetX = 0;
                ctx.shadowOffsetY = 0;
            }

            // Chromatic Aberration
            if (config.chroma > 0) {
                if (config.exportFormat && config.exportFormat.includes('mp4_green')) {
                    ctx.globalCompositeOperation = 'source-over';
                } else {
                    ctx.globalCompositeOperation = 'screen';
                }

                drawTextLayer(`rgba(255, 0, 0, 0.5)`, -config.chroma, 0);
                drawTextLayer(`rgba(0, 0, 255, 0.5)`, config.chroma, 0);
                ctx.globalCompositeOperation = 'source-over';
            }

            drawTextLayer(textColor, 0, 0, true);
            ctx.restore();
            ctx.filter = 'none';
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;

        } else {
            // In-between blocks: still apply motion blur decay if needed
            if (config.motionBlur > 0 && f > 0) {
                ctx.globalAlpha = config.motionBlur;
                // historyCanvas doesn't need to be offset negatively here because we drew the translated canvas INTO it at 0,0
                ctx.resetTransform();
                ctx.drawImage(historyCanvas, 0, 0);
                // restore translation for next operations
                ctx.translate(marginX, marginY);
                ctx.globalAlpha = 1.0;
            }
        }

        // Save history buffer
        if (config.motionBlur > 0) {
            historyCtx.clearRect(0, 0, fullWidth, fullHeight);
            // reset transform on ctx temporarily to grab exactly what was drawn from 0,0 of the physical canvas
            ctx.resetTransform();
            historyCtx.drawImage(canvas, 0, 0);
            ctx.translate(marginX, marginY);
        }

        ctx.resetTransform();
        const buffer = ctx.getImageData(0, 0, fullWidth, fullHeight).data;
        ctx.translate(marginX, marginY);
        const drained = stream.write(buffer);
        if (!drained) {
            await new Promise(r => stream.once('drain', r));
        }
    }
};

const renderTimeline = async (timelineData, config, outputPath) => {
    let { width, height } = config;

    // Apply Safe Zone Expansion (only for actual exports)
    let marginX = 0;
    let marginY = 0;
    const padding = config.paddingRatio || 0;
    if (padding > 0 && !config.isPreview) {
        marginX = Math.round(width * padding);
        marginY = Math.round(height * padding);
        width += marginX * 2;
        height += marginY * 2;
    }

    const exportConfig = { ...config, width: Math.round(width), height: Math.round(height) };

    const canvas = createCanvas(exportConfig.width, exportConfig.height);
    const ctx = canvas.getContext('2d');

    // Translate the context
    if (marginX > 0 || marginY > 0) {
        ctx.translate(marginX, marginY);
    }

    // Auto-increment filename if file already exists to avoid overwrite corruption
    outputPath = getUniqueOutputPath(outputPath);

    const ffmpegProcess = spawnFfmpeg(exportConfig, outputPath);

    try {
        await renderTimelineToStream(ctx, canvas, timelineData, config, ffmpegProcess.stdin, marginX, marginY);
        ffmpegProcess.stdin.end();
    } catch (err) {
        ffmpegProcess.kill();
        throw err;
    }

    return new Promise((resolve, reject) => {
        ffmpegProcess.on('close', (code) => {
            if (code === 0) resolve(outputPath);
            else reject(new Error(`FFmpeg error ${code}`));
        });
    });
};

module.exports = { renderVideo, renderTimeline, renderSegmentToStream, loadFonts, resetFontCache };
