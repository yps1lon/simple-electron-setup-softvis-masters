const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require("electron");
const { execFile } = require("child_process");
const path = require("path");
const { pathToFileURL } = require("url");

const ENGINE_ENTRY = pathToFileURL(path.join(__dirname, "..", "engine", "dist", "index.js")).href;

// The engine is a library (no CLI). It is ESM while this file is CommonJS,
// so it comes in through a dynamic import, cached after first use. It is
// the compiled output in src/engine/dist, so `npm run build` must run first.
let enginePromise = null;
function loadEngine() {
  if (enginePromise === null) enginePromise = import(ENGINE_ENTRY);
  return enginePromise;
}

// The whole main-side API. The renderer never touches the filesystem or
// spawns processes itself; it asks for these through the preload bridge.
ipcMain.handle("pick-folder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return result.canceled ? null : result.filePaths[0];
});

// Review the checked-out branch against a base branch, with `months` of
// history for the stability race. Git is only read. Decisions go into
// architecture.yaml in the repository.
ipcMain.handle("review", async (_event, repoPath, baseRef, months) => {
  const engine = await loadEngine();
  return engine.reviewChange({ repo: repoPath, base: baseRef, months });
});

ipcMain.handle("decide", async (_event, repoPath, decisionsFile, input) => {
  const engine = await loadEngine();
  return engine.recordDecision(repoPath, decisionsFile, input);
});

ipcMain.handle("undecide", async (_event, decisionsFile, from, to) => {
  const engine = await loadEngine();
  return engine.removeDecision(decisionsFile, from, to);
});

// The piece for a model goes to the clipboard, so it can be pasted into LM
// Studio or any chat without the app talking to a model itself.
ipcMain.handle("copy-text", async (_event, text) => {
  clipboard.writeText(String(text));
  return null;
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

// Opens a source file so a finding can be acted on, not just looked at. The
// editor CLI is preferred over the OS file association because Windows maps
// .ts to MPEG video and would open a media player.
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
  if (failure !== "") throw new Error(failure);
  return null;
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    webPreferences: {
      preload: path.join(__dirname, "./preload.js") // the bridge between main and renderer
    }
  });
  win.loadFile(path.join(__dirname, "../html/index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
