/* ─────────────────────────── auth.js ───────────────────────────
 * Portón de acceso con Supabase: login por link mágico al email + aprobación
 * de usuarios por un administrador. Todo opcional y NO invasivo:
 *   • Si supabaseConfig.js está vacío → no hace NADA, la app corre como siempre.
 *   • Si está configurado → muestra login; cada usuario nuevo queda "pendiente"
 *     hasta que un admin lo aprueba; el admin ve un panel para aprobar/rechazar.
 *
 * Además de controlar el ACCESO, sincroniza la cartera y demás datos del usuario
 * con la nube (tabla user_data): al entrar en cualquier dispositivo baja lo suyo,
 * y cada cambio en localStorage se guarda solo. Ver initCloudSync() más abajo.
 *
 * Defensivo a propósito: cualquier fallo de red/CDN/Supabase NO debe romper la
 * app; en el peor caso se cae a "sin login" y la app sigue andando. */

import { SUPABASE_URL, SUPABASE_ANON_KEY, ADMIN_EMAILS } from './supabaseConfig.js';

const CONFIGURED = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
const ADMINS = (ADMIN_EMAILS || []).map(e => String(e).toLowerCase());
const SUPABASE_ESM = 'https://esm.sh/@supabase/supabase-js@2';

let sb = null;         // cliente Supabase
let currentUser = null;
let currentProfile = null;
let loginMode = 'entrar'; // 'entrar' (ya aprobado) | 'solicitar' (primera vez)

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isAdmin = () => currentUser && ADMINS.includes(String(currentUser.email || '').toLowerCase());

/* ── arranque ── */
if (CONFIGURED) {
  init().catch(err => { console.warn('[auth] no se pudo iniciar el login, la app sigue sin portón:', err?.message); removeOverlay(); });
}

async function init() {
  const mod = await import(/* @vite-ignore */ SUPABASE_ESM);
  sb = mod.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  // Estado inicial + reacción a cambios (login, logout, refresh del link mágico).
  // Guardamos el access_token en cada cambio para el guardado con keepalive.
  sb.auth.onAuthStateChange((_e, session) => { _accessToken = session?.access_token ?? null; refresh(); });
  await refresh();
}

async function refresh() {
  try {
    const { data } = await sb.auth.getSession();
    currentUser = data?.session?.user ?? null;
    _accessToken = data?.session?.access_token ?? null;
    if (!currentUser) { currentProfile = null; renderLogin(); return; }
    currentProfile = await fetchProfile(currentUser.id);
    // El admin siempre entra (aunque su perfil aún no diga approved).
    if (isAdmin() || currentProfile?.approved) { removeOverlay(); renderAccountChip(); initCloudSync(); }
    else renderPending();
  } catch (err) {
    console.warn('[auth] refresh falló:', err?.message);
    removeOverlay();
  }
}

async function fetchProfile(id) {
  try {
    const { data } = await sb.from('profiles').select('*').eq('id', id).maybeSingle();
    return data ?? null;
  } catch { return null; }
}

/* ── acciones ── */
// Login DIRECTO con contraseña: si el email+contraseña son correctos, entra al
// instante (sin ir al correo). Es la forma segura de "entrar directo".
async function signInPassword(email, password) {
  return sb.auth.signInWithPassword({ email, password });
}
// Registro con contraseña (Solicitar acceso): crea la cuenta (queda pendiente).
// Si en Supabase "Confirm email" está apagado, entra al toque; si está prendido,
// primero confirma por correo. En ambos casos queda pendiente de aprobación.
async function signUpPassword(email, password) {
  return sb.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin + window.location.pathname } });
}
// Fallback sin contraseña (link mágico) — útil para cuentas viejas creadas por
// link, o si alguien olvidó su contraseña.
async function sendMagicLink(email, allowCreate) {
  return sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin + window.location.pathname, shouldCreateUser: !!allowCreate } });
}
async function signOut() { try { await sb.auth.signOut(); } catch { /* ignore */ } location.reload(); }
async function listProfiles() {
  try { const { data } = await sb.from('profiles').select('*').order('created_at', { ascending: false }); return data ?? []; }
  catch (err) { console.warn('[auth] no se pudieron listar usuarios:', err?.message); return []; }
}
async function setApproved(id, approved) {
  try { await sb.from('profiles').update({ approved }).eq('id', id); return true; }
  catch (err) { console.warn('[auth] no se pudo actualizar el usuario:', err?.message); return false; }
}

/* ══════════════════ Sync de datos del usuario en la nube ══════════════════
 * Espeja las claves de datos del usuario (icp_* salvo las cachés) a una fila
 * por usuario en la tabla user_data (JSON). Modelo simple pero robusto para un
 * mismo usuario en varios dispositivos, editando en momentos distintos:
 *   • Al entrar: baja la nube y, si es más nueva que lo local, la aplica.
 *   • Cada cambio en localStorage se guarda solo (debounce) con un updated_at.
 *   • Al VOLVER a la pestaña (o cada ~30s con la pestaña visible) se RE-BAJA la
 *     nube y se aplica si otro dispositivo la dejó más nueva → así "abrir en la
 *     otra compu" trae siempre lo último, aunque la pestaña ya estuviera abierta.
 *   • Aplicamos la nube solo si su updated_at es MAYOR que el nuestro, para no
 *     pisar una edición local todavía sin guardar.
 * Sin tocar los cientos de lugares donde la app escribe: interceptamos
 * localStorage.setItem una sola vez. */
let syncStarted = false, _saveTimer = null, _accessToken = null;
let _cloudStamp = 0;      // updated_at (ms) de lo último que aplicamos/guardamos
let _pullTimer = null;    // sondeo periódico mientras la pestaña está visible
let _applying = false;    // true mientras aplicamos la nube (no re-guardar)
let _syncState = 'idle';  // idle | saving | saved | pulling | error
const SYNC_DENY = (k) => k.startsWith('icp_cache_') || k === 'icp_ref_cache';
const isSyncKey = (k) => typeof k === 'string' && k.startsWith('icp_') && !SYNC_DENY(k);
function snapshotLocal() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (isSyncKey(k)) out[k] = localStorage.getItem(k); }
  return out;
}
function applyToLocal(data) {
  _applying = true; // evita que la intercepción de setItem dispare un re-guardado
  try { for (const [k, v] of Object.entries(data || {})) { if (isSyncKey(k) && typeof v === 'string') { try { localStorage.setItem(k, v); } catch { /* lleno */ } } } }
  finally { _applying = false; }
}
function setSyncState(s) { _syncState = s; try { updateSyncChip(); } catch { /* el chip aún no existe */ } }
// Lee la fila MÁS NUEVA del usuario. No usa maybeSingle (que EXPLOTA si por un
// problema de constraint quedaron filas duplicadas y dejaba a la otra compu
// "sin nube"): ordena por updated_at y toma la última. Devuelve { data, stamp }.
async function loadCloud() {
  try {
    const { data, error } = await sb.from('user_data').select('data, updated_at').eq('id', currentUser.id).order('updated_at', { ascending: false }).limit(1);
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return null;
    return { data: row.data ?? null, stamp: row.updated_at ? Date.parse(row.updated_at) : 0 };
  } catch (err) { console.warn('[sync] no se pudo leer la nube:', err?.message); return null; }
}
async function saveCloud() {
  if (!currentUser) return;
  setSyncState('saving');
  const iso = new Date().toISOString();
  try {
    const { error } = await sb.from('user_data').upsert({ id: currentUser.id, data: snapshotLocal(), updated_at: iso }, { onConflict: 'id' });
    if (error) throw error;
    _cloudStamp = Date.parse(iso);
    setSyncState('saved');
  } catch (err) { console.warn('[sync] no se pudo guardar en la nube:', err?.message); setSyncState('error'); }
}
/** Guardado "a prueba de cierre". En el celular, al minimizar/cerrar la app o
 *  bloquear la pantalla el navegador CONGELA la página y aborta los fetch en
 *  curso — así el guardado normal (supabase-js) puede quedar a mitad de camino
 *  y perderse el último cambio (el bug del "no se guardó lo que hice en el
 *  celu"). Este hace un POST REST directo con keepalive:true, que el navegador
 *  se compromete a completar aunque la página se descargue. Best-effort y
 *  totalmente defensivo: si algo falla, la app no se entera. */
function saveCloudBeacon() {
  if (!currentUser || !_accessToken) return;
  try {
    const iso = new Date().toISOString();
    const body = JSON.stringify({ id: currentUser.id, data: snapshotLocal(), updated_at: iso });
    fetch(`${SUPABASE_URL}/rest/v1/user_data`, {
      method: 'POST',
      keepalive: true,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${_accessToken}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body,
    }).catch(() => { /* la página ya no está: no hay a quién avisar */ });
    _cloudStamp = Date.parse(iso); // optimista: asumimos que el keepalive llega
  } catch { /* ignore */ }
}
function scheduleSave() { clearTimeout(_saveTimer); _saveTimer = setTimeout(saveCloud, 1200); }
// Al ocultarse/descargarse la página: cancelamos el debounce pendiente y
// guardamos YA con keepalive, que sobrevive al congelamiento del móvil.
function flushOnHide() { clearTimeout(_saveTimer); saveCloudBeacon(); }
// Re-baja la nube y la aplica SOLO si es más nueva que lo último que vimos (o si
// force=true). Así una pestaña ya abierta —o abrir la app en otra compu— recoge
// los cambios hechos en otro dispositivo, sin pisar ediciones locales sin guardar.
async function pullIfRemoteNewer(force = false, announce = false) {
  if (!currentUser || _applying) return false;
  if (announce) setSyncState('pulling');
  const cloud = await loadCloud();
  if (cloud && cloud.data && Object.keys(cloud.data).length && (force || cloud.stamp > _cloudStamp)) {
    applyToLocal(cloud.data);
    _cloudStamp = cloud.stamp || Date.now();
    try { window.__vertexReload?.(); } catch { /* se re-renderiza en el próximo ciclo */ }
    setSyncState('saved'); // sí anunciamos cuando de verdad trajimos algo nuevo
    return true;
  }
  if (announce) setSyncState('saved');
  return false; // sondeo silencioso: no tocamos el chip si no cambió nada
}
function startPullPolling() {
  clearInterval(_pullTimer);
  _pullTimer = setInterval(() => { if (document.visibilityState === 'visible') pullIfRemoteNewer(); }, 30000);
}
async function initCloudSync() {
  if (syncStarted || !currentUser) return; syncStarted = true;
  const cloud = await loadCloud();
  const hasCloud = cloud && cloud.data && Object.keys(cloud.data).length > 0;
  if (hasCloud) {
    applyToLocal(cloud.data);
    _cloudStamp = cloud.stamp || Date.now();
    try { window.__vertexReload?.(); } catch { /* la app se re-renderiza sola en el próximo ciclo */ }
    setSyncState('saved');
  } else {
    // Nube vacía: subimos lo que ya había en este navegador como base inicial.
    const snap = snapshotLocal();
    if (Object.keys(snap).length) await saveCloud(); else setSyncState('saved');
  }
  // Auto-guardado: interceptamos setItem UNA vez (después de aplicar la nube,
  // para no disparar un guardado redundante al escribir los datos entrantes).
  const orig = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (k, v) => { orig(k, v); if (!_applying && isSyncKey(k)) { setSyncState('saving'); scheduleSave(); } };
  // Al VOLVER a la pestaña (visibilitychange visible / focus): re-bajamos la nube
  // por si editaste en otro dispositivo. Al ocultarse/descargarse: flush con
  // keepalive (Safari iOS ni dispara 'beforeunload', por eso 'pagehide').
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnHide();
    else { pullIfRemoteNewer(); startPullPolling(); }
  });
  window.addEventListener('focus', () => pullIfRemoteNewer());
  window.addEventListener('pagehide', flushOnHide);
  startPullPolling();
}

/* ── Indicador de sincronización (chip de cuenta) ── */
const SYNC_LABELS = {
  idle: '☁ sync', saving: '⟳ guardando…', saved: '✓ sincronizado',
  pulling: '⟳ actualizando…', error: '⚠ sin sincronizar',
};
function syncChipLabel() { return SYNC_LABELS[_syncState] ?? SYNC_LABELS.idle; }
function updateSyncChip() {
  const el = document.getElementById('auth-chip-sync');
  if (!el) return;
  el.textContent = syncChipLabel();
  el.classList.toggle('is-error', _syncState === 'error');
  el.classList.toggle('is-busy', _syncState === 'saving' || _syncState === 'pulling');
}
// Sincronización manual: sube lo local YA y baja lo último de la nube. Útil como
// botón de "asegurate de guardar/traer" antes de cambiar de dispositivo.
async function syncNow() {
  if (!currentUser) return;
  clearTimeout(_saveTimer);
  await saveCloud();
  await pullIfRemoteNewer(true, true);
}

/* ── UI: overlay ── */
function overlayEl() {
  let el = document.getElementById('auth-overlay');
  if (!el) { el = document.createElement('div'); el.id = 'auth-overlay'; el.className = 'auth-overlay'; document.body.appendChild(el); }
  return el;
}
function removeOverlay() { document.getElementById('auth-overlay')?.remove(); }

function renderLogin() {
  const el = overlayEl();
  const isReq = loginMode === 'solicitar';
  el.innerHTML = `
    <div class="auth-card">
      <img class="auth-logo" src="./icons/vertex-signal.png" alt="Vertex Signal" onerror="this.style.display='none'" />
      <div class="auth-brand">Vertex Signal</div>
      <div class="auth-seg" role="group" aria-label="Tipo de acceso">
        <button type="button" class="auth-seg-btn ${!isReq ? 'active' : ''}" data-login-mode="entrar">Ya tengo acceso</button>
        <button type="button" class="auth-seg-btn ${isReq ? 'active' : ''}" data-login-mode="solicitar">Solicitar acceso</button>
      </div>
      <div class="auth-title">${isReq ? 'Creá tu acceso' : 'Entrá a tu cuenta'}</div>
      <div class="auth-sub">${isReq
        ? 'Elegí tu email y una contraseña. Un administrador va a <strong>aprobar</strong> tu cuenta y ahí ya vas a poder entrar.'
        : 'Poné tu email y contraseña y entrás <strong>directo</strong>, sin ir al correo.'}</div>
      <form id="auth-form">
        <input type="email" id="auth-email" class="auth-input" placeholder="tu@email.com" autocomplete="email" required />
        <input type="password" id="auth-pass" class="auth-input" placeholder="Contraseña${isReq ? ' (mín. 6 caracteres)' : ''}" autocomplete="${isReq ? 'new-password' : 'current-password'}" required />
        <button type="submit" class="auth-btn" id="auth-send">${isReq ? 'Solicitar ingreso' : 'Entrar'}</button>
      </form>
      <div class="auth-msg" id="auth-msg"></div>
      ${!isReq ? `<button type="button" class="auth-link" id="auth-magic">¿Sin contraseña o la olvidaste? Entrar con link al correo</button>` : ''}
      <div class="auth-foot">${isReq ? '¿Ya te aprobaron? Usá <strong>“Ya tengo acceso”</strong>.' : '¿Primera vez? Tocá <strong>“Solicitar acceso”</strong> para pedir permiso.'}</div>
    </div>`;
  el.querySelectorAll('[data-login-mode]').forEach(b => b.addEventListener('click', () => { loginMode = b.dataset.loginMode; renderLogin(); }));

  const emailEl = () => el.querySelector('#auth-email').value.trim();
  const msgEl = () => el.querySelector('#auth-msg');
  const setMsg = (cls, txt) => { const m = msgEl(); m.className = 'auth-msg ' + cls; m.innerHTML = txt; };

  const form = el.querySelector('#auth-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = emailEl();
    const password = el.querySelector('#auth-pass').value;
    const btn = el.querySelector('#auth-send');
    if (!email || !password) return;
    if (isReq && password.length < 6) { setMsg('err', 'La contraseña tiene que tener al menos 6 caracteres.'); return; }
    btn.disabled = true; btn.textContent = isReq ? 'Creando…' : 'Entrando…';
    if (isReq) {
      const { error } = await signUpPassword(email, password);
      if (error) {
        const exists = /already|registered|exist/i.test(error.message || '');
        setMsg('err', exists ? 'Ese email ya está registrado. Usá <strong>“Ya tengo acceso”</strong>.' : 'No se pudo registrar: ' + error.message);
        btn.disabled = false; btn.textContent = 'Solicitar ingreso';
      } else {
        setMsg('ok', '¡Cuenta creada! Queda <strong>pendiente</strong> hasta que un administrador te apruebe. Después entrás con tu email y contraseña.');
        btn.textContent = 'Solicitud enviada';
      }
    } else {
      const { error } = await signInPassword(email, password);
      // Éxito → onAuthStateChange dispara refresh() y se abre la app. No hace falta más.
      if (error) {
        setMsg('err', 'Email o contraseña incorrectos, o el email todavía no tiene acceso. ¿Primera vez? Tocá <strong>“Solicitar acceso”</strong>.');
        btn.disabled = false; btn.textContent = 'Entrar';
      }
    }
  });

  // Fallback: entrar con link mágico (cuentas viejas sin contraseña / olvido).
  el.querySelector('#auth-magic')?.addEventListener('click', async () => {
    const email = emailEl();
    if (!email) { setMsg('err', 'Escribí tu email arriba primero.'); return; }
    setMsg('', 'Enviando link…');
    const { error } = await sendMagicLink(email, false);
    if (error) setMsg('err', 'No se pudo enviar el link: ' + error.message);
    else setMsg('ok', 'Te mandamos un link a ' + email + '. Tocalo para entrar y, si querés, después ponés una contraseña.');
  });
}

function renderPending() {
  const el = overlayEl();
  el.innerHTML = `
    <div class="auth-card">
      <img class="auth-logo" src="./icons/vertex-signal.png" alt="Vertex Signal" onerror="this.style.display='none'" />
      <div class="auth-brand">Vertex Signal</div>
      <div class="auth-title">Tu cuenta está pendiente ⏳</div>
      <div class="auth-sub">Entraste como <strong>${esc(currentUser.email)}</strong>. Un administrador tiene que <strong>aprobar</strong> tu cuenta antes de que puedas usar la plataforma. Te avisará cuando esté lista.</div>
      <button class="auth-btn ghost" id="auth-logout">Cerrar sesión</button>
    </div>`;
  el.querySelector('#auth-logout').addEventListener('click', signOut);
}

/* ── UI: chip de cuenta (abajo a la izquierda) + panel admin ── */
function renderAccountChip() {
  let chip = document.getElementById('auth-chip');
  if (!chip) { chip = document.createElement('div'); chip.id = 'auth-chip'; chip.className = 'auth-chip'; document.body.appendChild(chip); }
  chip.innerHTML = `
    <span class="auth-chip-email" title="${esc(currentUser.email)}">${esc(currentUser.email)}</span>
    <button class="auth-chip-btn auth-sync" id="auth-chip-sync" title="Estado de sincronización — tocá para sincronizar ahora">${syncChipLabel()}</button>
    ${isAdmin() ? `<button class="auth-chip-btn" id="auth-admin-open" title="Panel de administración">⚙ Admin</button>` : ''}
    <button class="auth-chip-btn" id="auth-chip-pass" title="Definir o cambiar tu contraseña">🔑</button>
    <button class="auth-chip-btn" id="auth-chip-logout" title="Cerrar sesión">Salir</button>`;
  chip.querySelector('#auth-chip-logout').addEventListener('click', signOut);
  chip.querySelector('#auth-chip-sync').addEventListener('click', syncNow);
  chip.querySelector('#auth-admin-open')?.addEventListener('click', openAdminPanel);
  chip.querySelector('#auth-chip-pass').addEventListener('click', async () => {
    const pw = window.prompt('Definí una contraseña para entrar directo la próxima vez (mín. 6 caracteres):');
    if (pw == null) return;
    if (pw.length < 6) { alert('La contraseña tiene que tener al menos 6 caracteres.'); return; }
    const { error } = await sb.auth.updateUser({ password: pw });
    alert(error ? ('No se pudo guardar: ' + error.message) : '¡Listo! Ya podés entrar con tu email y esta contraseña.');
  });
}

async function openAdminPanel() {
  const el = overlayEl();
  el.innerHTML = `<div class="auth-card admin"><div class="auth-title">Panel de administración</div><div class="auth-sub">Cargando usuarios…</div></div>`;
  const profiles = await listProfiles();
  const pending = profiles.filter(p => !p.approved);
  const approved = profiles.filter(p => p.approved);
  const row = (p) => `
    <div class="admin-row">
      <span class="admin-mail">${esc(p.email || p.id)}</span>
      <span class="admin-badge ${p.approved ? 'ok' : 'pend'}">${p.approved ? 'aprobado' : 'pendiente'}</span>
      ${p.approved
        ? `<button class="admin-act reject" data-admin-set="0" data-id="${esc(p.id)}">Revocar</button>`
        : `<button class="admin-act approve" data-admin-set="1" data-id="${esc(p.id)}">Aprobar</button>`}
    </div>`;
  el.innerHTML = `
    <div class="auth-card admin">
      <div class="auth-title">Panel de administración</div>
      <div class="auth-sub">Aprobá o revocá el acceso de cada usuario. Solo vos (${esc(currentUser.email)}) ves esto.</div>
      <div class="admin-section-t">Pendientes (${pending.length})</div>
      <div class="admin-list">${pending.length ? pending.map(row).join('') : '<div class="admin-empty">No hay solicitudes pendientes.</div>'}</div>
      <div class="admin-section-t">Aprobados (${approved.length})</div>
      <div class="admin-list">${approved.length ? approved.map(row).join('') : '<div class="admin-empty">Todavía nadie aprobado.</div>'}</div>
      <button class="auth-btn" id="admin-close">Volver a la app</button>
    </div>`;
  el.querySelectorAll('[data-admin-set]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = '…';
      await setApproved(btn.dataset.id, btn.dataset.adminSet === '1');
      openAdminPanel(); // recargar la lista
    });
  });
  el.querySelector('#admin-close').addEventListener('click', () => { removeOverlay(); });
}
