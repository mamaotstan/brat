const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getPreset: () => ipcRenderer.invoke('get-preset'),
    renderVideo: (data) => ipcRenderer.invoke('render-video', data),
    generatePreview: (data) => ipcRenderer.invoke('generate-preview', data),
    saveScreenshot: (data) => ipcRenderer.invoke('save-screenshot', data),
    buildLivePreview: (data) => ipcRenderer.invoke('build-live-preview', data),
    getVersion: () => ipcRenderer.invoke('get-version'),
    getSystemFonts: () => ipcRenderer.invoke('get-system-fonts'),
    pickScreenColor: () => ipcRenderer.invoke('pick-screen-color'),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
    startDrag: (fileName) => ipcRenderer.send('start-drag', fileName),
    renderTimelineVideo: (data) => ipcRenderer.invoke('render-timeline-video', data),
    openTimeline: (data) => ipcRenderer.invoke('open-timeline', data),
    getTimelineData: () => ipcRenderer.invoke('get-timeline-data'),
    saveTimelineData: (data) => ipcRenderer.invoke('save-timeline-data', data),
    closeTimeline: () => ipcRenderer.invoke('close-timeline'),

    // v2: track + lyrics
    openSync: (config) => ipcRenderer.invoke('open-sync', config),
    pushMainConfig: (config) => ipcRenderer.send('main-config', config),
    getMainConfig: () => ipcRenderer.invoke('get-main-config'),
    onMainConfig: (cb) => ipcRenderer.on('main-config', (e, config) => cb(config)),
    syncPickAudio: () => ipcRenderer.invoke('sync-pick-audio'),
    syncAudioInfo: (filePath) => ipcRenderer.invoke('sync-audio-info', filePath),
    syncWaveform: (filePath) => ipcRenderer.invoke('sync-waveform', filePath),
    syncAlign: (job) => ipcRenderer.invoke('sync-align', job),
    syncCancel: () => ipcRenderer.invoke('sync-cancel'),
    syncRender: (data) => ipcRenderer.invoke('sync-render', data),
    syncSaveProject: (project) => ipcRenderer.invoke('sync-save-project', project),
    syncLoadProject: () => ipcRenderer.invoke('sync-load-project'),
    onSyncProgress: (cb) => ipcRenderer.on('sync-progress', (e, p) => cb(p)),
    onSyncRenderProgress: (cb) => ipcRenderer.on('sync-render-progress', (e, v) => cb(v))
});
