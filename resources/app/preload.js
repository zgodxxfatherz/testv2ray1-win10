'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  serversList: () => ipcRenderer.invoke('servers:list'),
  addText: (t) => ipcRenderer.invoke('servers:addText', t),
  addFile: () => ipcRenderer.invoke('servers:addFile'),
  addJson: (o) => ipcRenderer.invoke('servers:addJson', o),
  update: (id, patch) => ipcRenderer.invoke('servers:update', id, patch),
  remove: (id) => ipcRenderer.invoke('servers:remove', id),
  setActive: (id) => ipcRenderer.invoke('servers:setActive', id),
  clear: () => ipcRenderer.invoke('servers:clear'),

  geo: (h) => ipcRenderer.invoke('geo:lookup', h),
  geoAll: () => ipcRenderer.invoke('geo:lookupAll'),
  pingOne: (h, p) => ipcRenderer.invoke('ping:one', h, p),
  pingAll: () => ipcRenderer.invoke('ping:all'),
  subFetch: (u) => ipcRenderer.invoke('subscription:fetch', u),

  coreStart: () => ipcRenderer.invoke('core:start'),
  coreStop: () => ipcRenderer.invoke('core:stop'),
  coreStatus: () => ipcRenderer.invoke('core:status'),
  proxyEnable: () => ipcRenderer.invoke('proxy:enable'),
  proxyDisable: () => ipcRenderer.invoke('proxy:disable'),
  proxyStatus: () => ipcRenderer.invoke('proxy:status'),
  connect: (want, id) => ipcRenderer.invoke('connect:toggle', want, id),
  connectVerify: () => ipcRenderer.invoke('connect:verify'),
  open: (u) => ipcRenderer.invoke('shell:open', u),
});
