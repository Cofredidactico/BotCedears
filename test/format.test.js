import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtUsd, fmtArs, fmtPct, fmtNum, esc, withAlpha, clampNum } from '../format.js';

test('fmtUsd: decimales bajo 1000, sin decimales arriba', () => {
  assert.equal(fmtUsd(12.5), '$12.50');
  assert.equal(fmtUsd(2500), 'US$2,500');
  assert.equal(fmtUsd(null), 'N/D');
  assert.equal(fmtUsd(NaN), 'N/D');
});

test('fmtPct: signo explícito y N/D', () => {
  assert.equal(fmtPct(3.14), '+3.1%');
  assert.equal(fmtPct(-2), '-2.0%');
  assert.equal(fmtPct(0), '+0.0%');
  assert.equal(fmtPct(null), 'N/D');
});

test('fmtArs redondea y usa separador es-AR', () => {
  assert.equal(fmtArs(1234.7), 'AR$1.235');
  assert.equal(fmtArs(null), 'N/D');
});

test('fmtNum respeta los decimales pedidos', () => {
  assert.equal(fmtNum(3.14159, 2), '3.14');
  assert.equal(fmtNum(1, 0), '1');
  assert.equal(fmtNum(undefined), 'N/D');
});

test('esc neutraliza los caracteres peligrosos de HTML', () => {
  assert.equal(esc('<b>"a"&\'x\'</b>'), '&lt;b&gt;&quot;a&quot;&amp;&#39;x&#39;&lt;/b&gt;');
  assert.equal(esc(null), '');
});

test('withAlpha inyecta el canal alpha en un oklch', () => {
  assert.equal(withAlpha('oklch(0.7 0.1 250)', 0.4), 'oklch(0.7 0.1 250 / 0.4)');
});

test('clampNum acota al rango', () => {
  assert.equal(clampNum(5, 0, 10), 5);
  assert.equal(clampNum(-3, 0, 10), 0);
  assert.equal(clampNum(99, 0, 10), 10);
});
