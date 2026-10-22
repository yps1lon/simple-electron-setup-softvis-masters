const { contextBridge, ipcRenderer } = require("electron");

// The entire renderer-facing API, kept deliberately small: the renderer
// never touches the filesystem or spawns processes, it asks main through
// this bridge. contextIsolation and nodeIntegration stay at their secure
// defaults (on and off), so window.drift is the only hole in the wall.
contextBridge.exposeInMainWorld("drift", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  pickSpec: () => ipcRenderer.invoke("pick-spec"),
  analyze: (repoPath, specPath) =>
    ipcRenderer.invoke("analyze", repoPath, specPath),
  propose: (repoPath) => ipcRenderer.invoke("propose", repoPath),
  openFile: (filePath) => ipcRenderer.invoke("open-file", filePath),
  exportMermaid: (result, view, order) =>
    ipcRenderer.invoke("export-mermaid", result, view, order)
});
