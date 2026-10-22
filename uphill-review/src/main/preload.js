const { contextBridge, ipcRenderer } = require("electron");

// The entire renderer-facing API, kept small: the renderer never touches the
// filesystem or spawns processes, it asks main through this bridge.
// contextIsolation and nodeIntegration stay at their secure defaults (on and
// off), so window.uphill is the only hole in the wall.
contextBridge.exposeInMainWorld("uphill", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  review: (repoPath, baseRef, months) => ipcRenderer.invoke("review", repoPath, baseRef, months),
  decide: (repoPath, decisionsFile, input) => ipcRenderer.invoke("decide", repoPath, decisionsFile, input),
  undecide: (decisionsFile, from, to) => ipcRenderer.invoke("undecide", decisionsFile, from, to),
  copyText: (text) => ipcRenderer.invoke("copy-text", text),
  openFile: (filePath) => ipcRenderer.invoke("open-file", filePath)
});
