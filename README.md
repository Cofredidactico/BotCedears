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
   - `ANTHROPIC_API_KEY` — habilita el **Asistente IA** (botón flotante de
     chat, abajo a la derecha). Cuenta en
     [console.anthropic.com](https://console.anthropic.com/) → *API Keys*.
     Es un servicio pago por uso (no tiene tier gratuito) — se cobra por
     token de entrada/salida según el modelo usado. Sin esta key, el botón
     del asistente sigue visible pero responde con un aviso de "no
     configurado" en vez de romper el resto del sitio.
   - `ANTHROPIC_MODEL` (opcional) — modelo a usar, default `claude-opus-4-8`
     (el más capaz, también el más caro). Para bajar costo sin tocar código,
     se puede poner `claude-sonnet-5` (más barato, buena calidad) o
     `claude-haiku-4-5` (el más económico) — ver precios por token en
     [anthropic.com/pricing](https://www.anthropic.com/pricing).
   - `KV_REST_API_URL` y `KV_REST_API_TOKEN` — base de datos Redis (Upstash,
     tier gratis) donde se guardan las suscripciones de **Alertas por
     Telegram** (qué chat_id sigue qué ticker). Es lo único con estado que
     necesita sobrevivir entre corridas del cron, ya que todo lo demás del
     sitio vive en `localStorage` del navegador. Se crea desde Vercel:
     *Storage → Create Database → Upstash for Redis* (o directo en
     [upstash.com](https://upstash.com), plan gratis) — al conectarlo desde
     la pestaña Storage del proyecto, Vercel carga estas dos env vars solo.
   - `TELEGRAM_BOT_TOKEN` y `TELEGRAM_BOT_USERNAME` — bot de Telegram para
     mandar las alertas. Gratis: hablale a
     [@BotFather](https://t.me/BotFather) en Telegram, `/newbot`, elegí un
     nombre y un @username (terminado en `bot`) — te da el token. Cargar el
     token en `TELEGRAM_BOT_TOKEN` y el @username (sin arroba) en
     `TELEGRAM_BOT_USERNAME`.
   - `TELEGRAM_WEBHOOK_SECRET` (opcional pero recomendado) — string
     cualquiera inventado por vos, evita que cualquiera pueda pegarle al
     endpoint del webhook haciéndose pasar por Telegram.
   - `CRON_SECRET` — string inventado por vos, protege `/api/check-alerts`
     (el endpoint que dispara las alertas) para que solo lo pueda llamar el
     cron externo que lo conoce.
   - Marcalas para **Production** (y Preview si querés probar en cada PR).
2. Hacer **Redeploy** después de cargar las keys (Vercel no las inyecta en
   builds ya corridos).
3. Listo — cada push a la rama conectada dispara un deploy automático.

Sin las keys configuradas, la app sigue funcionando pero cae a datos de
demostración (`isReal:false`) y el banner de conexión muestra "Sin conexión
al proveedor de datos". Lo mismo para el Asistente IA y las Alertas por
Telegram: si faltan sus keys, esas funciones muestran un aviso de "no
configurado" en vez de romper el resto del sitio.

### Terminar de activar las Alertas por Telegram (dos pasos únicos, no por deploy)

Con `KV_REST_API_URL`/`KV_REST_API_TOKEN`/`TELEGRAM_BOT_TOKEN`/
`TELEGRAM_BOT_USERNAME` ya cargadas y deployadas, faltan dos configuraciones
que se hacen una sola vez (no dependen del código, así que no hace falta
repetirlas en cada deploy):

1. **Registrar el webhook del bot** — le dice a Telegram a qué URL mandar los
   mensajes que le escriban al bot. Reemplazando `<TOKEN>`, `<TU-DOMINIO>` y
   (si la cargaste) `<WEBHOOK_SECRET>`:
   ```
   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<TU-DOMINIO>/api/telegram-webhook&secret_token=<WEBHOOK_SECRET>
   ```
   Pegar esa URL en el navegador una vez alcanza — Telegram confirma con
   `{"ok":true,"result":true}`.
2. **Dar de alta el cron externo** que revisa las alertas — en
   [cron-job.org](https://cron-job.org) (gratis, sin tarjeta): crear una
   cuenta, nuevo cronjob apuntando a
   `https://<TU-DOMINIO>/api/check-alerts?secret=<CRON_SECRET>`, cada 5-15
   minutos. Cada corrida solo pega a `/api/quote` y `/api/candles` por los
   tickers que alguien haya suscripto (no todo el universo), así que no
   consume la cuota del proveedor de datos de la nada.

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

- **Asistente IA**: responde solo con datos ya calculados por la plataforma
  (score, plan operativo, técnico, fundamentales, macro) que se le pasan
  como contexto en cada pregunta — no tiene memoria de conversaciones
  anteriores (cada pregunta es un request nuevo) ni acceso a nada fuera de
  ese contexto. Si preguntás algo que la plataforma no calculó, debería
  decir que no tiene ese dato en vez de inventarlo; si eso llegara a fallar,
  reportarlo.

Nada de esto es asesoramiento financiero. Ver el disclaimer en el footer de
la app.
