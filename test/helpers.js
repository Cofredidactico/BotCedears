// Generador de velas sintéticas determinísticas para los tests del motor.
// Devuelve el mismo shape que consume computeTechnical/computeScore: {o,h,l,c,v,t}.
export function makeCandles(n = 260, { start = 100, slope = 0.5, noise = 0 } = {}) {
  const o = [], h = [], l = [], c = [], v = [], t = [];
  let prev = start;
  for (let i = 0; i < n; i++) {
    const base = start + slope * i + (noise ? Math.sin(i / 5) * noise : 0);
    const close = Math.max(1, base);
    o.push(prev);
    c.push(close);
    h.push(Math.max(prev, close) * 1.01);
    l.push(Math.min(prev, close) * 0.99);
    v.push(1_000_000);
    t.push(1_600_000_000 + i * 86400);
    prev = close;
  }
  return { o, h, l, c, v, t };
}
