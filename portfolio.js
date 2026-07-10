/**
 * portfolio.js — Tenencias de cartera persistidas en localStorage.
 * Mismo patrón que watchlist.js: solo guarda los datos de entrada del
 * usuario (ticker, cantidad, costo promedio opcional); los precios/señales
 * de cada holding se resuelven en caliente contra dataSource.js.
 */
const KEY = 'icp_portfolio';
const MAX = 25;

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

export function getPortfolio() { return read(); }

export function addHolding(ticker, shares, avgCost) {
  const list = read();
  const existing = list.find(h => h.ticker === ticker);
  if (existing) {
    existing.shares = shares;
    if (avgCost != null) existing.avgCost = avgCost;
  } else {
    if (list.length >= MAX) return list; // límite silencioso
    list.push({ ticker, shares, avgCost: avgCost ?? null });
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
