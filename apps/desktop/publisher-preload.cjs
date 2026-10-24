/** Only the local workbench receives this restricted native publication interface. */
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('corchPublication', Object.freeze({
  configure: input => ipcRenderer.invoke('corch:publisher:configure', input),
  status: () => ipcRenderer.invoke('corch:publisher:status'),
  publish: input => ipcRenderer.invoke('corch:publisher:publish', input),
  cancel: id => ipcRenderer.send('corch:publisher:cancel', id),
}))
contextBridge.exposeInMainWorld('corchJd', Object.freeze({
  open: input => ipcRenderer.invoke('corch:jd:open', input),
  status: input => ipcRenderer.invoke('corch:jd:status', input),
  read: input => ipcRenderer.invoke('corch:jd:read', input),
  collect: input => ipcRenderer.invoke('corch:jd:collect', input),
  platforms: () => ipcRenderer.invoke('corch:jd:platforms'),
  pending: () => ipcRenderer.invoke('corch:jd:pending'),
  ack: input => ipcRenderer.invoke('corch:jd:ack', input),
  onPending: listener => {
    if (typeof listener !== 'function') throw new TypeError('JD pending listener must be a function')
    const handler = () => listener()
    ipcRenderer.on('corch:jd:pending', handler)
    return () => ipcRenderer.removeListener('corch:jd:pending', handler)
  },
  verify: input => ipcRenderer.invoke('corch:jd:verify', input),
  resume: input => ipcRenderer.invoke('corch:jd:resume', input),
  close: input => ipcRenderer.invoke('corch:jd:close', input),
  pdf: input => ipcRenderer.invoke('corch:jd:pdf', input),
  html: input => ipcRenderer.invoke('corch:jd:html', input),
}))
