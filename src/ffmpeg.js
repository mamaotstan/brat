const { spawn } = require('child_process');
const path = require('path');

// Use bundled ffmpeg-static if available, otherwise fall back to system PATH
let ffmpegPath = 'ffmpeg';
try {
    ffmpegPath = require('ffmpeg-static');
    // In packaged Electron app, the path may be inside app.asar.unpacked
    if (ffmpegPath && ffmpegPath.includes('app.asar')) {
        ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
    }
} catch (e) {
    // ffmpeg-static not installed, use system ffmpeg
}

/**
 * Spawns an ffmpeg process to receive raw video frames via stdin.
 * @param {Object} config
 * @param {string} outputPath
 * @returns {import('child_process').ChildProcess}
 */
const spawnFfmpeg = (config, outputPath) => {
    const { width, height, fps } = config;

    const args = [
        '-y', // Overwrite output file
        '-f', 'rawvideo',
        '-pix_fmt', 'rgba', // Canvas exports rgba
        '-s', `${width}x${height}`,
        '-r', `${fps}`,
        '-i', '-', // Read from stdin
    ];

    // v2: mux the track (or a fragment of it) under the video
    const audio = (!config.isPreview && config.audio && config.audio.path) ? config.audio : null;
    if (audio) {
        if (audio.start > 0) args.push('-ss', String(audio.start));
        if (audio.duration > 0) args.push('-t', String(audio.duration));
        // No -shortest: the audio is cut to the clip length already, and -shortest can make
        // ffmpeg stop reading frames early (the renderer would then wait on a closed pipe).
        args.push('-i', audio.path, '-map', '0:v:0', '-map', '1:a:0');
        if (config.exportFormat === 'mov_prores') args.push('-c:a', 'pcm_s16le');
        else args.push('-c:a', 'aac', '-b:a', '192k');
    }

    if (config.exportFormat === 'mov_prores' && !config.isPreview) {
        // High quality ProRes 4444 with Alpha Channel
        args.push(
            '-c:v', 'prores_ks',
            '-profile:v', '4', // 4444
            '-pix_fmt', 'yuva444p10le', // Alpha channel
            '-qscale:v', '2',  // Enforce high quality
            '-vendor', 'apl0', // Apple vendor tag for compatibility
            // The following flags force proper color matrix and straight alpha interpretation
            '-color_primaries', 'bt709',
            '-color_trc', 'bt709',
            '-colorspace', 'bt709',
            '-vf', 'premultiply=inplace=1', // crucial for smooth edges in editors like Premiere/Capcut
            outputPath
        );
    } else if (config.exportFormat === 'webm_preview' || config.isPreview) {
        // Fast VP9 with Alpha Channel for UI Preview
        args.push(
            '-c:v', 'libvpx-vp9',
            '-pix_fmt', 'yuva420p',
            '-b:v', '2M',
            '-deadline', 'realtime', // optimize for speed
            '-vf', 'premultiply=inplace=1', // Ensure preview video matches the ProRes alpha behavior
            outputPath
        );
    } else {
        // Default MP4 (Green/Black/White BG) - NO TRANSPARENCY
        args.push(
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-crf', '16',
            '-preset', 'fast',
            outputPath
        );
    }

    const ffmpeg = spawn(ffmpegPath, args, { windowsHide: true });

    ffmpeg.stderr.on('data', (data) => {
        // Uncomment for detailed ffmpeg logs
        // console.error(`FFmpeg: ${data}`);
    });

    ffmpeg.on('close', (code) => {
        if (code !== 0) {
            console.error(`FFmpeg exited with code ${code}`);
        } else {
            console.log(`Saved video to ${outputPath}`);
        }
    });

    return ffmpeg;
};

module.exports = {
    spawnFfmpeg,
};
