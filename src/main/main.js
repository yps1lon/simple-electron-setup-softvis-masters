const { app, BrowserWindow } = require("electron");
const path = require("path");

// Create window
function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, "./preload.js") // Preload script for communication between main and renderer processes
    }
  });

  win.loadFile(path.join(__dirname, "../html/index.html")); // Load HTML file (which runs the renderer.js script)
}

// Create window when app is ready
app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit app when all windows are closed
app.on("window-all-closed", () => {
    app.quit();
});

