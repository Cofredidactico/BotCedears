/**
 * dataSource.js — Capa de datos única de CEDEAR Signals
 * ─────────────────────────────────────────────────────────────────────────────
 * Esta es la ÚNICA pieza que el front necesita para pasar de datos simulados a
 * datos reales. La app de análisis (indicadores, score, riesgo) NO cambia: este
 * módulo entrega OHLCV crudo + cotizaciones, y el motor calcula todo lo demás.
 *
 *   App (motor de indicadores)  ──►  dataSource  ──►  { Mock | Live }
 *                                                          │
 *                                              Live  ──►  /api/*  (serverless)
 *                                                          │  (la API key vive acá)
 *                                              Finnhub · Twelve Data · dolarapi · data912
 *
 * CONTRATO DE DATOS (lo que el motor necesita por activo):
 *   getUniverse()                 -> Asset[]            { ticker,name,sector,ratio,refPriceUsd }
 *   getCCL()                      -> { value, changePct }
 *   getQuote(ticker)              -> Quote              { usd, changePct, cedearArs, volumeArsM }
 *   getCandles(ticker, tf, n)     -> Candles            { o[],h[],l[],c[],v[] }  (más viejo → más nuevo)
 *
 * Para activar datos reales: poné  MODE = 'live'  (o window.CEDEAR_MODE='live')
 * y desplegá las funciones /api/* (ver README.md). Si una llamada real falla,
 * el módulo cae a Mock y marca isReal=false para no romper la demo.
 */

const MODE = (typeof window !== 'undefined' && window.CEDEAR_MODE) || 'mock'; // 'mock' | 'live'
const API_BASE = (typeof window !== 'undefined' && window.CEDEAR_API_BASE) || '/api';
const CACHE_TTL_MS = 60 * 1000; // 60s: respeta rate limits del free tier

/** @typedef {{ticker:string,name:string,sector:string,ratio:number,refPriceUsd:number}} Asset */
/** @typedef {{usd:number,changePct:number,cedearArs:number,volumeArsM:number,isReal:boolean}} Quote */
/** @typedef {{o:number[],h:number[],l:number[],c:number[],v:number[],isReal:boolean}} Candles */

/* ───────────────────────── caché en memoria ───────────────────────── */
const _cache = new Map();
function cached(key, ttl, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.p;
  const p = Promise.resolve().then(fn).catch(err => { _cache.delete(key); throw err; });
  _cache.set(key, { t: Date.now(), p });
  return p;
}

/* ───────────────────────── universo (estático) ─────────────────────── */
let _universe = null;
export async function getUniverse() {
  if (_universe) return _universe;
  const res = await fetch('./universe.json');
  _universe = await res.json();
  return _universe;
}

/* ═════════════════════════════ MOCK ════════════════════════════════ */
/* Generador determinístico (mismo algoritmo que la app actual).        */
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function hsh(s){let h=2166136261>>>0;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}

const Mock = {
  async getCCL(){ return { value: 1247.5, changePct: 0.34 }; },
  async getQuote(ticker){
    const u = (await getUniverse()).find(a=>a.ticker===ticker) || {refPriceUsd:100,ratio:10};
    const r = mulberry32(hsh(ticker)^0x55);
    const usd = u.refPriceUsd, changePct = (r()-0.45)*4;
    const ccl = (await this.getCCL()).value;
    return { usd, changePct, cedearArs: usd/u.ratio*ccl, volumeArsM: Math.round(50+r()*1500), isReal:false };
  },
  async getCandles(ticker, tf='1day', n=150){
    const u = (await getUniverse()).find(a=>a.ticker===ticker) || {refPriceUsd:100};
    const seed = hsh(ticker)^hsh(tf), rnd = mulberry32(seed);
    const vol=0.012+rnd()*0.022, drift=(rnd()-0.45)*0.006;
    const o=[],h=[],l=[],c=[],v=[]; let price=100;
    for(let i=0;i<n;i++){ const op=price, shock=(rnd()-0.5)*2*vol+drift; let cp=op*(1+shock); if(cp<1)cp=1;
      const wick=op*vol*(0.5+rnd()); o.push(op); h.push(Math.max(op,cp)+wick*rnd()); l.push(Math.min(op,cp)-wick*rnd()); c.push(cp); v.push(0.7+rnd()); price=cp; }
    const scf=u.refPriceUsd/c[c.length-1]; for(const k of [o,h,l,c]) for(let i=0;i<k.length;i++) k[i]*=scf;
    return { o,h,l,c,v, isReal:false };
  }
};

/* ═════════════════════════════ LIVE ════════════════════════════════ */
/* Pega a las funciones serverless /api/* (que ocultan la API key).      */
const Live = {
  async getCCL(){
    return cached('ccl', CACHE_TTL_MS, async () => {
      const r = await fetch(`${API_BASE}/ccl`); if(!r.ok) throw new Error('ccl '+r.status);
      return r.json(); // { value, changePct }
    });
  },
  async getQuote(ticker){
    return cached('q:'+ticker, CACHE_TTL_MS, async () => {
      const r = await fetch(`${API_BASE}/quote?symbol=${encodeURIComponent(ticker)}`);
      if(!r.ok) throw new Error('quote '+r.status);
      const d = await r.json(); return { ...d, isReal:true }; // { usd, changePct, cedearArs, volumeArsM }
    });
  },
  async getCandles(ticker, tf='1day', n=150){
    return cached(`c:${ticker}:${tf}:${n}`, CACHE_TTL_MS, async () => {
      const r = await fetch(`${API_BASE}/candles?symbol=${encodeURIComponent(ticker)}&interval=${tf}&outputsize=${n}`);
      if(!r.ok) throw new Error('candles '+r.status);
      const d = await r.json(); return { ...d, isReal:true }; // { o,h,l,c,v }
    });
  }
};

/* ═══════════════════ fachada con fallback seguro ═══════════════════ */
const impl = MODE === 'live' ? Live : Mock;
async function withFallback(name, args){
  try { return await impl[name](...args); }
  catch (e) { console.warn(`[dataSource] live ${name} falló, usando mock:`, e.message); return Mock[name](...args); }
}
export const getCCL     = ()                 => withFallback('getCCL', []);
export const getQuote   = (t)                => withFallback('getQuote', [t]);
export const getCandles = (t, tf, n)         => withFallback('getCandles', [t, tf, n]);
export const isLive = () => MODE === 'live';

/* Mapa de intervalos del front -> proveedor (Twelve Data). Ajustar según API. */
export const TF_MAP = { '5m':'5min','15m':'15min','1h':'1h','4h':'4h','1d':'1day','1w':'1week','1mo':'1month' };
