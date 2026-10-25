/** Only the local workbench receives this restricted native publication interface. */
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('corchPublication', Object.freeze({
  configure: input => ipcRenderer.invoke('corch:publisher:configure', input),
  status: () => ipcRenderer.invoke('corch:publisher:status'),
  publish: input => ipcRenderer.invoke('corch:publisher:publish', input),
  cancel: id => ipcRenderer.send('corch:publisher:cancel', id),
}))
