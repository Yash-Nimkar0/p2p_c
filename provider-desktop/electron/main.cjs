const { app, BrowserWindow, Tray, Menu, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow;
let tray;
let pythonProcess;

const isDev = !app.isPackaged;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    titleBarStyle: 'hidden',
    show: false, // Wait until ready to show
  });

  const startUrl = isDev 
    ? 'http://localhost:5173' 
    : `file://${path.join(__dirname, '../dist/index.html')}`;

  mainWindow.loadURL(startUrl);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'public', 'favicon.svg'); // placeholder icon
  try {
    tray = new Tray(iconPath);
    
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Show Dashboard', click: () => mainWindow.show() },
      { type: 'separator' },
      { label: 'Quit', click: () => {
        app.isQuitting = true;
        app.quit();
      }}
    ]);
    
    tray.setToolTip('MeshGPU Provider Node');
    tray.setContextMenu(contextMenu);
  } catch (err) {
    console.warn("Failed to create tray icon:", err.message);
  }
}

function startPythonNode(mock = true) {
  if (pythonProcess) return;

  const scriptPath = path.join(__dirname, '..', '..', 'provider-node', 'main.py');
  
  const args = ['-u', scriptPath, '--headless'];
  if (mock) args.push('--mock');

  console.log(`Starting Python node: python3 ${args.join(' ')}`);

  // Assumes python3 is in PATH and venv is active or deps installed globally.
  // In a real desktop app build, we'd bundle the python runtime or use an executable.
  pythonProcess = spawn('python3', args, {
    cwd: path.dirname(scriptPath),
    env: { ...process.env, PYTHONUNBUFFERED: "1" }
  });

  pythonProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(l => l.trim() !== '');
    for (const text of lines) {
      console.log(`[Python] ${text}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('python-log', { level: 'INFO', text });
      }
    }
  });

  pythonProcess.stderr.on('data', (data) => {
    const lines = data.toString().split('\n').filter(l => l.trim() !== '');
    for (const text of lines) {
      console.error(`[Python ERR] ${text}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('python-log', { level: 'ERROR', text });
      }
    }
  });

  pythonProcess.on('close', (code) => {
    console.log(`Python process exited with code ${code}`);
    pythonProcess = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('python-status', 'stopped');
    }
  });
  
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('python-status', 'running');
  }
}

function stopPythonNode() {
  if (pythonProcess) {
    try {
      pythonProcess.kill('SIGKILL');
    } catch (e) {
      console.warn('Failed to kill python process:', e);
    }
    pythonProcess = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('python-status', 'stopped');
    }
  }
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  // IPC handlers
  ipcMain.on('start-node', (event, { mock }) => {
    startPythonNode(mock);
  });

  ipcMain.on('stop-node', () => {
    stopPythonNode();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopPythonNode();
});
