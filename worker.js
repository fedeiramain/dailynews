// =====================================================================
//  ARGENTINA DAILY — Cloudflare Worker
//  Endpoints:
//    GET /api/news      -> noticias por categoría (cache 10 min)
//    GET /api/markets   -> dólar, riesgo país, crypto, commodities, índices, ADRs (cache 2 min)
//    GET /api/briefing  -> resumen del día con Workers AI (opcional, binding "AI")
//    GET /api/clima     -> clima de Buenos Aires, Tucumán, Neuquén y Ushuaia (cache 15 min)
//    GET /api/deportes  -> próximos partidos: fútbol, tenis, golf y polo (cache 30 min)
//    GET /api/health
//    GET /            -> el diario (HTML con React)
// =====================================================================

const NEWS_TTL = 600;
// Ciudades del clima (podés agregar o sacar)
const CLIMA = [
  { ciudad: "Buenos Aires", lat: -34.61, lon: -58.38 },
  { ciudad: "Tucumán", lat: -26.82, lon: -65.22 },
  { ciudad: "Neuquén", lat: -38.95, lon: -68.06 },
  { ciudad: "Ushuaia", lat: -54.80, lon: -68.30 },
];
const MARKETS_TTL = 120;
const BRIEFING_TTL = 1800;
const MAX_PARALLEL = 6; // límite de conexiones simultáneas de Cloudflare

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

// ---------------------------------------------------------------------
//  CATEGORÍAS: se asignan por palabras clave (sin tildes, minúsculas)
// ---------------------------------------------------------------------
const CATEGORIES = {
  politica: {
    label: "Política",
    kw: /\bmilei\b|gobierno nacional|congreso|senado|diputad|casa rosada|kicillof|cristina kirchner|kirchner|peronis|libertad avanza|gobernador|eleccion|electoral|\bpaso\b|ministr|oposicion|bullrich|villarruel|karina milei|jefe de gabinete|decreto|\bdnu\b|legislatura/,
  },
  economia: {
    label: "Economía",
    kw: /inflacion|\bindec\b|\bbcra\b|banco central|\bfmi\b|caputo|reservas|tasas? de interes|economia|salari|jubilac|impuesto|recaudacion|deficit|superavit|\bpbi\b|actividad economica|\brigi\b|exportacion|importacion|consumo|desempleo|paritaria|tarifa/,
  },
  dolar: {
    label: "Dólar",
    kw: /\bdolar\b|dolar blue|\bblue\b|\bmep\b|\bccl\b|contado con liqui|brecha cambiaria|\bbrecha\b|tipo de cambio|cambiari|devaluac|compra de divisas|compr\w* (de )?dolares|vend\w* (de )?dolares/,
  },
  mercados: {
    label: "Bolsas y acciones",
    kw: /merval|\bacciones\b|\badrs?\b|\bbonos\b|riesgo pais|wall street|\bbolsas?\b|s&p|nasdaq|\bbyma\b|\bfed\b|reserva federal|mercados|inversores|cedear/,
  },
  crypto: {
    label: "Crypto",
    kw: /bitcoin|cripto|ethereum|\bbtc\b|\beth\b|blockchain|stablecoin|\busdt\b|binance|solana|token/,
  },
  energia: {
    label: "Petróleo y energía",
    kw: /petroleo|\bbrent\b|\bwti\b|\bopep\b|vaca muerta|\bypf\b|gas natural|\bgnl\b|combustible|\bnafta|energia|energetic|litio|mineria|oleoducto|gasoducto/,
  },
  geopolitica: {
    label: "Geopolítica",
    kw: /\btrump\b|estados unidos|\bee\.? ?uu\b|casa blanca|\bchina\b|xi jinping|\brusia\b|putin|union europea|mercosur|\bbrasil\b|\blula\b|\botan\b|aranceles|\bonu\b|\bg20\b|\bg7\b|venezuela|maduro|geopolit|diplomac|cancill|embajad|tratado|cumbre/,
  },
  conflictos: {
    label: "Conflictos y ataques",
    kw: /ataque|misil|guerra|bombarde|ucrania|\bisrael|\bgaza\b|hamas|\biran\b|hezbola|terroris|ofensiva|\bdrones?\b|militar|tropas|explosion|atentado|conflicto armado|invasion|cese al fuego|rehenes/,
  },
};

// ---------------------------------------------------------------------
//  FUENTES RSS (Google News e Infobae bloquean a Cloudflare)
//  front: true  -> sus notas también van a "Portadas"
//  hint         -> categoría fija para todas sus notas (secciones)
// ---------------------------------------------------------------------
const LN = (cat) => `https://www.lanacion.com.ar/arc/outboundfeeds/rss/category/${cat}/?outputType=xml`;

const FEEDS = [
  // Argentina — portadas
  { source: "La Nación", url: "https://www.lanacion.com.ar/arc/outboundfeeds/rss/?outputType=xml", front: true },
  { source: "Clarín", url: "https://www.clarin.com/rss/lo-ultimo/", front: true },
  { source: "Ámbito", url: "https://www.ambito.com/rss/pages/home.xml", front: true },
  { source: "El Cronista", url: "https://www.cronista.com/files/rss/news.xml", front: true },

  // Argentina — secciones
  { source: "La Nación", url: LN("politica"), hint: "politica" },
  { source: "La Nación", url: LN("economia"), hint: "economia" },
  { source: "La Nación", url: LN("el-mundo") },
  { source: "Clarín", url: "https://www.clarin.com/rss/politica/", hint: "politica" },
  { source: "Clarín", url: "https://www.clarin.com/rss/economia/", hint: "economia" },
  { source: "Clarín", url: "https://www.clarin.com/rss/mundo/" },
  { source: "Ámbito", url: "https://www.ambito.com/rss/pages/politica.xml", hint: "politica" },
  { source: "Ámbito", url: "https://www.ambito.com/rss/pages/economia.xml", hint: "economia" },
  { source: "Ámbito", url: "https://www.ambito.com/rss/pages/finanzas.xml", hint: "mercados" },

  // Internacional en español
  { source: "BBC Mundo", url: "https://feeds.bbci.co.uk/mundo/rss.xml" },
  { source: "DW", url: "https://rss.dw.com/xml/rss-sp-all" },
  { source: "France 24", url: "https://www.france24.com/es/rss" },
  { source: "El País", url: "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada" },

  // Crypto
  { source: "CriptoNoticias", url: "https://www.criptonoticias.com/feed/", hint: "crypto" },
];

// ---------------------------------------------------------------------
//  EXCLUSIONES: secciones y temas que NO querés ver
//  (agregá o sacá palabras separadas por | )
// ---------------------------------------------------------------------
// Por sección (parte de la dirección de la nota)
const EXCLUDE_URL = /\/(deportes?|futbol|automovilismo|tenis|rugby|policiales|seguridad|espectaculos|famosos|show|gente|lifestyle|moda|horoscopo|astrologia|recetas|cocina)\//i;
// Por palabras en el título (sin tildes, minúsculas)
const EXCLUDE_KW = /\bfutbol\b|seleccion argentina|\bmessi\b|\bboca juniors\b|\briver plate\b|formula 1|\bf1\b|copa libertadores|champions league|nations league|china suarez|wanda nara|tini stoessel|horoscopo|detuvieron|asesinad|homicidio|femicidio/;

// Categorías que pesan más para "Lo más importante"
const PRIORITY = ["politica", "economia", "dolar", "geopolitica", "conflictos", "mercados", "energia"];

// Símbolos de Yahoo Finance
const YAHOO = {
  indices: [
    { s: "ARGT", n: "MSCI Argentina" },
    { s: "^GSPC", n: "S&P 500" },
    { s: "^IXIC", n: "Nasdaq" },
    { s: "^BVSP", n: "Bovespa" },
  ],
  commodities: [
    { s: "BZ=F", n: "Brent" },
    { s: "CL=F", n: "WTI" },
    { s: "GC=F", n: "Oro" },
    { s: "ZS=F", n: "Soja" },
  ],
  adrs: [
    { s: "YPF", n: "YPF" },
    { s: "GGAL", n: "Galicia" },
    { s: "BMA", n: "Macro" },
    { s: "PAM", n: "Pampa" },
    { s: "VIST", n: "Vista" },
    { s: "MELI", n: "MercadoLibre" },
  ],
};

// =====================================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = env.ALLOWED_ORIGIN || "*";
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    try {
      switch (url.pathname) {
        case "/api/news":
          return cached(request, ctx, NEWS_TTL, origin, () => getNews(), (d) => d.total > 0);
        case "/api/markets":
          return cached(request, ctx, MARKETS_TTL, origin, () => getMarkets());
        case "/api/deportes":
          return cached(request, ctx, 1800, origin, () => getDeportes(), (d) => d.total > 0);
        case "/api/clima":
          return cached(request, ctx, 900, origin, () => getClima(), (d) => d.ciudades.length > 0);
        case "/api/briefing":
          if (!env.AI) return json({ error: "Workers AI no configurado" }, origin, 501);
          return cached(request, ctx, BRIEFING_TTL, origin, () => getBriefing(env), (d) => !!d.text);
        case "/":
        case "/index.html":
          return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        case "/api/health":
          return json({ ok: true, time: new Date().toISOString() }, origin);
        default:
          return json({ endpoints: ["/api/news", "/api/markets", "/api/briefing"] }, origin);
      }
    } catch (err) {
      return json({ error: String(err?.message || err) }, origin, 500);
    }
  },
};

// =====================================================================
//  CACHE / HTTP
// =====================================================================
async function cached(request, ctx, ttl, origin, producer, shouldCache = () => true) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) {
    const r = new Response(hit.body, hit);
    r.headers.set("X-Cache", "HIT");
    Object.entries(cors(origin)).forEach(([k, v]) => r.headers.set(k, v));
    return r;
  }
  const data = await producer();
  const ok = shouldCache(data);
  const res = json(data, origin, 200, {
    "Cache-Control": ok ? `public, max-age=${ttl}` : "no-store",
    "X-Cache": "MISS",
  });
  if (ok) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, origin, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors(origin), ...extra },
  });
}

async function fetchText(url, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/rss+xml, application/xml, text/xml, application/json, */*",
        "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
      },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e) {
    if (e.name === "AbortError") throw new Error("timeout");
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function fetchJSON(url, timeoutMs = 9000) {
  return JSON.parse(await fetchText(url, timeoutMs));
}

// Ejecuta tareas de a "limit" por vez
async function runPool(tasks, limit = MAX_PARALLEL) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// =====================================================================
//  NOTICIAS
// =====================================================================
function classify(it, feed) {
  const text = norm(`${it.title} ${it.summary}`);
  const cats = new Set();
  if (feed.hint) cats.add(feed.hint);
  for (const [k, cfg] of Object.entries(CATEGORIES)) if (cfg.kw.test(text)) cats.add(k);
  if (feed.front) cats.add("portadas");
  return [...cats];
}

async function getNews() {
  const tasks = FEEDS.map((f) => async () => {
    const name = `${f.source}${f.hint ? " (" + f.hint + ")" : ""}`;
    try {
      const xml = await fetchText(f.url);
      const items = parseRSS(xml, f.source)
        .filter((it) => !EXCLUDE_URL.test(it.link) && !EXCLUDE_KW.test(norm(it.title)))
        .map((it) => ({ ...it, categories: classify(it, f) }));
      return { name, items, error: items.length ? null : "0 items" };
    } catch (e) {
      return { name, items: [], error: e.message };
    }
  });

  const results = await runPool(tasks);

  // Deduplicar por título; juntar categorías
  const map = new Map();
  for (const it of results.flatMap((r) => r.items)) {
    const k = normTitle(it.title);
    if (!k) continue;
    const prev = map.get(k);
    if (prev) {
      it.categories.forEach((c) => { if (!prev.categories.includes(c)) prev.categories.push(c); });
      if (!prev.image && it.image) prev.image = it.image;
      if (!prev.summary && it.summary) prev.summary = it.summary;
    } else {
      map.set(k, { ...it });
    }
  }

  const cutoff = Date.now() - 36 * 3600 * 1000;
  const items = [...map.values()]
    // Solo notas con al menos un tema (Política, Economía, Dólar, etc.): las que solo son "portada" no entran
    .filter((it) => it.categories.some((c) => c !== "portadas") && (!it.ts || it.ts > cutoff))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));

  // score = cantidad de categorías importantes que toca
  items.forEach((it) => { it.score = it.categories.filter((c) => PRIORITY.includes(c)).length; });

  const byCategory = {};
  for (const cat of [...Object.keys(CATEGORIES), "portadas"]) {
    byCategory[cat] = items.filter((it) => it.categories.includes(cat)).slice(0, 40);
  }

  // Lo más importante: últimas 12 h, temas prioritarios, máx. 2 por medio
  const recent = Date.now() - 12 * 3600 * 1000;
  const perSource = {};
  const highlights = items
    .filter((it) => (it.ts || 0) > recent && it.score > 0)
    .sort((a, b) => b.score - a.score || (b.ts || 0) - (a.ts || 0))
    .filter((it) => {
      perSource[it.source] = (perSource[it.source] || 0) + 1;
      return perSource[it.source] <= 2;
    })
    .slice(0, 8);

  return {
    updated: new Date().toISOString(),
    categories: {
      ...Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])),
      portadas: "Portadas",
    },
    highlights,
    byCategory,
    total: items.length,
    // Estado de cada fuente (para diagnosticar)
    debug: results.map((r) => ({ source: r.name, items: r.items.length, error: r.error })),
  };
}

function parseRSS(xml, source) {
  const out = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/g) || [];
  for (const b of blocks.slice(0, 30)) {
    const raw = (tag) => {
      const m = b.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return m ? m[1] : "";
    };
    const title = clean(raw("title"));
    let link = clean(raw("link"));
    if (!link) {
      const m = b.match(/<link[^>]*href="([^"]+)"/i);
      if (m) link = m[1];
    }
    const descRaw = unCDATA(raw("description") || raw("summary") || raw("content:encoded"));
    const pub = clean(raw("pubDate") || raw("published") || raw("updated") || raw("dc:date"));

    let image = "";
    const img =
      b.match(/<media:content[^>]*url="([^"]+)"/i) ||
      b.match(/<media:thumbnail[^>]*url="([^"]+)"/i) ||
      b.match(/<enclosure[^>]*url="([^"]+\.(?:jpe?g|png|webp)[^"]*)"/i) ||
      decodeEntities(descRaw).match(/<img[^>]*src="([^"]+)"/i);
    if (img) image = decodeEntities(img[1]);

    let summary = clean(descRaw);
    if (summary.length > 260) summary = summary.slice(0, 257) + "…";

    const ts = pub ? Date.parse(pub) || 0 : 0;
    if (title && link) out.push({ title, link, source, summary, image, ts });
  }
  return out;
}

function unCDATA(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function clean(s) {
  return decodeEntities(unCDATA(s || ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function norm(t) {
  return (t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function normTitle(t) {
  return norm(t)
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

// =====================================================================
//  MERCADOS
// =====================================================================
async function getMarkets() {
  const [dolares, riesgo, crypto, indices, commodities, adrs, histBlue, histCcl, reservas, elecciones] = await Promise.all([
    getDolares().catch(() => []),
    getRiesgoPais().catch(() => null),
    getCrypto().catch(() => []),
    yahooMany(YAHOO.indices),
    yahooMany(YAHOO.commodities),
    yahooMany(YAHOO.adrs),
    getDolarHist("blue").catch(() => []),
    getDolarHist("contadoconliqui").catch(() => []),
    getReservas().catch(() => null),
    getElecciones().catch(() => null),
  ]);

  // Blue y CCL con variación diaria y mensual
  const foco = {
    blue: dolarConVariacion(dolares.find((d) => d.id === "blue"), histBlue),
    ccl: dolarConVariacion(dolares.find((d) => d.id === "contadoconliqui"), histCcl),
    reservas,
    elecciones,
  };

  // Precio en pesos de las crypto con el dólar cripto, si falta
  const dc = dolares.find((d) => d.id === "cripto");
  if (dc) crypto.forEach((c) => { if (c.ars == null && c.usd != null) c.ars = c.usd * dc.venta; });

  return { updated: new Date().toISOString(), foco, dolares, riesgoPais: riesgo, crypto, indices, commodities, adrs };
}

// Fecha de hoy en Argentina (YYYY-MM-DD)
function hoyAR(offsetDias = 0) {
  return new Date(Date.now() - 3 * 3600 * 1000 - offsetDias * 86400 * 1000).toISOString().slice(0, 10);
}

// Historial diario de un dólar (ArgentinaDatos)
async function getDolarHist(casa) {
  const d = await fetchJSON(`https://api.argentinadatos.com/v1/cotizaciones/dolares/${casa}`);
  return d
    .filter((x) => x.fecha && x.venta != null)
    .sort((a, b) => (a.fecha < b.fecha ? -1 : 1))
    .slice(-60);
}

function dolarConVariacion(actual, hist) {
  if (!actual && !hist.length) return null;
  const hoy = hoyAR();
  const venta = actual?.venta ?? hist[hist.length - 1]?.venta;
  const compra = actual?.compra ?? hist[hist.length - 1]?.compra;
  const previos = hist.filter((x) => x.fecha < hoy);
  const prev = previos[previos.length - 1]?.venta ?? null;
  const mesAtras = hist.filter((x) => x.fecha <= hoyAR(30));
  const prevMes = mesAtras[mesAtras.length - 1]?.venta ?? null;
  const spark = previos.slice(-29).map((x) => x.venta).concat(venta != null ? [venta] : []);
  return {
    venta,
    compra,
    prev,
    changeDay: prev ? (venta / prev - 1) * 100 : null,
    changeMonth: prevMes ? (venta / prevMes - 1) * 100 : null,
    spark,
  };
}

// Reservas internacionales del BCRA (millones de USD)
async function getReservas() {
  const url = `https://api.bcra.gob.ar/estadisticas/v4.0/monetarias/1?desde=${hoyAR(45)}&hasta=${hoyAR()}&limit=100`;
  const d = await fetchJSON(url);
  const det = (d?.results?.[0]?.detalle || [])
    .filter((x) => x.fecha && x.valor != null)
    .sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
  if (!det.length) return null;
  const last = det[det.length - 1];
  const prev = det[det.length - 2] || null;
  const mes = det.filter((x) => x.fecha <= hoyAR(30)).pop() || det[0];
  return {
    value: last.valor,
    date: last.fecha,
    changeDay: prev ? last.valor - prev.valor : null,
    changeMonth: mes ? last.valor - mes.valor : null,
    spark: det.map((x) => x.valor),
  };
}

// ---------------------------------------------------------------------
//  ELECCIONES 2027 — probabilidades del mercado de predicciones Polymarket
//  (mismo mercado que usa la app de acciones). NO es una encuesta.
// ---------------------------------------------------------------------
// Dirigentes que se cuentan como oficialismo (editable)
const OFICIALISMO = /milei|bullrich|karina|francos|adorni|caputo|menem|petri|libertad avanza/i;

async function getElecciones() {
  let markets = [];
  for (const slug of ["argentina-presidential-election-winner", "argentina-presidential-election-winner-2027"]) {
    const ev = await fetchJSON("https://gamma-api.polymarket.com/events?slug=" + slug).catch(() => []);
    if (ev && ev[0] && ev[0].markets && ev[0].markets.length) { markets = ev[0].markets; break; }
  }
  const cands = markets
    .filter((m) => !m.closed)
    .map((m) => {
      let p = null;
      try { p = +JSON.parse(m.outcomePrices)[0]; } catch (e) {}
      const name = m.groupItemTitle || String(m.question || "").replace(/^Will\s+/i, "").replace(/\s+win the .*$/i, "");
      return { name, p, d7: m.oneWeekPriceChange != null ? +m.oneWeekPriceChange : null, vol: +m.volume || 0 };
    })
    .filter((c) => c.p != null && c.p > 0.005 && !/^Person [A-Z]$/i.test(c.name))
    .sort((a, b) => b.p - a.p);
  if (!cands.length) return null;
  return {
    oficialismo: cands.find((c) => OFICIALISMO.test(c.name)) || null,
    oposicion: cands.find((c) => !OFICIALISMO.test(c.name)) || null,
    cands: cands.slice(0, 5),
    vol: Math.round(cands.reduce((t, c) => t + c.vol, 0)),
  };
}

async function getDolares() {
  const data = await fetchJSON("https://dolarapi.com/v1/dolares");
  return data.map((d) => ({
    id: d.casa,
    name: d.nombre,
    compra: d.compra,
    venta: d.venta,
    updated: d.fechaActualizacion,
  }));
}

async function getRiesgoPais() {
  const d = await fetchJSON("https://api.argentinadatos.com/v1/finanzas/indices/riesgo-pais/ultimo");
  return { value: d.valor, date: d.fecha };
}

async function getCrypto() {
  // 1) CoinGecko
  try {
    const ids = "bitcoin,ethereum,solana,tether,usd-coin";
    const d = await fetchJSON(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd,ars&include_24hr_change=true`
    );
    const names = { bitcoin: "BTC", ethereum: "ETH", solana: "SOL", tether: "USDT", "usd-coin": "USDC" };
    const out = Object.entries(names)
      .filter(([id]) => d[id])
      .map(([id, sym]) => ({ id, symbol: sym, usd: d[id].usd, ars: d[id].ars, change24h: d[id].usd_24h_change }));
    if (out.length) return out;
  } catch (e) {}

  // 2) Respaldo: Kraken (público, sin clave)
  const pairs = [
    ["bitcoin", "BTC", "XBTUSD"],
    ["ethereum", "ETH", "ETHUSD"],
    ["solana", "SOL", "SOLUSD"],
    ["tether", "USDT", "USDTZUSD"],
    ["usd-coin", "USDC", "USDCUSD"],
  ];
  const res = await runPool(
    pairs.map(([id, sym, pair]) => async () => {
      try {
        const d = await fetchJSON(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
        const t = Object.values(d.result || {})[0];
        if (!t) return null;
        const last = parseFloat(t.c[0]);
        const open = parseFloat(t.o);
        return { id, symbol: sym, usd: last, ars: null, change24h: open ? ((last - open) / open) * 100 : null };
      } catch (e) {
        return null;
      }
    })
  );
  return res.filter(Boolean);
}

async function yahooMany(list) {
  const res = await runPool(list.map((x) => () => yahooQuote(x.s, x.n).catch(() => null)), 3);
  return res.filter(Boolean);
}

async function yahooQuote(symbol, name) {
  const base = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const d = await fetchJSON(`${base}?range=1d&interval=15m`);
  const r = d?.chart?.result?.[0];
  if (!r) return null;
  const m = r.meta;
  let price = m.regularMarketPrice;
  let prev = m.chartPreviousClose ?? m.previousClose;
  let spark = (r.indicators?.quote?.[0]?.close || []).filter((v) => v != null).slice(-40);

  // Sin datos intradía (fin de semana, feriado): uso cierres diarios de 5 días
  if (!spark.length || prev === price) {
    try {
      const d5 = await fetchJSON(`${base}?range=5d&interval=1d`);
      const closes = (d5?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter((v) => v != null);
      if (closes.length >= 2) {
        price = closes[closes.length - 1];
        prev = closes[closes.length - 2];
        spark = closes;
      }
    } catch (e) {}
  }

  // Datos congelados: no lo muestro
  if (!spark.length && prev === price) return null;

  return {
    symbol,
    name,
    price,
    prev,
    change: prev ? ((price - prev) / prev) * 100 : null,
    currency: m.currency,
    spark,
  };
}

// =====================================================================
//  DEPORTES: solo próximos partidos (ESPN, sin notas ni fotos)
// =====================================================================
const FUTBOL = [
  { id: "arg.1", n: "Liga Profesional" },
  { id: "arg.copa", n: "Copa Argentina" },
  { id: "conmebol.libertadores", n: "Libertadores" },
  { id: "conmebol.sudamericana", n: "Sudamericana" },
  { id: "uefa.champions", n: "Champions League" },
  { id: "fifa.friendly", n: "Amistoso", soloArgentina: true },
];
const TENIS = [{ id: "atp", n: "ATP" }, { id: "wta", n: "WTA" }];
const GOLF = [{ id: "pga", n: "PGA Tour" }, { id: "eur", n: "DP World Tour" }, { id: "lpga", n: "LPGA" }];

// POLO (Triple Corona): no hay fuente automática. Se carga a mano (hora argentina).
// Los partidos que ya pasaron se ocultan solos. Cuando se conozcan los cruces, reemplazá
// los "a confirmar" por los equipos. Fuente: Prensa Polo / Asociación Argentina de Polo.
const POLO = [
  { fecha: "2026-11-18T14:00:00-03:00", partido: "Las Monjitas vs La Aguada", torneo: "133° Abierto de Palermo · Zona B", cancha: "" },
  { fecha: "2026-11-18T16:30:00-03:00", partido: "Ellerstina Indios Chapaleufú vs La Zeta Kazak", torneo: "133° Abierto de Palermo · Zona B", cancha: "" },
  { fecha: "2026-11-21T14:00:00-03:00", partido: "5ª fecha · cruces a confirmar", torneo: "133° Abierto de Palermo · Zona A", cancha: "" },
  { fecha: "2026-11-22T14:00:00-03:00", partido: "6ª fecha · cruces a confirmar", torneo: "133° Abierto de Palermo · Zona B", cancha: "" },
  { fecha: "2026-11-28T14:00:00-03:00", partido: "7ª fecha · cruces a confirmar", torneo: "133° Abierto de Palermo · Zona A", cancha: "" },
  { fecha: "2026-11-29T14:00:00-03:00", partido: "8ª fecha · cruces a confirmar", torneo: "133° Abierto de Palermo · Zona B", cancha: "" },
  { fecha: "2026-12-05T14:00:00-03:00", partido: "9ª fecha · cruces a confirmar", torneo: "133° Abierto de Palermo · Zona A", cancha: "" },
  { fecha: "2026-12-06T14:00:00-03:00", partido: "10ª fecha · cruces a confirmar", torneo: "133° Abierto de Palermo · Zona B", cancha: "" },
  { fecha: "2026-12-12T16:30:00-03:00", partido: "FINAL", torneo: "133° Abierto de Palermo", cancha: "Cancha 1 de Palermo" },
];

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const ESPN = (path) => `https://site.api.espn.com/apis/site/v2/sports/${path}`;

async function getDeportes() {
  const hoy = new Date(Date.now() - 3 * 3600 * 1000);
  const rango = `${ymd(hoy)}-${ymd(new Date(hoy.getTime() + 7 * 86400 * 1000))}`;
  const vivoOProximo = (st) => st === "pre" || st === "in";

  const tareas = [
    ...FUTBOL.map((l) => async () => {
      try {
        const d = await fetchJSON(ESPN(`soccer/${l.id}/scoreboard?dates=${rango}`));
        return (d.events || []).flatMap((e) => {
          const c = e.competitions?.[0] || {};
          const st = c.status?.type?.state || e.status?.type?.state;
          if (!vivoOProximo(st)) return [];
          const loc = c.competitors?.find((x) => x.homeAway === "home") || c.competitors?.[0];
          const vis = c.competitors?.find((x) => x.homeAway === "away") || c.competitors?.[1];
          const partido = `${loc?.team?.displayName || "?"} vs ${vis?.team?.displayName || "?"}`;
          if (l.soloArgentina && !/argentina/i.test(partido)) return [];
          return [{
            dep: "futbol", torneo: l.n, fecha: e.date, partido, estado: st,
            marcador: st === "in" ? `${loc?.score ?? ""}-${vis?.score ?? ""} · ${c.status?.type?.shortDetail || ""}` : "",
            lugar: c.venue?.fullName || "",
          }];
        });
      } catch (e) { return []; }
    }),
    ...TENIS.map((l) => async () => {
      try {
        const d = await fetchJSON(ESPN(`tennis/${l.id}/scoreboard`));
        const evs = d.events || d.leagues?.[0]?.events || [];
        return evs.flatMap((e) => (e.groupings || [])
          .filter((g) => /singles/i.test(g.grouping?.displayName || ""))
          .flatMap((g) => (g.competitions || []).flatMap((c) => {
            const st = c.status?.type?.state;
            if (!vivoOProximo(st)) return [];
            const nom = (x) => x?.athlete?.displayName || x?.roster?.displayName || "Por definir";
            return [{
              dep: "tenis", torneo: `${e.name}${c.round?.displayName ? " · " + c.round.displayName : ""}`,
              fecha: c.date || c.startDate, partido: `${nom(c.competitors?.[0])} vs ${nom(c.competitors?.[1])}`,
              estado: st, marcador: st === "in" ? "En juego" : "", lugar: l.n,
            }];
          })));
      } catch (e) { return []; }
    }),
    ...GOLF.map((l) => async () => {
      try {
        const d = await fetchJSON(ESPN(`golf/${l.id}/scoreboard`));
        return (d.events || []).flatMap((e) => {
          const st = e.status?.type?.state || e.competitions?.[0]?.status?.type?.state;
          if (!vivoOProximo(st)) return [];
          const ronda = e.competitions?.[0]?.status?.period;
          return [{
            dep: "golf", torneo: l.n, fecha: e.date, hasta: e.endDate, partido: e.name, estado: st,
            marcador: st === "in" && ronda ? `Ronda ${ronda}` : "", lugar: "",
          }];
        });
      } catch (e) { return []; }
    }),
  ];

  const res = (await runPool(tareas)).flat();
  const ahora = Date.now();
  const polo = POLO.filter((p) => Date.parse(p.fecha) > ahora - 3 * 3600 * 1000).map((p) => ({
    dep: "polo", torneo: p.torneo || "Polo", fecha: p.fecha, partido: p.partido, estado: "pre", marcador: "", lugar: p.cancha || "",
  }));

  const todos = [...res, ...polo].filter((x) => x.fecha).sort((a, b) => Date.parse(a.fecha) - Date.parse(b.fecha));
  const por = (dep, n) => todos.filter((x) => x.dep === dep).slice(0, n);
  return {
    updated: new Date().toISOString(),
    futbol: por("futbol", 15),
    tenis: por("tenis", 10),
    golf: por("golf", 6),
    polo: por("polo", 10),
    total: todos.length,
  };
}

// =====================================================================
//  CLIMA (Open-Meteo, gratis y sin clave)
// =====================================================================
const WMO = {
  0: ["☀️", "Despejado"], 1: ["🌤️", "Mayormente despejado"], 2: ["⛅", "Parcialmente nublado"], 3: ["☁️", "Nublado"],
  45: ["🌫️", "Niebla"], 48: ["🌫️", "Niebla"], 51: ["🌦️", "Llovizna"], 53: ["🌦️", "Llovizna"], 55: ["🌦️", "Llovizna intensa"],
  61: ["🌧️", "Lluvia débil"], 63: ["🌧️", "Lluvia"], 65: ["🌧️", "Lluvia fuerte"], 66: ["🌧️", "Lluvia helada"], 67: ["🌧️", "Lluvia helada"],
  71: ["🌨️", "Nieve"], 73: ["🌨️", "Nieve"], 75: ["🌨️", "Nieve fuerte"], 80: ["🌦️", "Chaparrones"], 81: ["🌧️", "Chaparrones"],
  82: ["⛈️", "Chaparrones fuertes"], 95: ["⛈️", "Tormenta"], 96: ["⛈️", "Tormenta con granizo"], 99: ["⛈️", "Tormenta con granizo"],
};
const wmo = (c) => WMO[c] || ["🌡️", "—"];

async function getClima() {
  const res = await Promise.all(CLIMA.map(async (c) => {
    try {
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}` +
        "&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code" +
        "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
        "&timezone=America%2FArgentina%2FBuenos_Aires&forecast_days=1";
      const d = await fetchJSON(url);
      const a = d.current || {};
      const dd = d.daily || {};
      if (a.temperature_2m == null) return null;
      return {
        ciudad: c.ciudad,
        temp: a.temperature_2m,
        st: a.apparent_temperature,
        hum: a.relative_humidity_2m,
        viento: a.wind_speed_10m,
        icon: wmo(a.weather_code)[0],
        desc: wmo(a.weather_code)[1],
        max: dd.temperature_2m_max?.[0],
        min: dd.temperature_2m_min?.[0],
        lluvia: dd.precipitation_probability_max?.[0],
      };
    } catch (e) {
      return null;
    }
  }));
  return { ciudades: res.filter(Boolean) };
}

// =====================================================================
//  BRIEFING (opcional, Workers AI)
// =====================================================================
async function getBriefing(env) {
  const news = await getNews();
  const markets = await getMarkets();
  const headlines = news.highlights
    .concat(news.byCategory.politica.slice(0, 4), news.byCategory.geopolitica.slice(0, 4))
    .map((h) => `- ${h.title} (${h.source})`)
    .slice(0, 16)
    .join("\n");
  if (!headlines) return { updated: new Date().toISOString(), text: "" };

  const blue = markets.dolares.find((d) => d.id === "blue");
  const ofi = markets.dolares.find((d) => d.id === "oficial");
  const brent = markets.commodities.find((c) => c.symbol === "BZ=F");
  const argt = markets.indices.find((c) => c.symbol === "ARGT");
  const btc = markets.crypto.find((c) => c.symbol === "BTC");

  const prompt = `Sos un editor económico argentino. Escribí un resumen de 5 a 7 viñetas, en español rioplatense, neutral y concreto, sobre lo más importante del día para Argentina. Usá solo estos datos:

Mercados: dólar oficial ${ofi?.venta ?? "s/d"}, blue ${blue?.venta ?? "s/d"}, riesgo país ${markets.riesgoPais?.value ?? "s/d"}, MSCI Argentina (ARGT) ${fmtPct(argt?.change)}, Brent ${brent?.price ?? "s/d"} USD (${fmtPct(brent?.change)}), BTC ${btc?.usd ?? "s/d"} USD.

Titulares:
${headlines}`;

  const ai = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [{ role: "user", content: prompt }],
    max_tokens: 600,
  });
  return { updated: new Date().toISOString(), text: ai.response || "" };
}

function fmtPct(v) {
  return v == null ? "s/d" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

// =====================================================================
//  FRONTEND (HTML con React)
// =====================================================================
const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Argentina Daily — Política, mercados y geopolítica</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,800&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet" />
<script crossorigin src="https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js"></script>
<script crossorigin src="https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<style>
  :root{
    --bg:#0d0f12; --panel:#15181d; --panel2:#1b1f26; --line:#262b33;
    --ink:#e9e6df; --muted:#8d939c; --accent:#6cb4ee; --sun:#f2c14e;
    --up:#3ecf8e; --down:#ff5c5c;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:Inter,system-ui,sans-serif;font-size:15px}
  a{color:inherit;text-decoration:none}
  .wrap{max-width:1320px;margin:0 auto;padding:0 20px}

  /* ticker */
  .ticker{border-bottom:1px solid var(--line);background:#0a0c0e;overflow:hidden;white-space:nowrap;position:sticky;top:0;z-index:50}
  .ticker-track{display:inline-flex;gap:34px;padding:9px 0;animation:scroll 70s linear infinite;font-family:"JetBrains Mono",monospace;font-size:12.5px}
  .ticker:hover .ticker-track{animation-play-state:paused}
  @keyframes scroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}
  .tk b{color:var(--muted);font-weight:500;margin-right:6px}

  /* masthead */
  header.mast{padding:26px 0 18px;border-bottom:3px double var(--line);display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap}
  .brand{font-family:Fraunces,serif;font-weight:800;font-size:clamp(34px,5vw,56px);letter-spacing:-.02em;line-height:1}
  .brand span{color:var(--accent)} .brand i{color:var(--sun);font-style:normal}
  .meta{color:var(--muted);font-size:13px;text-align:right;line-height:1.6}
  .btn{background:var(--panel2);border:1px solid var(--line);color:var(--ink);padding:7px 12px;border-radius:8px;cursor:pointer;font:inherit;font-size:13px}
  .btn:hover{border-color:var(--accent)}

  /* market grid */
  .section-title{font-family:Fraunces,serif;font-size:20px;margin:28px 0 12px;display:flex;align-items:center;gap:10px}
  .section-title::after{content:"";flex:1;height:1px;background:var(--line)}
  .grid{display:grid;gap:12px}
  .g-dolar{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
  .g-mkt{grid-template-columns:repeat(auto-fill,minmax(190px,1fr))}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px}
  .card .lbl{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
  .card .val{font-family:"JetBrains Mono",monospace;font-size:22px;margin-top:6px}
  .card .sub{font-size:12px;color:var(--muted);margin-top:4px;font-family:"JetBrains Mono",monospace}
  .card.hl{border-color:#3a4a5c;background:linear-gradient(160deg,#18202b,#15181d)}
  .up{color:var(--up)} .down{color:var(--down)}
  .row{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .mini-list .item{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px dashed var(--line);font-family:"JetBrains Mono",monospace;font-size:13px}
  .mini-list .item:last-child{border:0}

  /* briefing */
  .brief{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--sun);border-radius:12px;padding:16px 20px;line-height:1.6;white-space:pre-wrap}

  /* tabs + news */
  .toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:8px 0 18px}
  .tabs{display:flex;gap:6px;flex-wrap:wrap}
  .tab{padding:7px 13px;border-radius:999px;border:1px solid var(--line);background:transparent;color:var(--muted);cursor:pointer;font:inherit;font-size:13px}
  .tab.on{background:var(--ink);color:#111;border-color:var(--ink)}
  .search{margin-left:auto;background:var(--panel);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:8px 12px;font:inherit;min-width:220px}

  .lead{display:grid;grid-template-columns:2fr 1fr;gap:16px}
  @media(max-width:900px){.lead{grid-template-columns:1fr}}
  .hero{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
  .hero img{width:100%;height:280px;object-fit:cover;background:#222}
  .hero .body{padding:18px}
  .hero h2{font-family:Fraunces,serif;font-size:28px;line-height:1.15;margin:8px 0}
  .side-list{display:flex;flex-direction:column;gap:10px}
  .s-item{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
  .s-item h3{font-size:15px;margin:6px 0 0;line-height:1.35;font-weight:600}

  .news{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;margin-top:16px}
  .n{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;display:flex;flex-direction:column;transition:border-color .15s,transform .15s}
  .n:hover,.s-item:hover,.hero:hover{border-color:var(--accent)}
  .n:hover{transform:translateY(-2px)}
  .n img{width:100%;height:150px;object-fit:cover;background:#222}
  .n .body{padding:13px 14px;display:flex;flex-direction:column;gap:6px;flex:1}
  .n h3{margin:0;font-size:15.5px;line-height:1.35;font-weight:600}
  .n p{margin:0;color:var(--muted);font-size:13.5px;line-height:1.45}
  .src{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--muted);flex-wrap:wrap}
  .src .s{color:var(--accent);font-weight:600}
  .badge{font-size:10.5px;padding:2px 7px;border-radius:999px;border:1px solid var(--line);text-transform:uppercase;letter-spacing:.05em}
  .hot{color:var(--sun);border-color:#5a4a1e}
  .empty,.err{color:var(--muted);padding:30px;text-align:center;border:1px dashed var(--line);border-radius:12px}
  .err{color:#ffb3b3;border-color:#5c2a2a}
  .skel{background:linear-gradient(90deg,#171a1f,#1f232a,#171a1f);background-size:200% 100%;animation:sh 1.2s infinite;border-radius:12px;height:120px}
  @keyframes sh{to{background-position:-200% 0}}
  .clima{display:flex;gap:8px;flex-wrap:wrap}
  .clima .t{font-family:"JetBrains Mono",monospace;font-size:20px}
  .clima .d{color:var(--muted);font-size:11.5px;margin-top:2px}
  .dia{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:7px 12px;text-align:center;font-size:12px;min-width:92px;cursor:default}
  .dia b{display:block;color:var(--muted);font-weight:500;margin-bottom:2px}
  .dep-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
  .dep-row{display:grid;grid-template-columns:92px 1fr;gap:8px;padding:7px 0;border-bottom:1px dashed var(--line);font-size:13px}
  .dep-row:last-child{border:0}
  .dep-when{color:var(--muted);font-family:"JetBrains Mono",monospace;font-size:12px}
  .dep-tor{color:var(--muted);font-size:11.5px}
  .live{color:var(--down);font-weight:600;font-size:11.5px}
  .dep-grid{align-items:start}
  .dep-more{margin-top:8px;width:100%;background:transparent;border:1px dashed var(--line);color:var(--accent);border-radius:8px;padding:6px;font:inherit;font-size:12.5px;cursor:pointer}
  .dep-more:hover{border-color:var(--accent)}
  footer{color:var(--muted);font-size:12px;padding:40px 0;text-align:center}
  svg.spark{display:none}
</style>
</head>
<body>
<div id="root"><div style="padding:40px;color:#8d939c;font-family:sans-serif">Cargando Argentina Daily…</div></div>
<script>
window.addEventListener("error",function(e){document.getElementById("root").innerHTML="<div style=\\"padding:30px;color:#ffb3b3;font-family:monospace;white-space:pre-wrap\\">Error: "+(e.message||e)+"</div>";});
</script>

<script>
if("undefined"==typeof React||"undefined"==typeof ReactDOM)document.getElementById("root").innerHTML='<div style="padding:30px;color:#ffb3b3;font-family:sans-serif">No se pudo cargar React desde cdn.jsdelivr.net. Revisá tu conexión o un bloqueador de anuncios.</div>';else{
const e="",a=6e5,t=12e4,{useState:c,useEffect:n,useMemo:l,useCallback:s}=React,r={politica:"#6cb4ee",economia:"#3ecf8e",dolar:"#9ad86b",mercados:"#b48cf2",crypto:"#f7931a",energia:"#e0a458",
geopolitica:"#4fd1c5",conflictos:"#ff5c5c",portadas:"#e9e6df"},m=(e,a=2)=>null==e||isNaN(e)?"—":Number(e).toLocaleString("es-AR",{minimumFractionDigits:a,maximumFractionDigits:a
}),i=e=>null==e||isNaN(e)?"—":\`\${e>=0?"▲":"▼"} \${Math.abs(e).toFixed(2)}%\`,o=e=>null==e?"":e>=0?"up":"down";function timeAgo(e){if(!e)return"";const a=Math.floor((Date.now()-e)/1e3)
;if(a<60)return"recién";const t=Math.floor(a/60);if(t<60)return\`hace \${t} min\`;const c=Math.floor(t/60);return c<24?\`hace \${c} h\`:\`hace \${Math.floor(c/24)} d\`}async function getJSON(a){
const t=await fetch(e+a);if(!t.ok)throw new Error(\`\${t.status} en \${a}\`);return t.json()}function Spark({data:e,up:a}){if(!e||e.length<2)return null
;const t=Math.min(...e),c=Math.max(...e)-t||1,n=e.map((a,n)=>\`\${n/(e.length-1)*160},\${34-(a-t)/c*34}\`).join(" ");return React.createElement("svg",{className:"spark",width:"100%",height:34,
viewBox:"0 0 160 34",preserveAspectRatio:"none"},React.createElement("polyline",{fill:"none",stroke:a?"var(--up)":"var(--down)",strokeWidth:"1.6",points:n}))}function Ticker({m:e}){
if(!e)return React.createElement("div",{className:"ticker"},React.createElement("div",{className:"ticker-track",style:{animation:"none",paddingLeft:20}},"Cargando mercados…"))
;const a=[],t=e.foco?.blue,c=e.foco?.ccl,n=e.foco?.reservas;t&&a.push(["BLUE",\`$\${m(t.venta,0)}\`,t.changeDay]),c&&a.push(["CCL",\`$\${m(c.venta,0)}\`,c.changeDay]),
n&&a.push(["RESERVAS",\`US$\${m(n.value,0)} M\`]),e.riesgoPais&&a.push(["RIESGO PAÍS",\`\${m(e.riesgoPais.value,0)} pb\`]),
[...e.indices,...e.commodities,...e.adrs].forEach(e=>a.push([e.name.toUpperCase(),m(e.price),e.change])),e.crypto.forEach(e=>a.push([e.symbol,\`US$\${m(e.usd,e.usd<10?3:0)}\`,e.change24h]))
;const l=a.map(([e,a,t],c)=>React.createElement("span",{className:"tk",key:c},React.createElement("b",null,e),a," ",null!=t&&React.createElement("span",{className:o(t)},i(t))))
;return React.createElement("div",{className:"ticker"},React.createElement("div",{className:"ticker-track"},l,l))}function Markets({m:e,err:a}){if(a)return React.createElement("div",{className:"err"
},"No se pudieron cargar los mercados: ",a);if(!e)return React.createElement("div",{className:"grid g-dolar"},Array.from({length:6}).map((e,a)=>React.createElement("div",{className:"skel",key:a})))
;const t=e.foco||{},c=({t:e,d:a})=>React.createElement("div",{className:"card hl"},React.createElement("div",{className:"row"},React.createElement("span",{className:"lbl"
},e),React.createElement("span",{className:o(a?.changeDay),style:{fontSize:12,fontFamily:"JetBrains Mono"}},i(a?.changeDay)," hoy")),React.createElement("div",{className:"val"
},"$",a?m(a.venta,0):"—"),React.createElement("div",{className:"sub"},"Compra $",a?m(a.compra,0):"—"," · ",React.createElement("span",{className:o(a?.changeMonth)
},i(a?.changeMonth))," en 30 días"),React.createElement(Spark,{data:a?.spark,up:(a?.changeMonth||0)>=0})),n=t.reservas,l=e=>null==e?"—":\`\${e>=0?"+":"−"}US$ \${m(Math.abs(e),0)} M\`
;return React.createElement(React.Fragment,null,React.createElement("h2",{className:"section-title"},"Dólar y reservas"),React.createElement("div",{className:"grid g-mkt"},React.createElement(c,{
t:"Dólar blue",d:t.blue}),React.createElement(c,{t:"Dólar CCL",d:t.ccl}),React.createElement("div",{className:"card hl"},React.createElement("div",{className:"row"},React.createElement("span",{
className:"lbl"},"Reservas BCRA"),React.createElement("span",{className:o(n?.changeDay),style:{fontSize:12,fontFamily:"JetBrains Mono"}},l(n?.changeDay))),React.createElement("div",{className:"val"
},n?\`US$ \${m(n.value,0)} M\`:"—"),React.createElement("div",{className:"sub"},n?React.createElement(React.Fragment,null,"Al ",n.date.split("-").reverse().join("/")," · ",React.createElement("span",{
className:o(n.changeMonth)},l(n.changeMonth))," en 30 días"):"Sin datos del BCRA"),React.createElement(Spark,{data:n?.spark,up:(n?.changeMonth||0)>=0})),t.elecciones&&React.createElement("div",{
className:"card hl"},React.createElement("div",{className:"lbl"
},"Elecciones 2027 · Polymarket"),[["Oficialismo",t.elecciones.oficialismo],["Oposición (mejor ubicado)",t.elecciones.oposicion]].map(([e,a])=>a&&React.createElement("div",{key:e,style:{marginTop:8}
},React.createElement("div",{className:"sub",style:{marginTop:0}},e),React.createElement("div",{className:"row"},React.createElement("span",{style:{fontWeight:600}
},a.name),React.createElement("span",{className:"val",style:{fontSize:20,marginTop:0}},Math.round(100*a.p),"%")),null!=a.d7&&React.createElement("div",{className:"sub",style:{marginTop:0}
},React.createElement("span",{className:o(a.d7)},a.d7>=0?"▲":"▼"," ",Math.abs(100*a.d7).toFixed(1)," pts")," en 7 días"))),React.createElement("div",{className:"sub",style:{marginTop:8,fontSize:11}
},"Probabilidad de ganar según apuestas. No es una encuesta.")),React.createElement("div",{className:"card"},React.createElement("div",{className:"lbl"},"Riesgo país"),React.createElement("div",{
className:"val"},e.riesgoPais?m(e.riesgoPais.value,0):"—"),React.createElement("div",{className:"sub"},"puntos básicos"))),React.createElement("h2",{className:"section-title"
},"Bolsas, petróleo y commodities"),React.createElement("div",{className:"grid g-mkt"},[...e.indices,...e.commodities].map(e=>React.createElement("div",{className:"card",key:e.symbol
},React.createElement("div",{className:"row"},React.createElement("span",{className:"lbl"},e.name),React.createElement("span",{className:o(e.change),style:{fontSize:12,fontFamily:"JetBrains Mono"}
},i(e.change))),React.createElement("div",{className:"val"},m(e.price)),React.createElement(Spark,{data:e.spark,up:(e.change||0)>=0})))),React.createElement("div",{className:"grid",style:{
gridTemplateColumns:"repeat(auto-fit,minmax(300px,1fr))",marginTop:12}},React.createElement("div",{className:"card"},React.createElement("div",{className:"lbl",style:{marginBottom:6}
},"ADRs argentinos (NYSE · USD)"),React.createElement("div",{className:"mini-list"},e.adrs.map(e=>React.createElement("div",{className:"item",key:e.symbol
},React.createElement("span",null,e.name," ",React.createElement("span",{style:{color:"var(--muted)"}},e.symbol)),React.createElement("span",null,m(e.price)," ",React.createElement("span",{
className:o(e.change)},i(e.change))))))),React.createElement("div",{className:"card"},React.createElement("div",{className:"lbl",style:{marginBottom:6}},"Crypto (24 h)"),React.createElement("div",{
className:"mini-list"},e.crypto.map(e=>React.createElement("div",{className:"item",key:e.id
},React.createElement("span",null,e.symbol),React.createElement("span",null,"US$",m(e.usd,e.usd<10?3:0)," · $",m(e.ars,0)," ",React.createElement("span",{className:o(e.change24h)
},i(e.change24h)))))))))}function Src({it:e,cats:a}){return React.createElement("div",{className:"src"},React.createElement("span",{className:"s"
},e.source),React.createElement("span",null,"·"),React.createElement("span",null,timeAgo(e.ts)),e.categories?.filter(e=>"portadas"!==e).slice(0,2).map(e=>React.createElement("span",{key:e,
className:"badge",style:{color:r[e],borderColor:r[e]+"55"}},a?.[e]||e)))}function Img({src:e}){const[a,t]=c(!0);return e&&a?React.createElement("img",{src:e,loading:"lazy",
referrerPolicy:"no-referrer",onError:()=>t(!1),alt:""}):null}function Highlights({items:e,cats:a}){const[t,n]=c(0),l=React.useRef(null);if(!e?.length)return null
;const s=e.slice(0,6),r=t<s.length?t:0,m=s[r],i=s.map((e,a)=>[e,a]).filter(([,e])=>e!==r),o=e=>{n(e);const a=l.current;try{a&&a.scrollIntoView&&a.getBoundingClientRect().top<40&&a.scrollIntoView({
behavior:"smooth",block:"start"})}catch(e){}};return React.createElement(React.Fragment,null,React.createElement("h2",{className:"section-title"},"Lo más importante"),React.createElement("div",{
className:"lead"},React.createElement("a",{className:"hero",ref:l,href:m.link,target:"_blank",rel:"noopener",title:"Abrir la nota"},React.createElement(Img,{key:m.link,src:m.image
}),React.createElement("div",{className:"body"},React.createElement(Src,{it:m,cats:a}),React.createElement("h2",null,m.title),m.summary&&React.createElement("p",{style:{color:"var(--muted)"}
},m.summary),React.createElement("div",{className:"sub",style:{color:"var(--accent)",marginTop:8}},"Abrir la nota ↗"))),React.createElement("div",{className:"side-list"
},i.map(([e,t])=>React.createElement("div",{className:"s-item",key:e.link,role:"button",tabIndex:0,style:{cursor:"pointer"},onClick:()=>o(t),onKeyDown:e=>{
"Enter"!==e.key&&" "!==e.key||(e.preventDefault(),o(t))}},React.createElement(Src,{it:e,cats:a}),React.createElement("h3",null,e.title))))))}function NewsGrid({items:e,cats:a}){
return e.length?React.createElement("div",{className:"news"},e.map((e,t)=>React.createElement("a",{className:"n",key:e.link+t,href:e.link,target:"_blank",rel:"noopener"},React.createElement(Img,{
src:e.image}),React.createElement("div",{className:"body"},React.createElement(Src,{it:e,cats:a
}),React.createElement("h3",null,e.title),e.summary&&React.createElement("p",null,e.summary))))):React.createElement("div",{className:"empty"},"No hay noticias para este filtro.")}
function Clima({c:e}){return e?.ciudades?.length?React.createElement("div",{className:"clima"},e.ciudades.map(e=>React.createElement("div",{className:"dia",key:e.ciudad,
title:\`\${e.desc} · ST \${Math.round(e.st)}° · Hum \${e.hum}% · Viento \${Math.round(e.viento)} km/h\`},React.createElement("b",null,e.ciudad),React.createElement("div",null,React.createElement("span",{
style:{fontSize:20}},e.icon)," ",React.createElement("span",{className:"t"},Math.round(e.temp),"°")),React.createElement("div",{className:"d"
},Math.round(e.max),"° / ",Math.round(e.min),"°",e.lluvia>=30&&React.createElement("span",{style:{color:"var(--accent)"}}," · 💧",e.lluvia,"%"))))):null}const d=e=>{const a=new Date(e);return{
dia:a.toLocaleDateString("es-AR",{weekday:"short",day:"numeric",timeZone:"America/Argentina/Buenos_Aires"}),hora:a.toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit",
timeZone:"America/Argentina/Buenos_Aires"})}};function DepFila({x:e,golf:a}){const t=d(e.fecha);return React.createElement("div",{className:"dep-row"},React.createElement("div",{className:"dep-when"
},t.dia,React.createElement("br",null),a?e.hasta?"al "+new Date(e.hasta).toLocaleDateString("es-AR",{day:"numeric",month:"short"}):"":t.hora),React.createElement("div",null,React.createElement("div",{
style:{fontWeight:600}},e.partido),React.createElement("div",{className:"dep-tor"},e.torneo,e.lugar?" · "+e.lugar:""),"in"===e.estado&&React.createElement("div",{className:"live"
},"● EN VIVO",e.marcador?" · "+e.marcador:"")))}function DepCol({t:e,items:a,golf:t}){const[n,l]=c(!1),s=a||[],r=n?s:s.slice(0,2),m=s.length-2;return React.createElement("div",{className:"card"
},React.createElement("div",{className:"lbl",style:{marginBottom:4}},e),s.length?r.map((e,a)=>React.createElement(DepFila,{key:a,x:e,golf:t})):React.createElement("div",{className:"sub"
},"Sin partidos programados"),m>0&&React.createElement("button",{className:"dep-more",onClick:()=>l(!n)},n?"Ver menos ▴":\`Ver \${m} más ▾\`))}function Deportes({d:e}){
return e?React.createElement(React.Fragment,null,React.createElement("h2",{className:"section-title"},"Deportes · próximos partidos"),React.createElement("div",{className:"dep-grid"
},React.createElement(DepCol,{t:"⚽ Fútbol",items:e.futbol}),React.createElement(DepCol,{t:"🎾 Tenis",items:e.tenis}),React.createElement(DepCol,{t:"⛳ Golf",items:e.golf,golf:!0
}),React.createElement(DepCol,{t:"🏇 Polo",items:e.polo}))):null}function App(){
const[e,m]=c(null),[i,o]=c(null),[d,u]=c(null),[R,E]=c(null),[p,g]=c(null),[h,N]=c(null),[v,y]=c(null),[f,b]=c("todas"),[k,S]=c(""),D=s(()=>getJSON("/api/news").then(e=>{m(e),o(null)
}).catch(e=>o(e.message)),[]),C=s(()=>getJSON("/api/markets").then(e=>{u(e),E(null)}).catch(e=>E(e.message)),[]);n(()=>{D(),C(),getJSON("/api/briefing").then(g).catch(()=>{})
;const e=()=>getJSON("/api/clima").then(N).catch(()=>{});e();const c=setInterval(e,9e5),n=()=>getJSON("/api/deportes").then(y).catch(()=>{});n()
;const l=setInterval(n,18e5),s=setInterval(D,a),r=setInterval(C,t);return()=>{clearInterval(s),clearInterval(r),clearInterval(c),clearInterval(l)}},[]);const M=e?.categories||{},$=l(()=>{
if(!e)return[];let a;if("todas"===f){const t=new Set;a=[],Object.values(e.byCategory).flat().forEach(e=>{t.has(e.link)||(t.add(e.link),a.push(e))}),a.sort((e,a)=>(a.ts||0)-(e.ts||0))
}else a=e.byCategory[f]||[];if(k.trim()){const e=k.toLowerCase();a=a.filter(a=>(a.title+" "+a.summary+" "+a.source).toLowerCase().includes(e))}return a.slice(0,120)
},[e,f,k]),w=(new Date).toLocaleDateString("es-AR",{weekday:"long",day:"numeric",month:"long",year:"numeric"});return React.createElement(React.Fragment,null,React.createElement(Ticker,{m:d
}),React.createElement("div",{className:"wrap"},React.createElement("header",{className:"mast"},React.createElement("div",{className:"brand"
},"Argentina",React.createElement("span",null,"Daily"),React.createElement("i",null,".")),React.createElement(Clima,{c:h}),React.createElement("div",{className:"meta"},React.createElement("div",{
style:{textTransform:"capitalize"}},w),React.createElement("div",null,e?\`\${e.total} notas · actualizado \${new Date(e.updated).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"
})}\`:"Cargando…"),React.createElement("button",{className:"btn",style:{marginTop:6},onClick:()=>{D(),C()}},"↻ Actualizar"))),p?.text&&React.createElement(React.Fragment,null,React.createElement("h2",{
className:"section-title"},"Resumen del día"),React.createElement("div",{className:"brief"},p.text)),i&&React.createElement("div",{className:"err",style:{marginTop:24}
},"No se pudieron cargar las noticias: ",i),!e&&!i&&React.createElement("div",{className:"news",style:{marginTop:24}},Array.from({length:3}).map((e,a)=>React.createElement("div",{className:"skel",
key:a,style:{height:220}}))),e&&React.createElement(Highlights,{items:e.highlights,cats:M}),React.createElement(Markets,{m:d,err:R}),React.createElement(Deportes,{d:v
}),e&&React.createElement(React.Fragment,null,React.createElement("h2",{className:"section-title"},"Todas las noticias"),React.createElement("div",{className:"toolbar"},React.createElement("div",{
className:"tabs"},React.createElement("button",{className:"tab"+("todas"===f?" on":""),onClick:()=>b("todas")},"Todas"),Object.entries(M).map(([a,t])=>React.createElement("button",{key:a,
className:"tab"+(f===a?" on":""),onClick:()=>b(a)},React.createElement("span",{style:{color:f===a?"#111":r[a]}},"●")," ",t," ",React.createElement("span",{style:{opacity:.6}
},"(",e.byCategory[a]?.length||0,")")))),React.createElement("input",{className:"search",placeholder:"Buscar: Milei, YPF, Fed, Irán…",value:k,onChange:e=>S(e.target.value)
})),React.createElement(NewsGrid,{items:$,cats:M
})),React.createElement("footer",null,"Noticias: La Nación · Clarín · Ámbito · El Cronista · BBC Mundo · DW · France 24 · El País · CriptoNoticias. Mercados: DolarAPI · ArgentinaDatos · BCRA · Polymarket · CoinGecko/Kraken · Yahoo Finance. Clima: Open-Meteo. Deportes: ESPN.",React.createElement("br",null),"Datos informativos, pueden tener demora. No es asesoramiento financiero.")))
}ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App,null))}
</script>
</body>
</html>
`;
