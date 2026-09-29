/* ============================================================
   DOXAMI TICKETING — APPLICATION
   Version avec chargement robuste des bibliothèques.
   - Enveloppé dans un async IIFE qui attend window.__libsReady.
   - QR : qrcode-generator (remplace qrcode de soldair).
============================================================ */
(async function boot() {

/* ---------- Attente des bibliothèques ---------- */
if (window.__libsReady) {
  try { await window.__libsReady; } catch (e) { console.warn('Libs wait error', e); }
}

/* ---------- Vérification config & bibliothèques ---------- */
const cfg = window.APP_CONFIG || {};
const bad = (v) => !v || /VOTRE[-_]/i.test(v);
const fail = (title, html) => {
  document.body.innerHTML = `
    <div style="padding:40px;font-family:sans-serif;color:#fff;background:#07070f;min-height:100vh">
      <h1 style="color:#ef4444">⚠ ${title}</h1>
      <p style="margin-top:20px;line-height:1.7">${html}</p>
    </div>`;
  throw new Error(title);
};
if (bad(cfg.SUPABASE_URL) || bad(cfg.SUPABASE_ANON_KEY)) {
  fail('Configuration manquante',
    `Ouvrez <code style="background:#1e1e2e;padding:2px 8px;border-radius:4px">config.js</code> et renseignez
     votre <b>SUPABASE_URL</b> et votre <b>SUPABASE_ANON_KEY</b>.<br>
     Vous les trouverez dans <b>Supabase → Project Settings → API</b>.`);
}
const missing = [];
if (!window.supabase) missing.push('Supabase');
if (typeof window.qrcode !== 'function') missing.push('qrcode-generator');
if (!window.pdfjsLib) missing.push('PDF.js');
if (!window.jspdf) missing.push('jsPDF');
if (!window.jsQR) missing.push('jsQR');
if (missing.length) {
  fail('Bibliothèques non chargées',
    `Impossible de charger : <b>${missing.join(', ')}</b>.<br>
     Vérifiez votre connexion Internet, puis rechargez la page.<br>
     <small style="color:#8b94ab">Astuce : placez les fichiers .js à côté de index.html pour un fonctionnement hors-ligne.</small>`);
}

/* ---------- Client Supabase ---------- */
const { createClient } = window.supabase;
const sb = createClient(
  window.APP_CONFIG.SUPABASE_URL,
  window.APP_CONFIG.SUPABASE_ANON_KEY,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
);

pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';

/* ---------- Constantes ---------- */
const MODEL_MAX_SIDE = 3000;
const PDF_CHUNK      = 250;
const TICKETS_PAGE   = 100;
const CREATE_CHUNK   = 500;
const MAX_TICKETS    = 5000;
const SCAN_COOLDOWN  = 3500;

/* ============================================================
   ÉTAT GLOBAL
============================================================ */
const state = {
  user: null,
  profile: null,
  events: [],
  currentEvent: null,
  currentTickets: [],
  ticketsHasMore: false,
  currentScans: [],
  stats: { total: 0, used: 0 },
  filters: { q: '', status: 'all' },
  currentTab: 'stats',
  authMode: 'login'
};

const DEFAULT_ZONES = {
  qr:  { x: 40, y: 38, w: 20, h: 22 },
  num: { x: 40, y: 64, w: 20, h: 6 }
};

const wizardData = {
  step: 1,
  name: '',
  prefix: '',
  prefixTouched: false,
  modelFile: null,
  modelIsPDF: false,
  modelDataUrl: null,
  modelWidth: 0,
  modelHeight: 0,
  zones: JSON.parse(JSON.stringify(DEFAULT_ZONES)),
  count: 200,
  start: 1
};

let zoneDragState = null;
let scanning = false;
let generating = false;
let exporting = false;
let dashboardSeq = 0;
let ticketsReq = 0;

/* ============================================================
   HELPERS
============================================================ */
const $ = (id) => document.getElementById(id);

function showToast(msg, type = 'success') {
  const box = $('toast-container');
  while (box.children.length >= 4) box.firstChild.remove();
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  const icon = type === 'success' ? '✓' : type === 'info' ? 'ℹ' : '⚠';
  el.innerHTML = `<span class="dot">${icon}</span><span>${escapeHtml(msg)}</span>`;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 350);
  }, 3200);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('fr-FR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function pad(n, len = 4) { return String(n).padStart(len, '0'); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makePrefix(name) {
  const clean = String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
  const words = clean.split(/[^A-Z0-9]+/).filter(Boolean);
  let prefix = words.map(w => w[0]).join('');
  if (prefix.length < 2) prefix = (words.join('') + 'XXX').slice(0, 3);
  return prefix.slice(0, 4);
}

function isValidPrefix(p) { return /^[A-Z0-9]{2,6}$/.test(p); }

function animateCount(el, target, duration = 700) {
  const start = parseInt(el.textContent) || 0;
  const diff = target - start;
  if (!diff) { el.textContent = target; return; }
  const t0 = performance.now();
  function step(now) {
    const p = Math.min((now - t0) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(start + diff * eased);
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image illisible'));
    img.src = src;
  });
}

function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.85) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('Conversion impossible')), type, quality);
  });
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

function safeFileName(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'evenement';
}

function isPdfPath(p) { return /\.pdf$/i.test(p || ''); }

function setGenProgress(pct, sub) {
  $('gen-fill').style.width = pct + '%';
  if (sub !== undefined) $('gen-sub').textContent = sub;
}
function openGen(title) {
  $('gen-title').textContent = title || 'Traitement…';
  $('gen-sub').textContent = 'Veuillez patienter';
  setGenProgress(0);
  $('gen-overlay').classList.add('show');
}
function closeGen() { $('gen-overlay').classList.remove('show'); }

/* ---------- Retour sonore / vibration ---------- */
let audioCtx = null;
function beep(freq, dur = 0.12, when = 0) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime + when;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  } catch (_) { /* audio indisponible */ }
}
function feedback(type) {
  if (type === 'valid') {
    beep(880, 0.14);
    if (navigator.vibrate) navigator.vibrate(60);
  } else {
    beep(220, 0.16); beep(180, 0.2, 0.2);
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  }
}

/* ============================================================
   DÉMARRAGE — SESSION
============================================================ */
async function initSession() {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session) await onSignedIn(session.user);
    else showAuthScreen();
  } catch (err) {
    console.error(err);
    showAuthScreen();
  }

  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      resetSession();
      showAuthScreen();
    } else if (event === 'SIGNED_IN' && session?.user) {
      setTimeout(() => onSignedIn(session.user), 0);
    }
  });
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initSession);
} else {
  initSession();
}

function resetSession() {
  stopCamera();
  state.user = null;
  state.profile = null;
  state.events = [];
  state.currentEvent = null;
  state.currentTickets = [];
  state.currentScans = [];
}

async function fetchProfile(user) {
  for (let i = 0; i < 4; i++) {
    const { data } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (data) return data;
    await sleep(400);
  }
  const { data } = await sb.from('profiles').insert({
    id: user.id,
    email: user.email,
    full_name: user.user_metadata?.full_name || user.email.split('@')[0]
  }).select().maybeSingle();
  return data;
}

async function onSignedIn(user) {
  if (state.user && state.user.id === user.id) return;
  state.user = user;

  try {
    state.profile = await fetchProfile(user);
  } catch (err) {
    console.error(err);
    state.profile = null;
  }
  const displayName = state.profile?.full_name || user.user_metadata?.full_name || user.email;

  $('boot-screen').classList.add('hidden');
  $('auth-screen').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('header-username').textContent = displayName;
  $('header-avatar').textContent = (displayName || '?')[0].toUpperCase();

  await loadEvents();
  goDashboard();
}

function showAuthScreen() {
  $('boot-screen').classList.add('hidden');
  $('app').classList.add('hidden');
  $('auth-screen').classList.remove('hidden');
  $('auth-password').value = '';
}

/* ============================================================
   AUTH
============================================================ */
document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    state.authMode = tab.dataset.tab;
    const login = state.authMode === 'login';
    $('field-name').classList.toggle('hidden', login);
    $('auth-password').autocomplete = login ? 'current-password' : 'new-password';
    $('auth-submit').textContent = login ? 'Se connecter' : 'Créer mon compte';
    $('auth-message').textContent = '';
    $('auth-message').className = 'auth-note';
  });
});

function authError(text) {
  const msg = $('auth-message');
  msg.textContent = text;
  msg.className = 'auth-note error';
}

function translateAuthError(message) {
  const m = String(message || '');
  if (/Invalid login/i.test(m)) return 'E-mail ou mot de passe incorrect.';
  if (/already registered|already been registered/i.test(m)) return 'Cet e-mail est déjà utilisé.';
  if (/Email not confirmed/i.test(m)) return 'Confirmez d\'abord votre e-mail (lien reçu par courrier).';
  if (/rate limit|too many/i.test(m)) return 'Trop de tentatives. Réessayez dans quelques minutes.';
  if (/Password should be/i.test(m)) return 'Mot de passe trop faible (6 caractères minimum).';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Connexion impossible. Vérifiez votre réseau.';
  return m || 'Erreur inconnue.';
}

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('auth-email').value.trim().toLowerCase();
  const pass = $('auth-password').value;
  const name = $('auth-name').value.trim();
  const msg = $('auth-message');
  msg.className = 'auth-note';
  msg.textContent = '';

  if (!email || !pass) return authError('Remplissez tous les champs.');
  if (pass.length < 6) return authError('Mot de passe : 6 caractères minimum.');
  if (state.authMode === 'signup' && !name) return authError('Entrez votre nom complet.');

  const btn = $('auth-submit');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Patientez…';

  try {
    if (state.authMode === 'signup') {
      const { data, error } = await sb.auth.signUp({
        email,
        password: pass,
        options: { data: { full_name: name } }
      });
      if (error) throw error;

      if (!data.session) {
        msg.textContent = 'Un e-mail de confirmation vous a été envoyé. Vérifiez votre boîte, puis connectez-vous.';
        msg.className = 'auth-note success';
      }
    } else {
      const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
      if (error) throw error;
      await onSignedIn(data.user);
    }
  } catch (err) {
    console.error(err);
    authError(translateAuthError(err.message));
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

$('btn-logout').addEventListener('click', async () => {
  stopCamera();
  await sb.auth.signOut();
});

/* ============================================================
   ÉVÉNEMENTS — CHARGEMENT
============================================================ */
async function loadEvents() {
  const { data, error } = await sb.from('events')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    console.error(error);
    showToast('Erreur de chargement des événements', 'error');
    return;
  }
  state.events = data || [];
}

/* ============================================================
   NAVIGATION
============================================================ */
function goDashboard() {
  stopCamera();
  state.currentEvent = null;
  $('view-dashboard').classList.remove('hidden');
  $('view-wizard').classList.add('hidden');
  $('view-event').classList.add('hidden');
  renderDashboard();
}

async function openEvent(id) {
  openGen('Chargement…');
  try {
    const ev = state.events.find(e => e.id === id);
    if (!ev) throw new Error('Événement introuvable');
    state.currentEvent = ev;
    state.currentTab = 'stats';
    state.filters = { q: '', status: 'all' };
    $('tk-search').value = '';
    $('tk-status').value = 'all';

    await Promise.all([refreshStats(), loadTickets(true), loadScans()]);

    $('view-dashboard').classList.add('hidden');
    $('view-wizard').classList.add('hidden');
    $('view-event').classList.remove('hidden');
    renderEvent();
  } catch (err) {
    console.error(err);
    showToast('Erreur de chargement', 'error');
  } finally {
    closeGen();
  }
}

$('header-brand').addEventListener('click', goDashboard);
$('btn-back-dashboard').addEventListener('click', goDashboard);

/* ============================================================
   DASHBOARD
============================================================ */
async function renderDashboard() {
  const seq = ++dashboardSeq;
  const grid = $('events-grid');

  const statsByEvent = {};
  if (state.events.length > 0) {
    const { data, error } = await sb.rpc('get_events_stats');
    if (error) console.error(error);
    (data || []).forEach(r => {
      statsByEvent[r.event_id] = { total: Number(r.total), used: Number(r.used) };
    });
  }

  const thumbPath = (ev) => ev.thumb_path || (!isPdfPath(ev.model_path) ? ev.model_path : null);
  const paths = [...new Set(state.events.map(thumbPath).filter(Boolean))];
  const signedMap = {};
  if (paths.length > 0) {
    const { data: signedList } = await sb.storage.from('models').createSignedUrls(paths, 3600);
    (signedList || []).forEach(s => {
      if (s.path && s.signedUrl) signedMap[s.path] = s.signedUrl;
    });
  }

  if (seq !== dashboardSeq) return;

  grid.innerHTML = '';
  if (state.events.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Aucun événement pour le moment. Créez-en un pour commencer.';
    grid.appendChild(empty);
  }

  let delay = 0;
  state.events.forEach(ev => {
    const st = statsByEvent[ev.id] || { total: 0, used: 0 };
    const pct = st.total ? Math.round((st.used / st.total) * 100) : 0;
    const signed = signedMap[thumbPath(ev)];

    const card = document.createElement('div');
    card.className = 'event-card';
    card.style.animationDelay = (delay += 0.05) + 's';

    const topContent = signed
      ? `<img src="${escapeHtml(signed)}" alt="">`
      : `<div class="initials">${escapeHtml(ev.prefix || makePrefix(ev.name))}</div>`;

    card.innerHTML = `
      <div class="event-card-top">${topContent}</div>
      <div class="event-card-body">
        <h3>${escapeHtml(ev.name)}</h3>
        <div class="event-meta">🎫 ${st.total} billets • ${st.used} entrées</div>
        <div class="event-progress"><div class="event-progress-fill" style="width:${pct}%"></div></div>
        <div class="event-stats">
          <span><b>${st.used}</b> utilisés</span>
          <span><b>${st.total - st.used}</b> disponibles</span>
        </div>
      </div>
    `;
    const img = card.querySelector('img');
    if (img) img.addEventListener('error', () => {
      img.parentElement.innerHTML = `<div class="initials">${escapeHtml(ev.prefix || makePrefix(ev.name))}</div>`;
    });
    card.addEventListener('click', () => openEvent(ev.id));
    grid.appendChild(card);
  });

  const createCard = document.createElement('div');
  createCard.className = 'create-card';
  createCard.style.animationDelay = (delay += 0.05) + 's';
  createCard.innerHTML = `<div class="create-icon">+</div><p>Nouvel événement</p>`;
  createCard.addEventListener('click', startWizard);
  grid.appendChild(createCard);
}

/* ============================================================
   WIZARD
============================================================ */
function startWizard() {
  wizardData.step = 1;
  wizardData.name = '';
  wizardData.prefix = '';
  wizardData.prefixTouched = false;
  wizardData.modelFile = null;
  wizardData.modelIsPDF = false;
  wizardData.modelDataUrl = null;
  wizardData.modelWidth = 0;
  wizardData.modelHeight = 0;
  wizardData.zones = JSON.parse(JSON.stringify(DEFAULT_ZONES));
  wizardData.count = 200;
  wizardData.start = 1;

  $('wz-name').value = '';
  $('wz-prefix').value = '';
  $('wz-count').value = 200;
  $('wz-start').value = 1;
  $('model-info').classList.add('hidden');
  $('model-info').innerHTML = '';
  $('wz-next-2').disabled = true;
  $('wz-file').value = '';

  $('view-dashboard').classList.add('hidden');
  $('view-event').classList.add('hidden');
  $('view-wizard').classList.remove('hidden');
  wizardGo(1);
  updateNumPreview();
}

function wizardGo(step) {
  wizardData.step = step;
  document.querySelectorAll('.wizard-panel').forEach(p => {
    p.classList.toggle('hidden', parseInt(p.dataset.panel) !== step);
  });
  document.querySelectorAll('.wizard-step-indicator').forEach(ind => {
    const s = parseInt(ind.dataset.step);
    ind.classList.toggle('active', s === step);
    ind.classList.toggle('done', s < step);
  });
  if (step === 3) initZoneEditor();
  if (step === 4) updateNumPreview();
  if (step === 5) renderPreviewStep();
}

$('wiz-cancel').addEventListener('click', goDashboard);
$('wiz-back-2').addEventListener('click', () => wizardGo(1));
$('wiz-back-3').addEventListener('click', () => wizardGo(2));
$('wiz-back-4').addEventListener('click', () => wizardGo(3));
$('wiz-back-5').addEventListener('click', () => wizardGo(4));
$('wiz-next-3').addEventListener('click', () => wizardGo(4));
$('wz-next-2').addEventListener('click', () => wizardGo(3));
$('wiz-generate').addEventListener('click', generateTickets);

$('wz-name').addEventListener('input', () => {
  if (!wizardData.prefixTouched) $('wz-prefix').value = makePrefix($('wz-name').value);
});
$('wz-prefix').addEventListener('input', () => {
  wizardData.prefixTouched = true;
  const el = $('wz-prefix');
  el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
});

$('wiz-form-1').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('wz-name').value.trim();
  if (!name) return showToast('Entrez un nom', 'error');
  const prefix = ($('wz-prefix').value || makePrefix(name)).toUpperCase();
  if (!isValidPrefix(prefix)) return showToast('Préfixe : 2 à 6 lettres ou chiffres', 'error');
  wizardData.name = name;
  wizardData.prefix = prefix;
  $('wz-prefix').value = prefix;
  wizardGo(2);
});

$('wiz-form-4').addEventListener('submit', (e) => {
  e.preventDefault();
  let count = parseInt($('wz-count').value) || 0;
  const start = Math.max(parseInt($('wz-start').value) || 1, 1);
  if (count < 1) return showToast('Nombre invalide', 'error');
  if (count > MAX_TICKETS) {
    count = MAX_TICKETS;
    $('wz-count').value = count;
    showToast(`Maximum ${MAX_TICKETS} billets à la création (vous pourrez en ajouter ensuite)`, 'info');
  }
  wizardData.count = count;
  wizardData.start = start;
  wizardGo(5);
});

/* ============================================================
   ÉTAPE 2 — IMPORT DU MODÈLE
============================================================ */
const uploadZone = $('upload-zone');
const fileInput = $('wz-file');

uploadZone.addEventListener('click', () => fileInput.click());
uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadZone.classList.add('dragover');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('dragover');
  if (e.dataTransfer.files[0]) handleModelFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) handleModelFile(e.target.files[0]);
});

async function renderModel(blob, isPDF) {
  const canvas = document.createElement('canvas');
  let mime = 'image/png';

  if (isPDF) {
    const buf = await blob.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, MODEL_MAX_SIDE / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return {
      dataUrl: canvas.toDataURL('image/png'),
      width: canvas.width, height: canvas.height,
      pages: pdf.numPages
    };
  }

  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const k = Math.min(1, MODEL_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    canvas.width = Math.round(img.naturalWidth * k);
    canvas.height = Math.round(img.naturalHeight * k);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    if (blob.type === 'image/jpeg') mime = 'image/jpeg';
    return {
      dataUrl: canvas.toDataURL(mime, 0.95),
      width: canvas.width, height: canvas.height,
      pages: 1
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function handleModelFile(file) {
  const name = file.name.toLowerCase();
  const isPDF = name.endsWith('.pdf');
  const isImg = /\.(jpg|jpeg|png)$/.test(name);
  if (!isPDF && !isImg) return showToast('Format non supporté (PDF, JPG ou PNG)', 'error');
  if (file.size > 10 * 1024 * 1024) return showToast('Fichier trop volumineux (10 Mo max)', 'error');

  openGen('Préparation du modèle…');
  setGenProgress(30, isPDF ? 'Rendu du PDF…' : 'Chargement de l\'image…');
  try {
    const r = await renderModel(file, isPDF);

    wizardData.modelFile = file;
    wizardData.modelIsPDF = isPDF;
    wizardData.modelDataUrl = r.dataUrl;
    wizardData.modelWidth = r.width;
    wizardData.modelHeight = r.height;

    const extra = r.pages > 1 ? ' — seule la page 1 sera utilisée' : '';
    $('model-info').classList.remove('hidden');
    $('model-info').innerHTML = `
      <div class="model-preview-info">
        <div class="check">✓</div>
        <div>
          <strong>${escapeHtml(file.name)}</strong>
          <small>${r.width} × ${r.height} px — prêt à être positionné${extra}</small>
        </div>
      </div>
    `;
    $('wz-next-2').disabled = false;
    showToast(r.pages > 1 ? 'Modèle chargé (page 1 uniquement)' : 'Modèle chargé', r.pages > 1 ? 'info' : 'success');
  } catch (err) {
    console.error(err);
    wizardData.modelFile = null;
    wizardData.modelDataUrl = null;
    $('wz-next-2').disabled = true;
    showToast('Fichier illisible ou protégé', 'error');
  } finally {
    closeGen();
    fileInput.value = '';
  }
}

/* ============================================================
   ÉTAPE 3 — ÉDITEUR DE ZONES
============================================================ */
function initZoneEditor() {
  const img = $('zone-model-img');
  img.onload = () => applyZoneUI();
  img.src = wizardData.modelDataUrl;
  applyZoneUI();
}

function applyZoneUI() {
  ['qr', 'num'].forEach(type => {
    const z = wizardData.zones[type];
    const box = $(type === 'qr' ? 'zone-qr' : 'zone-num');
    box.style.left = z.x + '%';
    box.style.top = z.y + '%';
    box.style.width = z.w + '%';
    box.style.height = z.h + '%';
  });
  updateZoneInfo();
}

function updateZoneInfo() {
  const { qr, num } = wizardData.zones;
  $('info-qr').innerHTML = `x: ${qr.x.toFixed(1)}% · y: ${qr.y.toFixed(1)}%<br>w: ${qr.w.toFixed(1)}% · h: ${qr.h.toFixed(1)}%`;
  $('info-num').innerHTML = `x: ${num.x.toFixed(1)}% · y: ${num.y.toFixed(1)}%<br>w: ${num.w.toFixed(1)}% · h: ${num.h.toFixed(1)}%`;
}

document.querySelectorAll('.zone-box').forEach(box => {
  box.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('zone-handle')) startZoneAction(box, e, 'resize');
    else startZoneAction(box, e, 'move');
  });
});

function startZoneAction(box, e, mode) {
  e.preventDefault();
  e.stopPropagation();
  const rect = $('zone-canvas').getBoundingClientRect();
  const type = box.dataset.zone;
  const z = wizardData.zones[type];
  zoneDragState = {
    mode, type,
    startX: e.clientX, startY: e.clientY,
    origX: z.x, origY: z.y, origW: z.w, origH: z.h,
    canvasW: rect.width, canvasH: rect.height
  };
  box.setPointerCapture(e.pointerId);
  box.addEventListener('pointermove', onPointerMove);
  box.addEventListener('pointerup', onPointerUp);
  box.addEventListener('pointercancel', onPointerUp);
}

function onPointerMove(e) {
  if (!zoneDragState) return;
  const s = zoneDragState;
  const dx = ((e.clientX - s.startX) / s.canvasW) * 100;
  const dy = ((e.clientY - s.startY) / s.canvasH) * 100;
  const z = wizardData.zones[s.type];

  if (s.mode === 'move') {
    z.x = Math.max(0, Math.min(100 - z.w, s.origX + dx));
    z.y = Math.max(0, Math.min(100 - z.h, s.origY + dy));
  } else {
    z.w = Math.max(4, Math.min(100 - z.x, s.origW + dx));
    z.h = Math.max(2, Math.min(100 - z.y, s.origH + dy));
  }
  const box = $(s.type === 'qr' ? 'zone-qr' : 'zone-num');
  box.style.left = z.x + '%';
  box.style.top = z.y + '%';
  box.style.width = z.w + '%';
  box.style.height = z.h + '%';
  updateZoneInfo();
}

function onPointerUp(e) {
  const box = e.currentTarget;
  box.removeEventListener('pointermove', onPointerMove);
  box.removeEventListener('pointerup', onPointerUp);
  box.removeEventListener('pointercancel', onPointerUp);
  try { box.releasePointerCapture(e.pointerId); } catch (_) {}
  zoneDragState = null;
}

window.addEventListener('resize', () => {
  if (wizardData.step === 3 && !$('view-wizard').classList.contains('hidden')) applyZoneUI();
});

/* ============================================================
   ÉTAPE 4 — NUMÉROTATION
============================================================ */
['wz-count', 'wz-start'].forEach(id => $(id).addEventListener('input', updateNumPreview));

function updateNumPreview() {
  const count = parseInt($('wz-count').value) || 0;
  const start = parseInt($('wz-start').value) || 1;
  const prefix = wizardData.prefix || 'DCF';
  const el = $('num-preview');
  if (count < 1) { el.textContent = '—'; return; }
  const first = prefix + '-' + pad(start);
  const last = prefix + '-' + pad(start + count - 1);
  const samples = [];
  for (let i = 0; i < Math.min(count, 3); i++) samples.push(prefix + '-' + pad(start + i));
  if (count > 3) samples.push('…', last);
  el.innerHTML = `Du <b style="color:var(--text)">${escapeHtml(first)}</b> au <b style="color:var(--text)">${escapeHtml(last)}</b><br>` +
                 `<span style="font-size:11px">Exemples : ${escapeHtml(samples.join(' · '))}</span>`;
}

/* ============================================================
   ÉTAPE 5 — APERÇU
============================================================ */
async function renderPreviewStep() {
  $('sum-name').textContent = wizardData.name;
  $('sum-count').textContent = wizardData.count;
  $('sum-first').textContent = wizardData.prefix + '-' + pad(wizardData.start);
  $('sum-last').textContent = wizardData.prefix + '-' + pad(wizardData.start + wizardData.count - 1);

  const box = $('preview-box');
  box.innerHTML = '<div style="color:var(--text-dim);font-size:13px">Composition…</div>';

  try {
    const composer = await createComposer(wizardData.modelDataUrl, wizardData.zones);
    const canvas = await composer.draw({
      num: wizardData.prefix + '-' + pad(wizardData.start),
      token: 'APERCUXXXXXX'
    });
    box.innerHTML = `<img src="${canvas.toDataURL('image/png')}" alt="aperçu">`;
  } catch (err) {
    console.error(err);
    box.innerHTML = '<div style="color:var(--danger);font-size:13px">Erreur de composition</div>';
  }
}

/* ============================================================
   COMPOSITION D'UN BILLET
============================================================ */
const NUM_FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace';

async function createComposer(modelDataUrl, zonesIn) {
  const img = await loadImage(modelDataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  const zones = {
    qr:  { ...DEFAULT_ZONES.qr,  ...(zonesIn?.qr  || {}) },
    num: { ...DEFAULT_ZONES.num, ...(zonesIn?.num || {}) }
  };
  const px = (z) => ({
    x: (z.x / 100) * W, y: (z.y / 100) * H,
    w: (z.w / 100) * W, h: (z.h / 100) * H
  });
  const zq = px(zones.qr);
  const zn = px(zones.num);

  return {
    width: W,
    height: H,
    async draw(ticket) {
      ctx.drawImage(img, 0, 0);
      await drawQr(ctx, ticket.num + '|' + ticket.token, zq);
      drawNumber(ctx, ticket.num, zn);
      return canvas;
    }
  };
}

/**
 * Dessin du QR — API qrcode-generator
 *   qrcode(typeNumber, eccLevel) → objet
 *   .addData(text) / .make() / .getModuleCount() / .isDark(row, col)
 * Rendu module-par-module : bords nets, pas de flou, QR jamais déformé.
 */
async function drawQr(ctx, text, z) {
  // Fond blanc sur toute la zone
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(z.x, z.y, z.w, z.h);

  const side = Math.min(z.w, z.h);
  const QUIET = 2; // modules blancs autour du QR

  let qr = null;
  try {
    if (typeof window.qrcode === 'function') {
      qr = window.qrcode(0, 'M'); // 0 = détection auto du type
      qr.addData(text);
      qr.make();
    }
  } catch (err) {
    console.warn('QR generation failed:', err);
    qr = null;
  }

  if (qr) {
    const n = qr.getModuleCount();
    const cells = n + QUIET * 2;
    const cell = Math.max(1, Math.floor(side / cells));
    const size = cell * cells;
    const ox = Math.round(z.x + (z.w - size) / 2);
    const oy = Math.round(z.y + (z.h - size) / 2);
    ctx.fillStyle = '#000000';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) {
          ctx.fillRect(ox + (c + QUIET) * cell, oy + (r + QUIET) * cell, cell, cell);
        }
      }
    }
  } else {
    // Repli visuel si la lib n'est pas dispo (ne devrait pas arriver)
    ctx.fillStyle = '#CC0000';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('QR indisponible', z.x + z.w / 2, z.y + z.h / 2);
  }
}

function drawNumber(ctx, text, z) {
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(z.x, z.y, z.w, z.h);

  let fontSize = z.h * 0.75;
  ctx.font = `bold ${fontSize}px ${NUM_FONT}`;
  const textW = ctx.measureText(text).width;
  if (textW > z.w * 0.95) {
    fontSize = fontSize * (z.w * 0.95) / textW;
    ctx.font = `bold ${fontSize}px ${NUM_FONT}`;
  }
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, z.x + z.w / 2, z.y + z.h / 2);
}

/* ============================================================
   GÉNÉRATION DES BILLETS
============================================================ */
async function makeThumbBlob(dataUrl) {
  const img = await loadImage(dataUrl);
  const k = Math.min(1, 480 / img.naturalWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return canvasToBlob(c, 'image/jpeg', 0.8);
}

async function createTicketsRpc(eventId, total, onProgress) {
  let done = 0;
  while (done < total) {
    const n = Math.min(CREATE_CHUNK, total - done);
    const { error } = await sb.rpc('create_tickets', { p_event_id: eventId, p_count: n });
    if (error) throw error;
    done += n;
    if (onProgress) onProgress(done, total);
  }
}

async function generateTickets() {
  if (generating) return;
  if (!wizardData.modelFile || !wizardData.modelDataUrl) return showToast('Importez d\'abord un modèle', 'error');
  generating = true;
  $('wiz-generate').disabled = true;

  openGen('Création de l\'événement…');
  const uploaded = [];
  let createdEventId = null;

  try {
    const file = wizardData.modelFile;
    const ext = file.name.split('.').pop().toLowerCase();
    const baseId = uid();
    const storagePath = `${state.user.id}/${baseId}.${ext}`;
    const contentType = file.type ||
      (ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : 'image/jpeg');

    setGenProgress(8, 'Envoi du modèle…');
    const { error: upErr } = await sb.storage.from('models').upload(
      storagePath, file, { cacheControl: '3600', upsert: false, contentType }
    );
    if (upErr) throw upErr;
    uploaded.push(storagePath);

    let thumbPath = null;
    try {
      const thumb = await makeThumbBlob(wizardData.modelDataUrl);
      const tp = `${state.user.id}/${baseId}_thumb.jpg`;
      const { error: tErr } = await sb.storage.from('models').upload(
        tp, thumb, { cacheControl: '3600', upsert: false, contentType: 'image/jpeg' }
      );
      if (!tErr) { thumbPath = tp; uploaded.push(tp); }
    } catch (e) { console.warn('Miniature ignorée', e); }

    setGenProgress(18, 'Enregistrement de l\'événement…');
    const { data: eventData, error: evErr } = await sb.from('events').insert({
      owner_id: state.user.id,
      name: wizardData.name,
      prefix: wizardData.prefix,
      start_number: wizardData.start,
      model_path: storagePath,
      thumb_path: thumbPath,
      model_width: wizardData.modelWidth,
      model_height: wizardData.modelHeight,
      zones: wizardData.zones
    }).select().single();
    if (evErr) throw evErr;
    createdEventId = eventData.id;

    const total = wizardData.count;
    setGenProgress(25, 'Génération des billets…');
    await createTicketsRpc(createdEventId, total, (done) => {
      setGenProgress(25 + Math.round((done / total) * 75), `${done}/${total} billets…`);
    });

    setGenProgress(100, 'Terminé !');
    await sleep(350);

    await loadEvents();
    closeGen();

    $('success-title').textContent = 'Billets prêts !';
    $('success-sub').textContent = `${total} billets uniques générés pour « ${wizardData.name} ».`;
    $('modal-success').classList.add('show');
    window.__lastGeneratedEventId = createdEventId;
  } catch (err) {
    console.error(err);
    try {
      if (createdEventId) await sb.from('events').delete().eq('id', createdEventId);
      if (uploaded.length) await sb.storage.from('models').remove(uploaded);
    } catch (e) { console.warn('Nettoyage incomplet', e); }
    closeGen();
    showToast(err.message || 'Erreur de génération', 'error');
  } finally {
    generating = false;
    $('wiz-generate').disabled = false;
  }
}

$('btn-success-close').addEventListener('click', async () => {
  $('modal-success').classList.remove('show');
  const id = window.__lastGeneratedEventId;
  window.__lastGeneratedEventId = null;
  if (id) await openEvent(id);
  else goDashboard();
});

$('btn-success-pdf').addEventListener('click', async () => {
  $('modal-success').classList.remove('show');
  const id = window.__lastGeneratedEventId;
  window.__lastGeneratedEventId = null;
  if (!id) return goDashboard();
  await openEvent(id);
  exportPDF();
});

/* ============================================================
   VUE ÉVÉNEMENT
============================================================ */
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});

function switchTab(tab) {
  state.currentTab = tab;
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
  $('tab-stats').classList.toggle('hidden', tab !== 'stats');
  $('tab-scan').classList.toggle('hidden', tab !== 'scan');
  if (tab === 'scan') {
    renderScanTab();
  } else {
    stopCamera();
    refreshStats().then(renderStats).catch(console.error);
  }
}

function renderEvent() {
  const ev = state.currentEvent;
  if (!ev) return goDashboard();
  $('ev-title').textContent = ev.name;
  $('ev-subtitle').textContent = `${state.stats.total} billets • préfixe ${ev.prefix}-`;
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === state.currentTab);
  });
  $('tab-stats').classList.toggle('hidden', state.currentTab !== 'stats');
  $('tab-scan').classList.toggle('hidden', state.currentTab !== 'scan');
  if (state.currentTab === 'stats') renderStats();
  else renderScanTab();
}

async function refreshStats() {
  const ev = state.currentEvent;
  if (!ev) return;
  const [all, used] = await Promise.all([
    sb.from('tickets').select('id', { count: 'exact', head: true }).eq('event_id', ev.id),
    sb.from('tickets').select('id', { count: 'exact', head: true }).eq('event_id', ev.id).eq('status', 'used')
  ]);
  if (all.error) throw all.error;
  if (used.error) throw used.error;
  state.stats = { total: all.count || 0, used: used.count || 0 };
}

async function loadTickets(reset) {
  const ev = state.currentEvent;
  if (!ev) return;
  const reqId = ++ticketsReq;
  const from = reset ? 0 : state.currentTickets.length;

  let q = sb.from('tickets')
    .select('id,num,token,status,scanned_at,seq')
    .eq('event_id', ev.id)
    .order('seq', { ascending: true })
    .range(from, from + TICKETS_PAGE - 1);

  if (state.filters.status !== 'all') q = q.eq('status', state.filters.status);
  const term = state.filters.q.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (term) q = q.ilike('num', `%${term}%`);

  const { data, error } = await q;
  if (error) throw error;
  if (reqId !== ticketsReq) return;
  const rows = data || [];
  state.currentTickets = reset ? rows : state.currentTickets.concat(rows);
  state.ticketsHasMore = rows.length === TICKETS_PAGE;
}

async function loadScans() {
  const ev = state.currentEvent;
  if (!ev) return;
  const { data, error } = await sb.from('scans')
    .select('id,input,result,scanned_at,ticket:tickets(num)')
    .eq('event_id', ev.id)
    .order('scanned_at', { ascending: false })
    .limit(20);
  if (error) { console.warn(error); state.currentScans = []; return; }
  state.currentScans = (data || []).map(s => ({
    input: s.input,
    result: s.result,
    scanned_at: s.scanned_at,
    num: s.ticket?.num || null
  }));
}

function renderStats() {
  const { total, used } = state.stats;
  const valid = total - used;

  animateCount($('stat-total'), total);
  animateCount($('stat-used'), used);
  animateCount($('stat-valid'), valid);

  const pct = total ? Math.round((used / total) * 100) : 0;
  $('progress-pct').textContent = pct + '%';
  setTimeout(() => { $('progress-fill').style.width = pct + '%'; }, 50);

  $('tickets-count').textContent = total;
  $('ev-subtitle').textContent = `${total} billets • préfixe ${state.currentEvent.prefix}-`;
  renderTicketRows();
}

function renderTicketRows() {
  const tbody = $('tickets-tbody');
  tbody.innerHTML = '';
  state.currentTickets.forEach(t => {
    const tr = document.createElement('tr');
    tr.dataset.num = t.num;
    const badgeClass = t.status === 'used' ? 'used' : 'valid';
    const badgeLabel = t.status === 'used' ? '● Utilisé' : t.status === 'invalid' ? '● Annulé' : '● Valide';
    const maskedToken = escapeHtml(String(t.token).slice(0, 4)) + '••••••••';
    tr.innerHTML = `
      <td class="mono">${escapeHtml(t.num)}</td>
      <td class="mono" style="color:var(--text-dim)">${maskedToken}</td>
      <td><span class="badge ${badgeClass}">${badgeLabel}</span></td>
      <td style="color:var(--text-dim)">${t.scanned_at ? formatTime(t.scanned_at) : '—'}</td>
    `;
    tbody.appendChild(tr);
  });
  $('tickets-empty').classList.toggle('hidden', state.currentTickets.length > 0);
  $('tickets-more-wrap').classList.toggle('hidden', !state.ticketsHasMore);
}

async function reloadTicketList() {
  try {
    await loadTickets(true);
    renderTicketRows();
  } catch (err) {
    console.error(err);
    showToast('Erreur de chargement des billets', 'error');
  }
}

let searchTimer = null;
$('tk-search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.filters.q = e.target.value.trim();
    reloadTicketList();
  }, 300);
});
$('tk-status').addEventListener('change', (e) => {
  state.filters.status = e.target.value;
  reloadTicketList();
});
$('btn-tickets-more').addEventListener('click', async () => {
  const btn = $('btn-tickets-more');
  btn.disabled = true;
  try {
    await loadTickets(false);
    renderTicketRows();
  } catch (err) {
    console.error(err);
    showToast('Erreur de chargement', 'error');
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Ajout de billets ---------- */
$('btn-add-tickets').addEventListener('click', async () => {
  const ev = state.currentEvent;
  if (!ev) return;
  const count = Math.min(parseInt($('add-count').value) || 0, 1000);
  if (count < 1) return showToast('Entrez un nombre valide', 'error');

  const btn = $('btn-add-tickets');
  btn.disabled = true;
  openGen('Ajout de billets…');
  try {
    await createTicketsRpc(ev.id, count, (done) => {
      setGenProgress(Math.round((done / count) * 100), `${done}/${count} billets…`);
    });
    await Promise.all([refreshStats(), loadTickets(true)]);
    closeGen();
    showToast(count + ' billets ajoutés');
    renderEvent();
  } catch (err) {
    console.error(err);
    closeGen();
    showToast(err.message || 'Erreur', 'error');
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Suppression d'un événement ---------- */
$('btn-delete-event').addEventListener('click', async () => {
  const ev = state.currentEvent;
  if (!ev) return;
  const ok = confirm(
    `Supprimer définitivement « ${ev.name} » ?\n\n` +
    `${state.stats.total} billets, l'historique des scans et le modèle seront effacés. ` +
    `Cette action est irréversible.`
  );
  if (!ok) return;

  openGen('Suppression…');
  try {
    stopCamera();
    const { error } = await sb.from('events').delete().eq('id', ev.id);
    if (error) throw error;
    const files = [ev.model_path, ev.thumb_path].filter(Boolean);
    if (files.length) await sb.storage.from('models').remove(files);
    await loadEvents();
    closeGen();
    showToast('Événement supprimé');
    goDashboard();
  } catch (err) {
    console.error(err);
    closeGen();
    showToast(err.message || 'Suppression impossible', 'error');
  }
});

/* ============================================================
   SCANNER
============================================================ */
function renderScanTab() {
  renderHistory();
  updateScanCounter();
  if (window.matchMedia('(pointer: fine)').matches) $('scan-input').focus();
}

function updateScanCounter() {
  const { total, used } = state.stats;
  $('scan-counter').innerHTML = `<b>${used}</b> / ${total} entrées`;
}

function renderHistory() {
  const list = $('history-list');
  if (!state.currentScans || state.currentScans.length === 0) {
    list.innerHTML = '<div class="empty-history">Aucun scan pour le moment.</div>';
    return;
  }
  list.innerHTML = '';
  state.currentScans.slice(0, 15).forEach(s => {
    const item = document.createElement('div');
    item.className = 'history-item';
    const dotClass = s.result === 'valid' ? 'ok' : s.result === 'used' ? 'ko' : 'warn';
    const label = s.num || String(s.input || '').split('|')[0];
    item.innerHTML = `
      <div class="history-dot ${dotClass}"></div>
      <span class="history-num">${escapeHtml(label)}</span>
      <span class="history-time">${formatTime(s.scanned_at)}</span>
    `;
    list.appendChild(item);
  });
}

$('btn-scan-input').addEventListener('click', () => {
  const input = $('scan-input').value.trim().toUpperCase();
  if (!input) return showToast('Entrez un numéro', 'error');
  doScan(input);
});

$('scan-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('btn-scan-input').click();
  }
});

async function doScan(input) {
  if (scanning) return;
  const ev = state.currentEvent;
  if (!ev) return;
  input = String(input).trim().slice(0, 64);
  if (!input) return;

  scanning = true;
  $('scan-input').value = '';
  $('btn-scan-input').disabled = true;

  try {
    const { data, error } = await sb.rpc('scan_ticket', { p_event_id: ev.id, p_input: input });
    if (error) throw error;
    if (!data) throw new Error('Réponse vide du serveur');

    const shownNum = data.num || String(data.input || input).split('|')[0];
    let title, sub, type;

    if (data.result === 'valid') {
      type = 'valid';
      title = 'BILLET VALIDE';
      sub = data.num;
      state.stats.used++;
      const t = state.currentTickets.find(x => x.num === data.num);
      if (t) { t.status = 'used'; t.scanned_at = new Date().toISOString(); }
    } else if (data.result === 'used') {
      type = 'used';
      title = 'DÉJÀ UTILISÉ';
      sub = `${data.num} • ${formatTime(data.scanned_at)}`;
    } else if (data.result === 'invalid') {
      type = 'invalid';
      title = data.num ? 'BILLET ANNULÉ' : 'BILLET INCONNU';
      sub = shownNum;
    } else {
      type = 'invalid';
      title = data.message === 'not_authorized' ? 'ACCÈS REFUSÉ' : 'ERREUR';
      sub = '';
    }

    state.currentScans.unshift({
      input: shownNum,
      num: data.num || null,
      result: data.result === 'error' ? 'invalid' : data.result,
      scanned_at: new Date().toISOString()
    });
    state.currentScans = state.currentScans.slice(0, 20);

    feedback(type === 'valid' ? 'valid' : 'bad');
    showScanResult(type, title, sub);
    renderHistory();
    updateScanCounter();
  } catch (err) {
    console.error(err);
    feedback('bad');
    showToast(err.message || 'Erreur de scan', 'error');
  } finally {
    scanning = false;
    $('btn-scan-input').disabled = false;
    if (!camera.active && window.matchMedia('(pointer: fine)').matches) $('scan-input').focus();
  }
}

let resultTimer = null;
function showScanResult(type, title, sub) {
  const overlay = $('scan-result');
  const icon = $('result-icon');
  icon.className = 'result-icon ' + (type === 'valid' ? 'ok' : type === 'used' ? 'ko' : 'warn');
  icon.textContent = type === 'valid' ? '✓' : type === 'used' ? '✕' : '!';
  $('result-title').textContent = title;
  $('result-title').style.color = type === 'valid' ? '#34d399' : type === 'used' ? '#f87171' : '#fbbf24';
  $('result-sub').textContent = sub || '';
  overlay.classList.add('show');
  clearTimeout(resultTimer);
  resultTimer = setTimeout(() => overlay.classList.remove('show'), 2200);
}

/* ============================================================
   SCANNER CAMÉRA
============================================================ */
const camera = {
  active: false,
  stream: null,
  detector: null,
  canvas: null,
  timer: null,
  lastCode: '',
  lastAt: 0
};

async function startCamera() {
  if (camera.active) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return showToast('Caméra indisponible : ouvrez le site en HTTPS', 'error');
  }
  try {
    camera.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    const video = $('scan-video');
    video.srcObject = camera.stream;
    await video.play();

    if ('BarcodeDetector' in window) {
      try { camera.detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch (_) { camera.detector = null; }
    }
    camera.canvas = camera.canvas || document.createElement('canvas');
    camera.active = true;
    camera.lastCode = '';
    $('viewfinder').classList.add('cam-on');
    $('btn-camera').textContent = '⏹ Arrêter la caméra';
    cameraLoop();
  } catch (err) {
    console.error(err);
    stopCamera();
    const msg = err.name === 'NotAllowedError' ? 'Accès à la caméra refusé'
      : err.name === 'NotFoundError' ? 'Aucune caméra détectée'
      : 'Impossible de démarrer la caméra';
    showToast(msg, 'error');
  }
}

function stopCamera() {
  camera.active = false;
  clearTimeout(camera.timer);
  camera.timer = null;
  if (camera.stream) {
    camera.stream.getTracks().forEach(t => t.stop());
    camera.stream = null;
  }
  const video = $('scan-video');
  if (video) video.srcObject = null;
  const vf = $('viewfinder');
  if (vf) vf.classList.remove('cam-on');
  const btn = $('btn-camera');
  if (btn) btn.textContent = '📷 Activer la caméra';
}

async function cameraLoop() {
  if (!camera.active) return;
  const video = $('scan-video');
  let code = null;

  try {
    if (video.readyState >= 2 && video.videoWidth) {
      if (camera.detector) {
        const found = await camera.detector.detect(video);
        if (found.length) code = found[0].rawValue;
      } else if (window.jsQR) {
        const k = Math.min(1, 640 / video.videoWidth);
        const w = Math.round(video.videoWidth * k);
        const h = Math.round(video.videoHeight * k);
        camera.canvas.width = w;
        camera.canvas.height = h;
        const cctx = camera.canvas.getContext('2d', { willReadFrequently: true });
        cctx.drawImage(video, 0, 0, w, h);
        const res = jsQR(cctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
        if (res) code = res.data;
      }
    }
  } catch (err) { /* image illisible */ }

  if (code) {
    const now = Date.now();
    if (!(code === camera.lastCode && now - camera.lastAt < SCAN_COOLDOWN) && !scanning) {
      camera.lastCode = code;
      camera.lastAt = now;
      doScan(code);
    }
  }

  if (camera.active) camera.timer = setTimeout(cameraLoop, 150);
}

$('btn-camera').addEventListener('click', () => {
  if (camera.active) stopCamera();
  else startCamera();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && camera.active) stopCamera();
});

/* ============================================================
   EXPORT PDF
============================================================ */
$('btn-export-pdf').addEventListener('click', exportPDF);

async function fetchAllTickets(eventId, onProgress) {
  const PAGE = 1000;
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('tickets')
      .select('num,token')
      .eq('event_id', eventId)
      .order('seq', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...(data || []));
    if (onProgress) onProgress(all.length);
    if (!data || data.length < PAGE) break;
  }
  return all;
}

async function exportPDF() {
  if (exporting) return;
  const ev = state.currentEvent;
  if (!ev) return showToast('Aucun événement', 'error');
  if (!ev.model_path) return showToast('Modèle introuvable', 'error');

  exporting = true;
  openGen('Préparation du PDF…');
  setGenProgress(2, 'Téléchargement du modèle…');

  try {
    const { data: signed, error: sErr } = await sb.storage
      .from('models').createSignedUrl(ev.model_path, 3600);
    if (sErr) throw sErr;

    const resp = await fetch(signed.signedUrl);
    if (!resp.ok) throw new Error('Impossible de télécharger le modèle');
    const blob = await resp.blob();

    setGenProgress(4, 'Rendu du modèle…');
    const model = await renderModel(blob, isPdfPath(ev.model_path));
    const composer = await createComposer(model.dataUrl, ev.zones);

    setGenProgress(6, 'Chargement des billets…');
    const tickets = await fetchAllTickets(ev.id, (n) => setGenProgress(6, `Chargement des billets… ${n}`));
    if (tickets.length === 0) throw new Error('Aucun billet à exporter');

    const { jsPDF } = window.jspdf;
    const W = composer.width, H = composer.height;
    const orientation = W > H ? 'landscape' : 'portrait';
    const total = tickets.length;
    const parts = Math.ceil(total / PDF_CHUNK);
    const base = safeFileName(ev.name);

    for (let p = 0; p < parts; p++) {
      const slice = tickets.slice(p * PDF_CHUNK, (p + 1) * PDF_CHUNK);
      const pdf = new jsPDF({
        orientation, unit: 'px', format: [W, H], compress: true, hotfixes: ['px_scaling']
      });

      for (let i = 0; i < slice.length; i++) {
        const canvas = await composer.draw(slice[i]);
        if (i > 0) pdf.addPage([W, H], orientation);
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, W, H, undefined, 'FAST');

        const done = p * PDF_CHUNK + i + 1;
        setGenProgress(8 + Math.round((done / total) * 91), `${done}/${total} billets…`);
        if (i % 4 === 0) await sleep(0);
      }

      const name = parts === 1
        ? `${base}_${total}_billets.pdf`
        : `${base}_${slice[0].num}_a_${slice[slice.length - 1].num}.pdf`;
      pdf.save(name);
      if (p < parts - 1) await sleep(900);
    }

    closeGen();
    showToast(parts === 1
      ? `PDF téléchargé (${total} billets)`
      : `${parts} PDF téléchargés (${total} billets). Autorisez les téléchargements multiples si besoin.`);
  } catch (err) {
    console.error(err);
    closeGen();
    showToast(err.message || 'Erreur de génération du PDF', 'error');
  } finally {
    exporting = false;
  }
}

})(); /* fin du boot async */
