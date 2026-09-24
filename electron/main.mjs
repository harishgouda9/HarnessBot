import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { utilityProcess } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

/**
 * The desktop shell owns the things a Node child process cannot: the window, OS
 * credential storage, and — critically — the CUA host, so screen-recording and
 * accessibility grants attribute to HarnessBot rather than to a stray node binary.
 *
 * The harness runs as a utilityProcess child with ELECTRON_RUN_AS_NODE, not in the
 * renderer, so the renderer keeps having no transports of its own.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

/** 8799 first, then the documented fallbacks. A busy port must not brick startup. */
const PORT_CANDIDATES = [Number(process.env.HB_PORT) || 8799, 18799, 28799];

let mainWindow = null;
let harness = null;
let serverPort = PORT_CANDIDATES[0];

// -- single instance ---------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

// -- window state ------------------------------------------------------------

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return { width: 1280, height: 820 };
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(bounds));
  } catch {
    /* not worth failing a quit over */
  }
}

// -- harness lifecycle -------------------------------------------------------

function portFree(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.on('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(true));
    setTimeout(() => {
      socket.destroy();
      resolve(true);
    }, 400);
  });
}

/**
 * Something else may already be on 8799. Ask it who it is before assuming it is us:
 * attaching to a stranger's port would hand them the whole roster.
 */
async function isOurHarness(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    const json = await res.json();
    return json?.app === 'harnessbot';
  } catch {
    return false;
  }
}

async function pickPort() {
  for (const port of PORT_CANDIDATES) {
    if (await portFree(port)) return { port, reuse: false };
    if (await isOurHarness(port)) return { port, reuse: true };
  }
  return { port: PORT_CANDIDATES.at(-1), reuse: false };
}

function startHarness(port) {
  const entry = isDev
    ? path.join(dirname, '..', 'server', 'index.ts')
    : path.join(process.resourcesPath, 'server', 'index.js');

  const args = isDev ? ['--experimental-strip-types', entry] : [entry];

  harness = utilityProcess.fork(args[args.length - 1], [], {
    env: {
      ...process.env,
      HB_PORT: String(port),
      HB_WEBHOOK_PORT: String(port + 1),
      // The packaged harness serves the built renderer from the same origin.
      HB_STATIC_DIR: isDev ? '' : path.join(process.resourcesPath, 'ui'),
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: isDev ? '--experimental-strip-types' : '',
    },
    stdio: 'pipe',
  });

  const log = fs.createWriteStream(path.join(app.getPath('userData'), 'server.log'), { flags: 'a' });
  harness.stdout?.pipe(log);
  harness.stderr?.pipe(log);

  harness.on('exit', (code) => {
    if (code !== 0 && mainWindow && !app.isQuittingForReal) {
      dialog.showErrorBox('HarnessBot', `The local harness stopped (code ${code}). See server.log in the app data folder.`);
    }
  });
}

async function waitForHarness(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOurHarness(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// -- ipc ---------------------------------------------------------------------

ipcMain.handle('hb:setBadge', (_event, count) => {
  if (process.platform === 'darwin') app.dock?.setBadge(count > 0 ? String(count) : '');
  else mainWindow?.setOverlayIcon?.(null, count > 0 ? `${count} unread` : '');
});

// -- boot --------------------------------------------------------------------

async function createWindow() {
  const bounds = loadWindowState();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#070707',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on('close', saveWindowState);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // External links open in the real browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const url = isDev ? `http://127.0.0.1:${process.env.HB_UI_PORT || 5199}` : `http://127.0.0.1:${serverPort}`;
  await mainWindow.loadURL(url);
}

app.whenReady().then(async () => {
  const { port, reuse } = await pickPort();
  serverPort = port;
  if (!reuse) startHarness(port);
  const ready = await waitForHarness(port);
  if (!ready && !isDev) {
    dialog.showErrorBox('HarnessBot', 'The local harness did not start. See server.log in the app data folder.');
  }
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('before-quit', () => {
  app.isQuittingForReal = true;
  saveWindowState();
  // Kill the tree: a surviving harness keeps agent CLIs alive after the window closes.
  harness?.kill();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
