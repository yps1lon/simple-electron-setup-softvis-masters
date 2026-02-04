const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("appInfo", {
  message: "Hello from Electron preload"
});

