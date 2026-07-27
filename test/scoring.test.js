import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeScore, computePlan, detectPriceAlert } from '../scoring.js';
import { computeTechnical } from '../indicators.js';
import { makeCandles } from './helpers.js';

const upCandles = makeCandles(260, { slope: 0.6 });
const downCandles = makeCandles(260, { start: 260, slope: -0.6 });
const upTech = computeTechnical(upCandles);
const downTech = computeTechnical(downCandles);

test('computeScore devuelve un score 0-100, etiqueta y desglose', () => {
  const r = computeScore({ technical: upTech, fundamentals: null, macro: {}, newsSentiment: null, candles: upCandles });
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.equal(typeof r.scoreLabel, 'string');
  assert.ok(Array.isArray(r.scoreBreakdown) && r.scoreBreakdown.length >= 6);
  assert.ok(r.coverageWeight <= r.fullWeight);
});

test('una tendencia alcista puntúa más que una bajista', () => {
  const up = computeScore({ technical: upTech, fundamentals: null, macro: {}, newsSentiment: null, candles: upCandles });
  const down = computeScore({ technical: downTech, fundamentals: null, macro: {}, newsSentiment: null, candles: downCandles });
  assert.ok(up.score > down.score, `up=${up.score} down=${down.score}`);
});

test('las categorías sin datos se excluyen y bajan el peso cubierto', () => {
  const r = computeScore({ technical: upTech, fundamentals: null, macro: {}, newsSentiment: null, candles: upCandles });
  // Sin fundamentales ni noticias ni macro, el peso cubierto es menor al total.
  assert.ok(r.coverageWeight < r.fullWeight);
});

test('computePlan: stop por debajo del precio, objetivo por encima, zona coherente', () => {
  const plan = computePlan(upTech, 70);
  assert.ok(plan.raw.stopLoss < upTech.price, 'stop < precio');
  assert.ok(plan.raw.tp1 > upTech.price, 'tp1 > precio');
  assert.ok(plan.raw.buyLow <= plan.raw.buyHigh, 'buyLow <= buyHigh');
  assert.ok(plan.raw.safeAtr > 0);
  assert.equal(typeof plan.stopLoss, 'string');
});

test('detectPriceAlert respeta el contrato (null u objeto con type)', () => {
  const a = detectPriceAlert(upTech.price, upTech, {});
  assert.ok(a === null || (a && typeof a.type === 'string'));
});

test('detectPriceAlert dispara stop cuando el precio rompe el soporte', () => {
  const a = detectPriceAlert(upTech.support - 5 * (upTech.atr || 1), upTech, {});
  assert.ok(a && a.type === 'stop');
});
