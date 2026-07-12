# Investment Copilot AI

Dashboard de análisis de activos (acciones, CEDEARs, ETFs y cripto) con score
compuesto 0-100, análisis técnico y fundamental, contexto macro, noticias y
plan operativo (compra/venta/stop/take-profit), calculado en el momento a
partir de datos de mercado reales.

Sitio estático (`index.html` + `app.js` + módulos) desplegable en Vercel sin
build step, con un puñado de funciones serverless en `/api` que ocultan las
API keys.

## Cómo está armado

```
index.html         shell de la página
styles.css          diseño (fiel al prototipo original)
app.js              buscador, estado, fetch + render del informe
indicators.js        motor de indicadores técnicos (EMA, RSI, MACD, ADX, ATR,
                     Bollinger, OBV, soporte/resistencia, Fibonacci, estructura)
scoring.js           score compuesto 0-100 + plan operativo, a partir de datos reales
dataSource.js         única capa que habla con /api/* — el resto del código no
                     sabe de dónde vienen los datos
universe.json         universo de activos buscables (ticker, nombre, sector,
                     ratio de CEDEAR, categoría)
macro.json            snapshot manual de datos macro (ver "Límites" abajo)
api/quote.js           cotización (Finnhub) + CCL (dolarapi)
api/candles.js          OHLCV histórico (Twelve Data)
api/ccl.js               dólar CCL (dolarapi)
api/fundamentals.js       fundamentales (Finnhub stock/metric)
api/news.js               noticias + sentimiento (Finnhub company-news + news-sentiment)
```

Cripto (BTC, ETH) se resuelve directo contra CoinGecko desde el navegador
(API pública, no necesita key).

## Deploy en Vercel

Como el proyecto ya está conectado a Vercel, alcanza con:

1. **Cargar las API keys** en el proyecto de Vercel: *Settings → Environment
   Variables*.
   - `FINNHUB_KEY` — cotizaciones, fundamentales y noticias. Cuenta gratis en
     [finnhub.io](https://finnhub.io/register).
   - `ALPACA_KEY_ID` y `ALPACA_SECRET_KEY` — velas OHLCV para los indicadores
     técnicos (fuente **primaria**, reemplaza a Twelve Data). Cuenta gratis en
     [alpaca.markets](https://alpaca.markets/data): registrarse, crear una
     cuenta de paper trading (no hace falta fondearla ni una cuenta real para
     esto) y generar las API keys desde el dashboard (botón "API Keys" en la
     barra lateral). El plan Basic (gratis, feed IEX) da **200 requests/min**
     compartidos entre todo el sitio — muy por encima del límite anterior de
     Twelve Data (8 req/min), que era lo que impedía tener más de un puñado
     de activos en vivo a la vez en el Dashboard. Al ser feed IEX (no la
     cinta consolidada), el precio puede diferir levemente de otras fuentes
     — es una diferencia esperada, no un error.
   - `TWELVEDATA_KEY` — velas OHLCV, ahora como **respaldo automático** si
     `ALPACA_KEY_ID`/`ALPACA_SECRET_KEY` no están configuradas todavía (así
     no se rompe nada mientras se da de alta la cuenta de Alpaca). Cuenta
     gratis en [twelvedata.com](https://twelvedata.com/pricing).
   - Marcalas para **Production** (y Preview si querés probar en cada PR).
2. Hacer **Redeploy** después de cargar las keys (Vercel no las inyecta en
   builds ya corridos).
3. Listo — cada push a la rama conectada dispara un deploy automático.

Sin las keys configuradas, la app sigue funcionando pero cae a datos de
demostración (`isReal:false`) y el banner de conexión muestra "Sin conexión
al proveedor de datos".

### Probar en local sin keys

Abrir `index.html` con cualquier servidor estático (ej. `npx serve .`) y
agregar `?mode=mock` a la URL para forzar datos simulados sin pegarle a
`/api/*` (útil para ver el diseño sin tener las keys a mano).

## Límites conocidos del MVP (léase antes de operar con esto)

Este proyecto calcula todo con datos reales donde pudo conectar una fuente
gratuita/accesible. Lo que **no** está cubierto todavía:

- **Macro** (`macro.json`) es un snapshot cargado a mano, no un feed en vivo.
  Actualizarlo periódicamente (o cablear FRED/Trading Economics más
  adelante) — la sección Macro y el sub-score de Macro/Sentimiento van a
  quedar desactualizados si no se toca este archivo.
- **Fundamentales** dependen de la cobertura de Finnhub free tier, que es
  irregular para ADRs/CEDEARs de menor liquidez (ej. algunas acciones
  argentinas). Cuando falta el dato, se muestra "sin datos" en vez de
  inventar un número, y el score redistribuye ese peso entre las categorías
  disponibles.
- **Noticias**: los titulares vienen de Finnhub `company-news`, pero el tag
  de sentimiento por titular (Positiva/Negativa/etc.) es un heurístico de
  palabras clave, no un clasificador de IA. El score de "Noticias" sí usa el
  `news-sentiment` agregado real de Finnhub.
- **Cripto**: CoinGecko free tier no da volumen en el endpoint de OHLC
  gratuito, así que OBV/VWAP/Liquidez quedan en "N/D" para BTC/ETH en vez de
  simularse.
- **Plan operativo**: zona de compra/venta, stop y take-profits se derivan
  algorítmicamente de soporte/resistencia + ATR, con probabilidad estimada
  como una función simple del score. No es un backtest ni una probabilidad
  estadísticamente validada — es una heurística, tratada como tal en todo el
  copy de la UI.

Nada de esto es asesoramiento financiero. Ver el disclaimer en el footer de
la app.
