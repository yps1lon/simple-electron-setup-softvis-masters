const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { execFile } = require("child_process");
const { writeFile } = require("fs/promises");
const path = require("path");
const { pathToFileURL } = require("url");

const ENGINE_ENTRY = pathToFileURL(
  path.join(__dirname, "..", "engine", "dist", "index.js")
).href;

// The engine is consumed as a library — there is no CLI, by deliberate
// decision. It is ESM while this file is CommonJS, so it comes in through
// a dynamic import, cached after first use. It is the compiled output in
// src/engine/dist, so `npm run build` must run first.
let enginePromise = null;
function loadEngine() {
  if (enginePromise === null) {
    enginePromise = import(ENGINE_ENTRY);
  }
  return enginePromise;
}

// The whole main-side API. The renderer never touches the filesystem or
// spawns processes itself; it asks for these through the preload bridge.
ipcMain.handle("pick-folder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("pick-spec", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "Architecture spec", extensions: ["yaml", "yml"] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("analyze", async (_event, repoPath, specPath) => {
  const engine = await loadEngine();
  const graph = engine.parseRepository(repoPath);
  const spec = engine.loadSpec(specPath);
  return engine.compare(engine.assignModules(graph, spec), spec);
});

ipcMain.handle("propose", async (_event, repoPath) => {
  const engine = await loadEngine();
  return engine.proposeSpec(engine.parseRepository(repoPath));
});

// The renderer hands back the result it is showing (main keeps no state)
// plus, for the matrix, the row order it drew, so the file matches the
// screen. Returns the saved path, or null if the dialog was cancelled.
ipcMain.handle("export-mermaid", async (_event, result, view, order) => {
  const engine = await loadEngine();
  const text =
    view === "matrix"
      ? engine.toMermaidMatrix(result, order)
      : engine.toMermaidFlowchart(result);
  const picked = await dialog.showSaveDialog({
    defaultPath: `drift-${view}.mmd`,
    filters: [{ name: "Mermaid diagram", extensions: ["mmd"] }]
  });
  if (picked.canceled) {
    return null;
  }
  await writeFile(picked.filePath, text, "utf8");
  return picked.filePath;
});

// Launch an editor CLI (a .cmd shim on Windows, hence the shell and the
// quoting, same story as CVE-2024-27980). Resolves when the CLI exits,
// which for editors is a quick handoff to the running window.
function tryOpenWithCli(cli, filePath) {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    execFile(
      isWindows ? `${cli}.cmd` : cli,
      isWindows ? [`"${filePath}"`] : [filePath],
      { shell: isWindows },
      (error) => (error ? reject(error) : resolve(null))
    );
  });
}

// Opens a source file so a finding in the picture can be acted on, not just
// looked at. The editor CLI is preferred over the OS file association
// because Windows maps .ts to MPEG video and would open a media player.
ipcMain.handle("open-file", async (_event, filePath) => {
  const normalized = path.normalize(filePath);
  for (const cli of ["cursor", "code"]) {
    try {
      return await tryOpenWithCli(cli, normalized);
    } catch {
      // This CLI is not installed; try the next, then the OS fallback.
    }
  }
  const failure = await shell.openPath(normalized);
  if (failure !== "") {
    throw new Error(failure);
  }
  return null;
});

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

