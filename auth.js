/* ─────────────────────────── auth.js ───────────────────────────
 * Portón de acceso con Supabase: login por link mágico al email + aprobación
 * de usuarios por un administrador. Todo opcional y NO invasivo:
 *   • Si supabaseConfig.js está vacío → no hace NADA, la app corre como siempre.
 *   • Si está configurado → muestra login; cada usuario nuevo queda "pendiente"
 *     hasta que un admin lo aprueba; el admin ve un panel para aprobar/rechazar.
 *
 * La cartera y demás datos siguen viviendo en el navegador (localStorage) por
 * ahora — este portón controla el ACCESO a la plataforma. Mover los datos a la
 * nube (sync entre dispositivos) es el paso siguiente, ya con esto en pie.
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
  sb.auth.onAuthStateChange(() => { refresh(); });
  await refresh();
}

async function refresh() {
  try {
    const { data } = await sb.auth.getSession();
    currentUser = data?.session?.user ?? null;
    if (!currentUser) { currentProfile = null; renderLogin(); return; }
    currentProfile = await fetchProfile(currentUser.id);
    // El admin siempre entra (aunque su perfil aún no diga approved).
    if (isAdmin() || currentProfile?.approved) { removeOverlay(); renderAccountChip(); }
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
async function sendMagicLink(email) {
  return sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin + window.location.pathname } });
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

/* ── UI: overlay ── */
function overlayEl() {
  let el = document.getElementById('auth-overlay');
  if (!el) { el = document.createElement('div'); el.id = 'auth-overlay'; el.className = 'auth-overlay'; document.body.appendChild(el); }
  return el;
}
function removeOverlay() { document.getElementById('auth-overlay')?.remove(); }

function renderLogin() {
  const el = overlayEl();
  el.innerHTML = `
    <div class="auth-card">
      <div class="auth-brand">Investment Copilot AI</div>
      <div class="auth-title">Ingresá con tu email</div>
      <div class="auth-sub">Te mandamos un <strong>link mágico</strong> a tu correo. Tocás el link y entrás — sin contraseñas.</div>
      <form id="auth-form">
        <input type="email" id="auth-email" class="auth-input" placeholder="tu@email.com" autocomplete="email" required />
        <button type="submit" class="auth-btn" id="auth-send">Enviarme el link</button>
      </form>
      <div class="auth-msg" id="auth-msg"></div>
      <div class="auth-foot">Acceso por invitación: un administrador tiene que aprobar tu cuenta antes de que puedas usar la plataforma.</div>
    </div>`;
  const form = el.querySelector('#auth-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = el.querySelector('#auth-email').value.trim();
    const msg = el.querySelector('#auth-msg');
    const btn = el.querySelector('#auth-send');
    if (!email) return;
    btn.disabled = true; btn.textContent = 'Enviando…';
    const { error } = await sendMagicLink(email);
    if (error) { msg.className = 'auth-msg err'; msg.textContent = 'No se pudo enviar: ' + error.message; btn.disabled = false; btn.textContent = 'Enviarme el link'; }
    else { msg.className = 'auth-msg ok'; msg.textContent = '¡Listo! Revisá tu correo (' + email + ') y tocá el link para entrar.'; btn.textContent = 'Link enviado'; }
  });
}

function renderPending() {
  const el = overlayEl();
  el.innerHTML = `
    <div class="auth-card">
      <div class="auth-brand">Investment Copilot AI</div>
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
    ${isAdmin() ? `<button class="auth-chip-btn" id="auth-admin-open" title="Panel de administración">⚙ Admin</button>` : ''}
    <button class="auth-chip-btn" id="auth-chip-logout" title="Cerrar sesión">Salir</button>`;
  chip.querySelector('#auth-chip-logout').addEventListener('click', signOut);
  chip.querySelector('#auth-admin-open')?.addEventListener('click', openAdminPanel);
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
