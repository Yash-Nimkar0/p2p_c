const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startNode: (options) => ipcRenderer.send('start-node', options),
  stopNode: () => ipcRenderer.send('stop-node'),
  onPythonLog: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('python-log', handler);
    return () => ipcRenderer.removeListener('python-log', handler);
  },
  onPythonStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('python-status', handler);
    return () => ipcRenderer.removeListener('python-status', handler);
  },
});
