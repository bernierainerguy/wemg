'use strict';

const $ = (id) => document.getElementById(id);

const el = {
  url: $('url'),
  paste: $('paste'),
  preview: $('preview'),
  thumb: $('thumb'),
  ptitle: $('ptitle'),
  pmeta: $('pmeta'),
  quality: $('quality'),
  qualityField: $('quality-field'),
  bitrate: $('bitrate'),
  bitrateField: $('bitrate-field'),
  playlist: $('playlist'),
  compatible: $('compatible'),
  compatNote: $('compat-note'),
  folder: $('folder'),
  browse: $('browse'),
  go: $('go'),
  stop: $('stop'),
  open: $('open'),
  fill: $('fill'),
  status: $('status'),
  rate: $('rate'),
  log: $('log'),
  gate: $('gate'),
  gateRegister: $('gate-register'),
  gateBlocked: $('gate-blocked'),
  regName: $('reg-name'),
  regEmail: $('reg-email'),
  regAgree: $('reg-agree'),
  regSubmit: $('reg-submit'),
  regError: $('reg-error'),
  blockedMessage: $('blocked-message'),
  blockedRetry: $('blocked-retry')
};

let format = 'mp4';
let busy = false;
let lastFormats = null;
let wasSkipped = false;
let infoTimer = null;

// --- helpers ---------------------------------------------------------------

function bytes(n) {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function clock(seconds) {
  if (!seconds || seconds < 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.classList.toggle('error', isError);
}

function log(line) {
  el.log.textContent += `${line}\n`;
  el.log.scrollTop = el.log.scrollHeight;
}

function setProgress(percent) {
  if (percent === null) {
    el.fill.classList.add('indeterminate');
    return;
  }
  el.fill.classList.remove('indeterminate');
  el.fill.style.width = `${percent}%`;
}

function setBusy(state) {
  busy = state;
  el.go.disabled = state || !licensed;
  el.stop.classList.toggle('hidden', !state);
  el.go.textContent = state ? 'Downloading…' : 'Download';
}

// --- format switch ---------------------------------------------------------

// H.264 tops out at 1080p on most sites (YouTube included), so offering
// 1440p/2160p alongside the compatibility setting would silently hand back a
// 1080p file instead.
function syncQualityCeiling() {
  const capped = el.compatible.checked;

  for (const option of el.quality.options) {
    const tooTall = option.value !== 'best' && Number(option.value) > 1080;
    option.disabled = capped && tooTall;
  }

  if (capped && (el.quality.value === 'best' || Number(el.quality.value) > 1080)) {
    el.quality.value = '1080';
  }

  el.compatNote.textContent = capped
    ? 'H.264 is usually only available up to 1080p.'
    : 'Above 1080p sites serve VP9/AV1 — QuickTime may refuse it; VLC plays it.';
}

el.compatible.addEventListener('change', syncQualityCeiling);

document.querySelectorAll('.seg').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.seg').forEach((b) => {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
    format = btn.dataset.format;
    el.qualityField.classList.toggle('hidden', format !== 'mp4');
    el.bitrateField.classList.toggle('hidden', format !== 'mp3');
  });
});

// --- url preview -----------------------------------------------------------

async function loadInfo() {
  const url = el.url.value.trim();
  if (!/^https?:\/\//i.test(url)) {
    el.preview.classList.add('hidden');
    return;
  }

  try {
    const info = await window.api.info(url);
    el.thumb.src = info.thumbnail || '';
    el.ptitle.textContent = info.title;
    el.pmeta.textContent = [
      info.uploader,
      clock(info.duration),
      info.maxHeight ? `up to ${info.maxHeight}p` : ''
    ]
      .filter(Boolean)
      .join(' · ');
    el.preview.classList.remove('hidden');
  } catch {
    el.preview.classList.add('hidden');
  }
}

el.url.addEventListener('input', () => {
  clearTimeout(infoTimer);
  infoTimer = setTimeout(loadInfo, 600);
});

el.paste.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      el.url.value = text.trim();
      loadInfo();
    }
  } catch {
    setStatus('Could not read the clipboard.', true);
  }
});

// --- folder ----------------------------------------------------------------

el.browse.addEventListener('click', async () => {
  const dir = await window.api.chooseFolder();
  if (dir) el.folder.value = dir;
});

el.open.addEventListener('click', () => window.api.reveal(el.folder.value));

// --- download --------------------------------------------------------------

el.go.addEventListener('click', async () => {
  const url = el.url.value.trim();
  if (!/^https?:\/\//i.test(url)) {
    setStatus('Paste a video link first.', true);
    return;
  }

  setBusy(true);
  el.fill.classList.remove('done');
  setProgress(null);
  el.rate.textContent = '';
  el.log.textContent = '';
  lastFormats = null;
  wasSkipped = false;
  setStatus('Starting…');

  try {
    const res = await window.api.download({
      url,
      format,
      quality: el.quality.value,
      audioBitrate: Number(el.bitrate.value),
      outputDir: el.folder.value,
      playlist: el.playlist.checked,
      compatible: el.compatible.checked
    });

    setProgress(100);
    el.fill.classList.add('done');
    el.rate.textContent = lastFormats ? `format ${lastFormats}` : '';

    if (wasSkipped) {
      // Never let a skipped download read as a fresh one: the file on disk may
      // predate a settings change and have entirely different codecs.
      setStatus('Already in that folder — kept the existing file, nothing downloaded.');
    } else {
      setStatus(res.file ? `Saved ${res.file.split('/').pop()}` : 'Done.');
    }
  } catch (err) {
    const msg = String(err.message || err).replace(/^Error invoking remote method '.*?': /, '');
    setProgress(0);
    setStatus(/cancel/i.test(msg) ? 'Cancelled.' : msg, !/cancel/i.test(msg));
  } finally {
    setBusy(false);
  }
});

el.stop.addEventListener('click', async () => {
  setStatus('Cancelling…');
  await window.api.cancel();
});

// --- main-process events ---------------------------------------------------

window.api.onProgress((p) => {
  setProgress(p.percent);
  setStatus(
    p.percent === null
      ? 'Working…'
      : `${p.percent.toFixed(1)}% · ${bytes(p.downloaded)} of ${bytes(p.total)}`
  );
  el.rate.textContent = [
    p.speed ? `${bytes(p.speed)}/s` : '',
    p.eta ? `${clock(p.eta)} left` : ''
  ]
    .filter(Boolean)
    .join(' · ');
});

window.api.onLog((line) => {
  log(line);
  if (/^\[(Merger|ExtractAudio|VideoConvertor)\]/.test(line)) {
    setProgress(null);
    setStatus(format === 'mp3' ? 'Converting audio…' : 'Merging video and audio…');
  }
});

window.api.onFormats((f) => {
  lastFormats = f;
  log(`[app] yt-dlp chose format ${f}`);
});

window.api.onSkipped((file) => {
  wasSkipped = true;
  log(`[app] file already exists, download skipped: ${file}`);
});

window.api.onSetupProgress((pct) => {
  if (!busy) setStatus(`Setting up yt-dlp… ${pct}%`);
});

// --- licence gate -----------------------------------------------------------

let licensed = false;

function showGate(which) {
  el.gate.classList.remove('hidden');
  el.gateRegister.classList.toggle('hidden', which !== 'register');
  el.gateBlocked.classList.toggle('hidden', which !== 'blocked');
  el.go.disabled = true;
}

function hideGate() {
  el.gate.classList.add('hidden');
  el.go.disabled = busy;
}

function blockedText(verdict) {
  if (verdict.reason === 'denied') {
    const why = verdict.state && verdict.state.deniedReason;
    return `This copy has been deactivated.${why ? ` ${why}` : ''} Contact Whiteley Events if you think this is wrong.`;
  }
  if (verdict.reason === 'grace-expired') {
    return 'This copy has not been able to check in for 30 days, so it has stopped working. Connect to the internet and try again.';
  }
  return 'This copy is not currently active.';
}

function applyVerdict(verdict) {
  licensed = Boolean(verdict && verdict.allowed);

  if (licensed) {
    hideGate();
    if (verdict.warning) setStatus(verdict.warning, true);
    return;
  }

  showGate(verdict && verdict.reason === 'unregistered' ? 'register' : 'blocked');
  if (verdict && verdict.reason !== 'unregistered') {
    el.blockedMessage.textContent = blockedText(verdict);
  }
}

function validRegistration() {
  const name = el.regName.value.trim();
  const email = el.regEmail.value.trim();
  // Deliberately loose: the server does the authoritative validation.
  return name.length > 1 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && el.regAgree.checked;
}

function syncRegisterButton() {
  el.regSubmit.disabled = !validRegistration();
}

for (const node of [el.regName, el.regEmail, el.regAgree]) {
  node.addEventListener('input', syncRegisterButton);
  node.addEventListener('change', syncRegisterButton);
}

el.regSubmit.addEventListener('click', async () => {
  el.regSubmit.disabled = true;
  el.regSubmit.textContent = 'Registering…';
  el.regError.classList.add('hidden');

  try {
    const res = await window.api.licenceRegister({
      name: el.regName.value.trim(),
      email: el.regEmail.value.trim()
    });

    if (res.verdict && res.verdict.allowed) {
      applyVerdict(res.verdict);
      setStatus(res.offline ? 'Registered. Could not reach the licence server yet.' : 'Registered.');
    } else if (res.status === 'denied') {
      el.regError.textContent =
        (res.state && res.state.deniedReason) || 'The licence server rejected these details.';
      el.regError.classList.remove('hidden');
    } else {
      applyVerdict(res.verdict);
    }
  } catch (err) {
    el.regError.textContent = String(err.message || err);
    el.regError.classList.remove('hidden');
  } finally {
    el.regSubmit.textContent = 'Register and continue';
    syncRegisterButton();
  }
});

el.blockedRetry.addEventListener('click', async () => {
  el.blockedRetry.disabled = true;
  el.blockedRetry.textContent = 'Checking…';
  try {
    const res = await window.api.licenceCheckin();
    applyVerdict(res.verdict);
  } catch {
    // Leave the blocked sheet up; the message already explains the situation.
  } finally {
    el.blockedRetry.disabled = false;
    el.blockedRetry.textContent = 'Try again';
  }
});

document.querySelectorAll('[data-legal]').forEach((btn) => {
  btn.addEventListener('click', () => window.api.openLegal(btn.dataset.legal));
});

window.api.onLicenceUpdated(applyVerdict);

// --- boot ------------------------------------------------------------------

(async () => {
  const paths = await window.api.paths();
  el.folder.value = paths.outputDir;

  syncQualityCeiling();

  try {
    applyVerdict(await window.api.licenceState());
  } catch (err) {
    // Fail closed: no verdict means no downloading.
    applyVerdict({ allowed: false, reason: 'denied', state: { deniedReason: String(err.message || err) } });
  }

  try {
    setStatus('Checking downloader…');
    await window.api.ensureYtDlp(false);
    setStatus('Ready.');
  } catch (err) {
    setStatus(`yt-dlp setup failed: ${err.message}`, true);
  }
})();
