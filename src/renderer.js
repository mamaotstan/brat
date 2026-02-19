const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const fs = require('fs-extra');
const path = require('path');
const { calculateLayout, getFlatCharacterPositions } = require('./layout');
const { spawnFfmpeg } = require('./ffmpeg');
const { easeOutCubic } = require('./utils');

const loadFonts = (fontPath) => {
    // Register bundled Inter font (if it exists)
    if (fontPath && fs.existsSync(fontPath)) {
        GlobalFonts.registerFromPath(fontPath, 'Inter');
    }

    // Try to register Arial Narrow from multiple sources
    const arialNarrowPaths = [
        // Bundled in project (dev mode)
        path.join(__dirname, '..', 'assets', 'fonts', 'ArialNarrow.ttf'),
        path.join(__dirname, '..', 'assets', 'fonts', 'arial-narrow.ttf'),
        path.join(__dirname, '..', 'assets', 'fonts', 'ARIALN.TTF'),
        // Packaged app extraResources
        ...(process.resourcesPath ? [
            path.join(process.resourcesPath, 'fonts', 'ARIALN.TTF'),
            path.join(process.resourcesPath, 'fonts', 'ArialNarrow.ttf'),
        ] : []),
        // Windows system fonts (fallback)
        'C:\\Windows\\Fonts\\ARIALN.TTF',
        'C:\\Windows\\Fonts\\arialn.ttf',
    ];
    let narrowRegistered = false;
    for (const anPath of arialNarrowPaths) {
        if (fs.existsSync(anPath)) {
            GlobalFonts.registerFromPath(anPath, 'Arial Narrow');
            console.log('Registered Arial Narrow from:', anPath);
            narrowRegistered = true;
            break;
        }
    }
    if (!narrowRegistered) {
        console.warn('WARNING: Arial Narrow font not found! Place ARIALN.TTF in assets/fonts/');
        console.warn('Falling back to Arial (will look wider than the reference)');
    }

    // Log available font families for debugging
    const families = GlobalFonts.families;
    console.log('Available font families:', families.map(f => f.family).join(', '));

    return 'Inter';
};



const renderSegmentToStream = async (ctx, canvas, text, config, stream) => {
    const { width, height, fps, backgroundColor, textColor, fontWeight, lineHeight, charsPerSecond = 10, revealFrames = 3, revealOffsetPx = 18, textAlign = 'left' } = config;
    const fontBase = config.fontBase || config.fontFamily || 'Arial';

    const totalChars = text.length;
    const typeDuration = totalChars / charsPerSecond;
    const totalDuration = typeDuration + (config.endHold || 1.5);
    const totalFrames = Math.ceil(totalDuration * fps);

    let lastVisibleCount = -1;
    let cachedLayout = null;
    let cachedFlatChars = [];

    // Effects State
    const { createCanvas } = require('@napi-rs/canvas'); // Ensure we can make temp canvas
    const historyCanvas = createCanvas(width, height);
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
            const currentText = text.substring(0, visibleCount);
            cachedLayout = calculateLayout(ctx, currentText, config);
            const { fontSize, lines, blockWidth, blockHeight } = cachedLayout;
            const originX = (width - blockWidth) / 2;
            const originY = (height - blockHeight) / 2;
            cachedFlatChars = getFlatCharacterPositions(ctx, lines, originX, originY, fontSize, lineHeight, fontBase, fontWeight, blockWidth, textAlign);
            lastVisibleCount = visibleCount;
        }

        // Draw Background
        if (config.exportFormat !== 'mov_prores' && config.exportFormat !== 'webm_preview') {
            ctx.fillStyle = config.backgroundColor || 'rgb(0,255,0)';
            ctx.fillRect(0, 0, width, height);
        } else {
            ctx.clearRect(0, 0, width, height);
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

        const drawTextLayer = (color, offsetX, offsetY, isMainText = false) => {
            ctx.fillStyle = color;

            // Reusable render code for a single character at a specific interpolation time
            const renderChar = (charObj, sampleProgress, opacityMult = 1) => {
                let opacity = 1;
                let xOffset = 0;

                // Animate newest character sliding in
                if (charObj.index === cachedFlatChars.length - 1 && visibleCount < totalChars) {
                    const startTime = (visibleCount - 1) / charsPerSecond;
                    const startFrame = startTime * fps;

                    // We calculate progress relative to the sub-sample time offset
                    // sampleProgress is between -0.5 (half frame ago) and 0 (now)
                    const frameWithSubstep = f + sampleProgress;
                    const progress = (frameWithSubstep - startFrame) / revealFrames;

                    if (progress < 1 && progress > 0) {
                        const eased = easeOutCubic(progress);
                        opacity = eased;
                        // Slide in from right purely based on reveal offset
                        xOffset = revealOffsetPx * (1 - eased);
                    } else if (progress <= 0) {
                        opacity = 0;
                    }
                }

                if (opacity > 0.01 && charObj.char.trim().length > 0) {
                    ctx.globalAlpha = opacity * opacityMult;
                    ctx.fillText(charObj.char, charObj.x + xOffset + offsetX, charObj.y + offsetY);
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
            ctx.globalAlpha = 1.0;
        };

        // Optional Drop Shadow
        if (config.dropShadow && config.dropShadow > 0) {
            ctx.shadowColor = config.textColor === '#ffffff' ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.8)';
            ctx.shadowBlur = config.dropShadow;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
        }

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

        ctx.restore();
        ctx.filter = 'none';
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;

        // Save current frame to history buffer
        if (config.motionBlur > 0) {
            historyCtx.clearRect(0, 0, width, height);
            historyCtx.drawImage(canvas, 0, 0);
        }

        const buffer = ctx.getImageData(0, 0, width, height).data;
        const drained = stream.write(buffer);
        if (!drained) {
            await new Promise(r => stream.once('drain', r));
        }
    }
};

const renderVideo = async (text, config, outputPath) => {
    const { width, height } = config;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const ffmpegProcess = spawnFfmpeg(config, outputPath);

    try {
        await renderSegmentToStream(ctx, canvas, text, config, ffmpegProcess.stdin);
        ffmpegProcess.stdin.end();
    } catch (err) {
        ffmpegProcess.kill();
        throw err;
    }

    return new Promise((resolve, reject) => {
        ffmpegProcess.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg error ${code}`));
        });
    });
};

module.exports = { renderVideo, renderSegmentToStream, loadFonts };
