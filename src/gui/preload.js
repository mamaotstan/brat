const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getPreset: () => ipcRenderer.invoke('get-preset'),
    renderVideo: (data) => ipcRenderer.invoke('render-video', data),
    generatePreview: (data) => ipcRenderer.invoke('generate-preview', data),
    saveScreenshot: (data) => ipcRenderer.invoke('save-screenshot', data),
    buildLivePreview: (data) => ipcRenderer.invoke('build-live-preview', data),
    getVersion: () => ipcRenderer.invoke('get-version')
});
