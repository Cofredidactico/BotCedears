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
     **Importante**: según cómo se conecte la base, Vercel puede llamar a
     este mismo par de credenciales `KV_REST_API_URL`/`KV_REST_API_TOKEN`
     (producto "Vercel KV" clásico) **o** `UPSTASH_REDIS_REST_URL`/
     `UPSTASH_REDIS_REST_TOKEN` (integración nativa de Upstash del
     Marketplace) — el código acepta cualquiera de los dos pares, no hace
     falta elegir uno en particular. Lo que **no** sirve es una variable
     `REDIS_URL` sola (es una connection string para clientes TCP tipo
     `ioredis`, no las credenciales REST que usa este proyecto) — si solo
     ves esa, hay que conectar la base de nuevo eligiendo la opción que
     exponga las credenciales REST.
   - `TELEGRAM_BOT_TOKEN` y `TELEGRAM_BOT_USERNAME` — bot de Telegram para
     mandar las alertas. Gratis: hablale a
     [@BotFather](https://t.me/BotFather) en Telegram, `/newbot`, elegí un
     nombre y un @username (terminado en `bot`) — te da el token. Cargar el
     token en `TELEGRAM_BOT_TOKEN` y el @username (sin arroba) en
     `TELEGRAM_BOT_USERNAME`.
   - `TELEGRAM_WEBHOOK_SECRET` (opcional pero recomendado) — string
     cualquiera inventado por vos, evita que cualquiera pueda pegarle al
     endpoint del webhook haciéndose pasar por Telegram.
   - `CRON_SECRET` — string inventado por vos, protege la acción `check` de
     `/api/alerts` (la que dispara las alertas) para que solo lo pueda
     llamar el cron externo que lo conoce.
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
   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<TU-DOMINIO>/api/alerts?action=webhook&secret_token=<WEBHOOK_SECRET>
   ```
   Pegar esa URL en el navegador una vez alcanza — Telegram confirma con
   `{"ok":true,"result":true}`.
2. **Dar de alta el cron externo** que revisa las alertas — en
   [cron-job.org](https://cron-job.org) (gratis, sin tarjeta): crear una
   cuenta, nuevo cronjob apuntando a
   `https://<TU-DOMINIO>/api/alerts?action=check&secret=<CRON_SECRET>`, cada
   5-15 minutos. Cada corrida solo pega a `/api/quote` y `/api/candles` por
   los tickers que alguien haya suscripto (no todo el universo), así que no
   consume la cuota del proveedor de datos de la nada.
   
   Nota: todos los endpoints de Alertas por Telegram (webhook, vinculación,
   suscripciones y el chequeo del cron) viven en un solo archivo,
   `/api/alerts.js`, enrutado por `?action=` — el plan Hobby de Vercel
   limita los deployments a 12 funciones serverless, así que se agruparon
   en vez de tener un archivo por endpoint.

### Probar en local sin keys

Abrir `index.html` con cualquier servidor estático (ej. `npx serve .`) y
agregar `?mode=mock` a la URL para forzar datos simulados sin pegarle a
`/api/*` (útil para ver el diseño sin tener las keys a mano).

## Mejoras de precisión del motor técnico (timing de compra/venta)

Sobre el motor de indicadores/score original se agregaron 5 refinamientos
orientados a afinar el momento de entrada/salida, todos calculados sobre
datos reales ya obtenidos (sin pedidos extra al proveedor):

- **Fuerza Relativa (Mansfield/IBD) vs. SPY** (`indicators.js:relativeStrength`) —
  el ratio precio/benchmark, no el precio solo: un activo puede subir y
  seguir "perdiéndole" al mercado. Un máximo de fuerza relativa es señal de
  liderazgo real. Solo se calcula en la ficha del activo (no en las señales
  livianas del Dashboard/Watchlist, para no multiplicar requests).
- **Volume Profile / POC** (`indicators.js:volumeProfile`) — punto de mayor
  volumen operado sobre la ventana reciente; se usa para afinar soporte/
  resistencia del plan operativo cuando queda más cerca del precio que el
  swing high/low crudo (nunca lo aleja).
- **Confluencia multi-timeframe extendida** (`indicators.js:weeklyConfluence`) —
  antes solo comparaba alineación de EMAs entre diario y semanal; ahora
  también RSI y MACD, con un bonus graduado según cuántas de las 3
  confirmaciones coinciden (en vez de un simple sí/no).
- **Stop dinámico (Chandelier Exit)** (`indicators.js:chandelierExit`) —
  trailing stop que sube con nuevos máximos y nunca baja, para usar una vez
  adentro de la posición (complementa, no reemplaza, el stop fijo del plan
  operativo inicial).
- **Validación empírica de factores** (página Backtesting) — en vez de
  confiar ciegamente en los pesos fijos del score, mide sobre los mismos
  cortes históricos del backtest qué tan bien correlacionó cada sub-factor
  con el retorno real futuro, para ese activo puntual. No cambia los pesos
  del score en vivo (eso requeriría un estudio cruzado sobre muchos activos
  que esta plataforma no tiene) — es evidencia real y específica para juzgar
  cada factor, no un número inventado.

Segunda tanda de mejoras, mismo criterio (datos reales, nunca inventados):

- **Patrones de velas japonesas** (`indicators.js:detectCandlePattern`) —
  envolvente alcista/bajista, martillo, hombre colgado, estrella fugaz,
  martillo invertido, doji sobre la última vela — reglas determinísticas,
  no un clasificador de imágenes. Nudge chico en el sub-score de Momentum.
- **Estacionalidad mensual** (`indicators.js:monthlySeasonality`) — retorno
  promedio histórico por mes calendario, sobre historial extendido pedido
  aparte (no bloquea el render inicial). Se omite si hay menos de 2 años de
  datos — con un año no hay "estacionalidad", es un dato puntual.
- **Índice de Fuerza de Tendencia** (`indicators.js:trendStrengthIndex`) —
  combina ADX normalizado + pendiente de EMA200 en un único 0-100, más
  fácil de leer que mirar ADX suelto.
- **Squeeze de volatilidad** (`indicators.js:keltnerChannels` +
  `detectSqueeze`) — Bollinger dentro de Keltner (técnica TTM Squeeze):
  compresión de volatilidad que históricamente antecede a movimientos
  fuertes; se marca cuando está activo y cuando recién se libera.
- **Matriz de correlación de Watchlist** (página Watchlist) — correlación
  de retornos diarios entre pares de activos en seguimiento, reusando las
  series de cierre ya cacheadas (sin pedidos nuevos) — detecta
  diversificación falsa.
- **Heatmap sectorial** (Dashboard) — performance promedio del día por
  sector sobre el universo curado, reusando los datos ya cargados del
  Dashboard.
- **Historial de Alertas** (página Alertas) — log local (localStorage) de
  las últimas 50 alertas de navegador disparadas con la pestaña abierta.

## Mejoras visuales (densidad y layout tipo terminal profesional)

- **Sub-scores integrados en la card del gauge**: los 5 factores clave
  (Fundamental/Técnico/Momentum/Valoración/Riesgo) se movieron de una lista
  vertical en la card ejecutiva a una fila horizontal compacta debajo del
  gauge — la card "Composición del Score" más abajo se mantiene igual,
  porque tiene más detalle (los 9 factores completos, incluye Noticias/
  Macro/Sentimiento/Liquidez).
- **Más timeframes en el gráfico**: se agregaron 1M (velas mensuales), 1A y
  5A (presets de zoom sobre velas semanales/mensuales respectivamente —
  no existe una "vela de un año", así que son ventanas de tiempo, no
  intervalos nuevos).
- **EMA 200 en el gráfico principal** (ya se calculaba, no se dibujaba).
- **Riesgos y Catalizadores unificados** en una sola card de dos columnas,
  en vez de dos cards separadas lado a lado.
- **Densidad general reducida**: paddings, gaps y tamaños de fuente más
  chicos en cards, stat-cards y metric-rows para que entre más contenido
  sin scroll, sin romper el layout mobile.

## Precisión de las alertas de precio (confirmación multi-señal)

`detectPriceAlert` (scoring.js) dejó de disparar solo por nivel de precio —
ahora exige al menos una confirmación técnica y expone qué tan confiable fue
la lectura:

- **Confirmación multi-señal**: al entrar en zona de compra/venta, se chequea
  RSI (no sobrecomprado/sobrevendido), OBV (el volumen no contradice el
  movimiento), ausencia de divergencia opuesta activa y, cuando ya está
  calculada (ficha del activo), el sesgo semanal. Si ninguna confirma, no hay
  alerta — antes bastaba con tocar el nivel de precio.
- **Confianza (alta/media/baja)**: proporción de confirmaciones obtenidas
  sobre las aplicables en ese momento. El stop loss sigue siendo incondicional
  (gestión de riesgo no se filtra ni se retrasa).
- **Anti-whipsaw**: si el cierre anterior no estaba también en la zona, la
  alerta se marca "tentativa" (tocó la zona recién ahora) en vez de confirmada
  — reduce falsas alertas por una mecha de una sola vela.
- **Notificaciones (navegador y Telegram) solo para confianza alta/media** y
  no tentativas — el resto queda visible en la tarjeta pero no interrumpe.
  El Historial de Alertas y el Plan Operativo de la ficha muestran la
  confianza y qué confirmó cada alerta (tooltip con el detalle).
- **Alertas de ruptura de estructura (BOS/CHoCH)**: `structureChanged` en
  indicators.js detecta cuando la estructura de mercado (máximos/mínimos
  crecientes o decrecientes, ver `marketStructure`) cambia respecto a la
  última lectura, y dispara una notificación/entrada de historial aparte —
  una señal de giro de tendencia independiente de las zonas de precio. Por
  ahora es **solo navegador**, no está conectada al cron de Telegram.
- **Precisión histórica en Backtesting**: nueva tabla "Precisión histórica de
  las alertas de precio" corre el mismo `detectPriceAlert` sobre los cortes
  históricos del backtest y agrupa el retorno real hacia adelante por
  (tipo, confianza) — para verificar con datos si "confianza alta" fue, en
  los hechos, más precisa que "confianza baja".

## Portfolio Advisor profesional (mega-tanda)

La página de Portfolio pasó a ser una mesa de análisis de cartera completa.
Convención de unidades: si el costo se cargó en **ARS**, la cantidad son
**CEDEARs**; si se cargó en **USD**, son **acciones del subyacente** — el
ratio real del CEDEAR (universe.json) convierte entre ambas sin mezclar
unidades.

**Analítica de riesgo**
- **Aporte al riesgo por posición**: peso vs. porción de la varianza total
  que explica cada tenencia (descomposición estándar por covarianza).
- **Beta de la cartera vs SPY** + comparación de retorno total vs. "todo en
  SPY" sobre la misma ventana.
- **Estrés histórico**: peor semana (5 ruedas) y peor mes (21 ruedas) de la
  cartera con los pesos actuales.
- **Solapamiento**: pares de tenencias con correlación >0.8 (diversificación
  ilusoria), sumado a la Lectura de diversificación.
- **Salud de la cartera 0-100**: fórmula determinística y visible
  (concentración, sector, señales de venta, volatilidad, solapamiento).

**Operatoria**
- **Stop / objetivo por fila** con distancia al stop (rojo a ≤3%).
- **Rebalanceo sugerido** según el tope por posición del perfil de riesgo.
- **"¿Qué compro con estos pesos?"**: monto en AR$ → CEDEARs concretos entre
  tus posiciones con señal de compra, avisando si superás tu tope.
- **Registro de operaciones**: botón ⤓ por fila para registrar ventas (P&L
  realizado vs. no realizado, por moneda); las altas con costo se loguean
  como compras. Solo localStorage.

**Contexto argentino**
- **Cartera en dólares CCL y vs. IPC**: cada posición con fecha de compra se
  mide también en dólares reales (serie histórica del CCL, argentinadatos.com,
  fetch directo del navegador — sin nueva función de Vercel) y contra la
  inflación.
- **Dividendos agregados**: yield ponderado TTM e ingreso anual estimado con
  el historial real de pagos (sin predecir fechas futuras).

**Alertas y seguimiento**
- Las tenencias disparan las mismas notificaciones de navegador que la
  Watchlist (zona de compra/venta/stop + BOS/CHoCH) y muestran la alerta
  activa en su fila.
- **Resumen diario por Telegram**: con Telegram vinculado, el sitio sincroniza
  (ticker, cantidad, unidad) vía `?action=sync-portfolio` y el cron manda un
  digest diario (valor, variación ponderada del día, detalle por posición) —
  deduplicado por fecha en Redis.
- **Cambios de recomendación**: historial local de cuándo cada posición pasó
  de una recomendación a otra.

**UX**
- **Treemap** (tamaño = peso, color = P&L), **fila de totales**, **vista
  compacta** y **modo privacidad** (oculta montos absolutos, deja los %).

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
