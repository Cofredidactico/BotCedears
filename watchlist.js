/**
 * watchlist.js — Lista de seguimiento persistida en localStorage.
 * Solo guarda tickers (strings); los datos de cada uno se resuelven en
 * caliente contra dataSource.js, igual que el resto de la app.
 */
const KEY = 'icp_watchlist';
const MAX = 10; // acota el uso de la API (candles + quote por cada uno)

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function write(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* localStorage no disponible */ }
}

export function getWatchlist() { return read(); }

export function isWatched(ticker) { return read().includes(ticker); }

export function addToWatchlist(ticker) {
  const list = read();
  if (list.includes(ticker)) return list;
  if (list.length >= MAX) return list; // límite silencioso, evita disparar de más contra la API
  list.push(ticker);
  write(list);
  return list;
}

export function removeFromWatchlist(ticker) {
  const list = read().filter(t => t !== ticker);
  write(list);
  return list;
}

export function toggleWatchlist(ticker) {
  return isWatched(ticker) ? removeFromWatchlist(ticker) : addToWatchlist(ticker);
}

export const WATCHLIST_MAX = MAX;
