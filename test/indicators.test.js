import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ema, sma, rsi, atr, macd, bollinger, obv, computeTechnical } from '../indicators.js';
import { makeCandles } from './helpers.js';

test('ema de una serie constante = la constante', () => {
  assert.equal(ema([5, 5, 5, 5], 3).at(-1), 5);
});

test('sma calcula la media móvil de la ventana', () => {
  const out = sma([1, 2, 3, 4], 2);
  assert.ok(Number.isNaN(out[0]));
  assert.equal(out[1], 1.5);
  assert.equal(out[2], 2.5);
  assert.equal(out[3], 3.5);
});

test('rsi = 100 en una serie estrictamente creciente (sin pérdidas)', () => {
  const closes = Array.from({ length: 30 }, (_, i) => i + 1);
  assert.equal(rsi(closes, 14).at(-1), 100);
});

test('rsi tiende a 0 en una serie estrictamente decreciente', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 30 - i);
  assert.ok(rsi(closes, 14).at(-1) <= 1);
});

test('rsi devuelve NaN mientras no hay suficientes datos', () => {
  assert.ok(Number.isNaN(rsi([1, 2, 3], 14).at(-1)));
});

test('atr de un rango constante converge a ese rango', () => {
  const n = 60;
  const highs = Array(n).fill(10), lows = Array(n).fill(8), closes = Array(n).fill(9);
  assert.ok(Math.abs(atr(highs, lows, closes, 14).at(-1) - 2) < 1e-9);
});

test('macd devuelve tres líneas del mismo largo que los cierres', () => {
  const closes = makeCandles(60).c;
  const m = macd(closes);
  assert.equal(m.macdLine.length, closes.length);
  assert.equal(m.signalLine.length, closes.length);
  assert.equal(m.hist.length, closes.length);
});

test('bollinger: la banda media coincide con la sma del período', () => {
  const closes = makeCandles(40).c;
  const bb = bollinger(closes, 20, 2);
  const s = sma(closes, 20);
  assert.ok(Math.abs(bb.mid.at(-1) - s.at(-1)) < 1e-9);
  assert.ok(bb.upper.at(-1) >= bb.mid.at(-1));
  assert.ok(bb.lower.at(-1) <= bb.mid.at(-1));
});

test('obv devuelve una serie numérica del mismo largo', () => {
  const o = obv([10, 11, 10, 12], [100, 200, 50, 300]);
  assert.equal(o.length, 4);
  assert.ok(o.every(x => typeof x === 'number'));
});

test('computeTechnical detecta alineación alcista en una tendencia clara', () => {
  const t = computeTechnical(makeCandles(260, { slope: 0.6 }));
  assert.ok(t.price > 0);
  assert.equal(t.bullishAlign, true);
  assert.equal(t.bearishAlign, false);
  assert.ok(t.rsi >= 0 && t.rsi <= 100);
  assert.ok(typeof t.support === 'number' && typeof t.resistance === 'number');
});

test('computeTechnical detecta alineación bajista en una caída clara', () => {
  const t = computeTechnical(makeCandles(260, { start: 260, slope: -0.6 }));
  assert.equal(t.bearishAlign, true);
  assert.equal(t.bullishAlign, false);
});
