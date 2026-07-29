/**
 * portfolio.js — Tenencias de cartera persistidas en localStorage.
 * Mismo patrón que watchlist.js: solo guarda los datos de entrada del
 * usuario (ticker, cantidad, costo promedio opcional); los precios/señales
 * de cada holding se resuelven en caliente contra dataSource.js.
 */
const KEY = 'icp_portfolio';
const MAX = 50;

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function write(list) {
  const payload = JSON.stringify(list);
  try { localStorage.setItem(KEY, payload); return true; }
  catch {
    // Almacenamiento lleno: la caché de cotizaciones/velas (icp_cache_*) es lo
    // más pesado y 100% descartable (se regenera desde la API). La limpiamos y
    // reintentamos una vez — los datos del usuario nunca deben quedar sin poder
    // guardarse por culpa de la caché.
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith('icp_cache_')) localStorage.removeItem(k);
      }
      localStorage.setItem(KEY, payload);
      return true;
    } catch { return false; /* sigue sin entrar o localStorage no disponible */ }
  }
}

export function getPortfolio() { return read(); }

export function addHolding(ticker, shares, avgCost, costCurrency = 'USD', purchaseDate = null) {
  const list = read();
  const existing = list.find(h => h.ticker === ticker);
  if (existing) {
    existing.shares = shares;
    if (avgCost != null) { existing.avgCost = avgCost; existing.costCurrency = costCurrency; existing.purchaseDate = purchaseDate ?? null; }
  } else {
    if (list.length >= MAX) return list; // límite silencioso
    list.push({ ticker, shares, avgCost: avgCost ?? null, costCurrency, purchaseDate: purchaseDate ?? null });
  }
  write(list);
  return list;
}

export function removeHolding(ticker) {
  const list = read().filter(h => h.ticker !== ticker);
  write(list);
  return list;
}

export const PORTFOLIO_MAX = MAX;
