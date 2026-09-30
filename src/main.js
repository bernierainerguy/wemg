'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { ensureYtDlp, ffmpegPath } = require('./binaries');
const licence = require('./licence');

let mainWindow = null;
let downloadProc = null;
let cancelled = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 720,
    minWidth: 620,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#14161a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Open external links in the default browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

const LEGAL_DOCS = {
  eula: { file: 'WEMG-EULA.md', title: 'End User Licence Agreement' },
  privacy: { file: 'WEMG-Privacy-Notice.md', title: 'Privacy Notice' },
  licences: { file: 'WEMG-Third-Party-Licences.md', title: 'Third-Party Licences' }
};

function legalPath(file) {
  // legal/ sits beside src/ — inside the asar once packaged, on disk in
  // development. __dirname resolves correctly in both cases.
  return path.join(__dirname, '..', 'legal', file);
}

function readLegal(key) {
  const doc = LEGAL_DOCS[key];
  if (!doc) return null;

  const candidates = [
    legalPath(doc.file),
    path.join(__dirname, '..', 'legal', doc.file),
    path.join(process.resourcesPath || '', 'app.asar', 'legal', doc.file)
  ];

  for (const candidate of candidates) {
    try {
      return { ...doc, text: fs.readFileSync(candidate, 'utf-8') };
    } catch {
      // Try the next location.
    }
  }
  return { ...doc, text: `Could not find ${doc.file}.` };
}

function openLegal(key) {
  const doc = readLegal(key);
  if (!doc) return;

  const escaped = doc.text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // A data URL keeps this a plain document window: no preload, no scripts,
  // nothing for the page to reach back into.
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${doc.title}</title>
<style>
  body { margin:0; padding:28px 34px; background:#14161a; color:#e8eaed;
         font:13px/1.65 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
  pre  { white-space:pre-wrap; word-wrap:break-word; margin:0; font:inherit; }
</style></head><body><pre>${escaped}</pre></body></html>`;

  const win = new BrowserWindow({
    width: 720,
    height: 760,
    title: doc.title,
    backgroundColor: '#14161a',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function defaultOutputDir() {
  const downloads = app.getPath('downloads');
  const dir = path.join(downloads, 'Media Grab');
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return downloads;
  }
}

// `track` marks the long-running download, which is the only process Cancel
// should ever kill. Metadata lookups run alongside it and must not become the
// cancel target.
function runYtDlp(binary, args, onLine, { track = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, { windowsHide: true });
    if (track) downloadProc = proc;

    let stderr = '';
    let buffer = '';

    const handle = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) if (line.trim()) onLine(line.trim());
    };

    proc.stdout.on('data', handle);
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      handle(chunk);
    });

    proc.on('error', (err) => {
      if (track) downloadProc = null;
      reject(err);
    });

    proc.on('close', (code) => {
      if (track) downloadProc = null;
      if (buffer.trim()) onLine(buffer.trim());
      if (code === 0) return resolve();
      if (cancelled) return reject(new Error('Cancelled'));
      reject(new Error(stderr.trim().split('\n').slice(-3).join('\n') || `yt-dlp exited with code ${code}`));
    });
  });
}

// --- IPC -------------------------------------------------------------------

ipcMain.handle('app:paths', () => ({
  outputDir: defaultOutputDir(),
  ffmpeg: ffmpegPath()
}));

ipcMain.handle('app:ensure-ytdlp', async (_evt, force = false) => {
  const bin = await ensureYtDlp((pct) => send('ytdlp:setup-progress', pct), force);
  return bin;
});

ipcMain.handle('dialog:choose-folder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Save here'
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('shell:reveal', (_evt, target) => {
  if (!target) return;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    shell.openPath(target);
  } else {
    shell.showItemInFolder(target);
  }
});

ipcMain.handle('media:info', async (_evt, url) => {
  const bin = await ensureYtDlp((pct) => send('ytdlp:setup-progress', pct));
  let json = '';
  await runYtDlp(bin, ['-J', '--no-warnings', '--no-playlist', url], (line) => {
    if (line.startsWith('{')) json = line;
  });
  if (!json) throw new Error('Could not read video info.');
  const info = JSON.parse(json);
  return {
    title: info.title,
    uploader: info.uploader || info.channel,
    duration: info.duration,
    thumbnail: info.thumbnail,
    maxHeight: Math.max(0, ...(info.formats || []).map((f) => f.height || 0))
  };
});

ipcMain.handle('media:download', async (_evt, opts) => {
  const { url, format, quality, audioBitrate, outputDir, playlist, compatible } = opts;

  // Enforce here rather than trusting the renderer to hide its own button.
  const verdict = licence.evaluate();
  if (!verdict.allowed) {
    throw new Error(
      verdict.reason === 'denied'
        ? `This copy has been deactivated.${verdict.state.deniedReason ? ` ${verdict.state.deniedReason}` : ''}`
        : verdict.reason === 'grace-expired'
          ? 'This copy has not checked in for 30 days. Connect to the internet and reopen the app.'
          : 'Please register before downloading.'
    );
  }

  cancelled = false;

  const bin = await ensureYtDlp((pct) => send('ytdlp:setup-progress', pct));
  const ffmpeg = ffmpegPath();

  const args = [
    '--newline',
    '--no-warnings',
    '--ignore-config',
    '--progress',
    '--progress-template',
    'PROG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
    '-o',
    path.join(outputDir, '%(title).180B [%(id)s].%(ext)s'),
    '--no-mtime',
    '--restrict-filenames'
  ];

  if (ffmpeg) args.push('--ffmpeg-location', ffmpeg);
  args.push(playlist ? '--yes-playlist' : '--no-playlist');

  if (format === 'mp3') {
    args.push(
      '-f',
      'bestaudio/best',
      '-x',
      '--audio-format',
      'mp3',
      '--audio-quality',
      String(audioBitrate || 192) + 'K',
      '--embed-thumbnail',
      '--add-metadata'
    );
  } else {
    const cap = quality && quality !== 'best' ? `[height<=${quality}]` : '';

    // QuickTime (and most Apple software) only decodes H.264 video with AAC
    // audio inside an mp4. YouTube also serves VP9 and AV1 with Opus, which
    // mux into an .mp4 container perfectly happily and then refuse to play.
    // So constrain the codecs, not just the container.
    const selector = compatible
      ? [
          `bv*[vcodec^=avc1]${cap}+ba[acodec^=mp4a]`,
          `bv*[vcodec^=avc1]${cap}+ba`,
          `b[vcodec^=avc1]${cap}`,
          `b[ext=mp4]${cap}`,
          `b${cap}`
        ].join('/')
      : [
          `bv*${cap}+ba[ext=m4a]`,
          `bv*${cap}+ba`,
          `b${cap}[ext=mp4]`,
          `b${cap}`,
          'b'
        ].join('/');

    args.push('-f', selector, '--merge-output-format', 'mp4', '--add-metadata');
  }

  args.push(url);

  let lastFile = null;

  await runYtDlp(bin, args, (line) => {
    if (line.startsWith('PROG|')) {
      const [, downloaded, total, estimate, speed, eta] = line.split('|');
      const totalBytes = Number(total) || Number(estimate) || 0;
      const doneBytes = Number(downloaded) || 0;
      send('download:progress', {
        percent: totalBytes ? Math.min(100, (doneBytes / totalBytes) * 100) : null,
        speed: Number(speed) || 0,
        eta: Number(eta) || 0,
        downloaded: doneBytes,
        total: totalBytes
      });
      return;
    }

    // yt-dlp announces its pick as "[info] Downloading 1 format(s): 137+140".
    // Worth surfacing: it is the only way to tell H.264 from VP9 after the fact.
    const chosen = line.match(/^\[info\] .*?Downloading \d+ format\(s\):\s*(.+)$/);
    if (chosen) send('download:formats', chosen[1].trim());

    // yt-dlp silently skips a download when the target file already exists,
    // which looks identical to success and hands back the previous file.
    const skipped = line.match(/^\[download\]\s+(.+?)\s+has already been downloaded$/);
    if (skipped) send('download:skipped', skipped[1]);

    const dest =
      line.match(/^\[(?:Merger|ExtractAudio)\].*?(?:to|Destination:)\s+"?(.+?)"?$/) ||
      line.match(/^\[download\] Destination:\s+(.+)$/) ||
      skipped;
    if (dest) lastFile = dest[1];

    send('download:log', line);
  }, { track: true });

  return { file: lastFile, outputDir };
});

ipcMain.handle('legal:open', (_evt, key) => openLegal(key));

ipcMain.handle('licence:state', () => licence.evaluate());

ipcMain.handle('licence:register', async (_evt, identity) => {
  licence.setIdentity(identity || {});
  const result = await licence.checkin();
  return { ...result, verdict: licence.evaluate() };
});

ipcMain.handle('licence:checkin', async () => {
  const result = await licence.checkin();
  return { ...result, verdict: licence.evaluate() };
});

ipcMain.handle('media:cancel', () => {
  cancelled = true;
  if (downloadProc) {
    downloadProc.kill('SIGTERM');
    return true;
  }
  return false;
});

// --- lifecycle -------------------------------------------------------------

app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [
          { label: 'End User Licence Agreement', click: () => openLegal('eula') },
          { label: 'Privacy Notice', click: () => openLegal('privacy') },
          { label: 'Third-Party Licences', click: () => openLegal('licences') },
          { type: 'separator' },
          {
            label: 'Update yt-dlp',
            click: async () => {
              try {
                await ensureYtDlp((pct) => send('ytdlp:setup-progress', pct), true);
                send('download:log', '[app] yt-dlp updated.');
              } catch (err) {
                send('download:log', `[app] yt-dlp update failed: ${err.message}`);
              }
            }
          }
        ]
      }
    ])
  );
  createWindow();

  // Check in shortly after launch: refreshes the 30-day grace and picks up a
  // deactivation. Failure is non-fatal — evaluate() falls back to the cache.
  setTimeout(() => {
    const state = licence.getState();
    if (state.name && state.email) {
      licence
        .checkin()
        .then(() => send('licence:updated', licence.evaluate()))
        .catch(() => {});
    }
  }, 4000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (downloadProc) downloadProc.kill('SIGTERM');
  if (process.platform !== 'darwin') app.quit();
});
