"use strict";
/*
 * Segunda fuente del catalogo: Torrents-Api de Ryuk-me (autoalojada).
 *
 *   https://github.com/Ryuk-me/Torrents-Api
 *
 * Es un scraper HTTP de MUCHOS sitios. Aqui se consultan en paralelo los que
 * responden de verdad desde este servidor (1337x, PirateBay, TorrentProject; el
 * resto suele contestar "Website is blocked change IP" a las IPs de datacenter),
 * se fusionan los resultados y se quitan los duplicados por su hash. La lista de
 * sitios se ajusta con TORRENTS_API_SITIOS. Corre en el VPS como el servicio
 * systemd `torrents-api`, atado a 127.0.0.1:3012; la base se cambia con
 * TORRENTS_API_BASE.
 *
 * A diferencia de elitetorrent (que ademas navega por secciones), esta fuente es
 * solo de busqueda, con dos filtros que las webs ajenas no ofrecen de fabrica y
 * que se aplican aqui: idioma y calidad de pelicula.
 */

const nombrar = require("./nombrar");

const BASE = (process.env.TORRENTS_API_BASE || "http://127.0.0.1:3012").replace(/\/+$/, "");
const SITIOS = (process.env.TORRENTS_API_SITIOS || "1337x,piratebay,torrentproject")
  .split(",").map((s) => s.trim()).filter(Boolean);
const ESPERA = Number(process.env.TORRENTS_API_ESPERA_MS || 30000);

/* Idiomas y calidades del desplegable. El id se compara en minusculas. */
const IDIOMAS = [
  { id: "english",  nombre: "Inglés" },
  { id: "spanish",  nombre: "Español" },
  { id: "french",   nombre: "Francés" },
  { id: "italian",  nombre: "Italiano" },
  { id: "german",   nombre: "Alemán" },
  { id: "hindi",    nombre: "Hindi" },
  { id: "japanese", nombre: "Japonés" },
];

const CALIDADES = [
  { id: "2160p", nombre: "2160p / 4K" },
  { id: "1080p", nombre: "1080p" },
  { id: "720p",  nombre: "720p" },
  { id: "480p",  nombre: "480p" },
];

/* La calidad no viene en un campo aparte: se lee del nombre. */
function calidadDe(nombre) {
  const n = String(nombre || "").toLowerCase();
  if (/\b(2160p|4k|uhd)\b/.test(n)) return "2160p";
  if (/\b1080p\b/.test(n)) return "1080p";
  if (/\b720p\b/.test(n)) return "720p";
  if (/\b480p\b/.test(n)) return "480p";
  return "";
}

/*
 * El idioma: 1337x lo da en un campo (Language); los demas sitios no, asi que
 * se intenta deducir del nombre. Si no hay ninguna pista se devuelve "" y ese
 * item no se descarta al filtrar (no penalizar lo que no sabemos).
 */
const PISTAS_IDIOMA = [
  ["spanish",  /\b(spanish|castellano|espa[nñ]ol|latino|dual)\b/i],
  ["english",  /\b(english|eng)\b/i],
  ["french",   /\b(french|fran[cç]ais|vostfr|truefrench)\b/i],
  ["italian",  /\b(italian|ita)\b/i],
  ["german",   /\b(german|deutsch|ger)\b/i],
  ["hindi",    /\bhindi\b/i],
  ["japanese", /\b(japanese|jpn)\b/i],
];
function idiomaDe(campoLang, nombre) {
  const c = String(campoLang || "").toLowerCase().trim();
  if (c) {
    for (const [id] of PISTAS_IDIOMA) if (c.includes(id)) return id;
    return c; // p.ej. "english" tal cual
  }
  const n = String(nombre || "");
  for (const [id, re] of PISTAS_IDIOMA) if (re.test(n)) return id;
  return "";
}

/* Serie o pelicula, por las pistas del nombre. */
function tipoDe(nombre) {
  const t = String(nombre || "");
  if (/\b(S\d{1,2}E\d{1,2}|Temporada|Season|Complete)\b/i.test(t)) return "serie";
  if (nombrar.episodioDe && nombrar.episodioDe(t)) return "serie";
  return "pelicula";
}

/* El hash del magnet, para deduplicar el mismo torrent que sale en varias webs. */
function hashDe(magnet) {
  const m = /xt=urn:btih:([a-z0-9]+)/i.exec(magnet || "");
  return m ? m[1].toLowerCase() : "";
}

async function pedirSitio(sitio, query, pagina) {
  const ruta = `/api/${encodeURIComponent(sitio)}/${encodeURIComponent(query)}/${pagina}`;
  const res = await fetch(BASE + ruta, {
    signal: AbortSignal.timeout(ESPERA),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${sitio}: HTTP ${res.status}`);
  const datos = await res.json();
  /* Cada sitio contesta {error:...} cuando esta bloqueado o no hay resultados:
     no es motivo para tumbar la busqueda entera, se ignora ese sitio. */
  if (!Array.isArray(datos)) return [];
  return datos.map((r) => ({ r, sitio }));
}

function normalizar({ r, sitio }) {
  const magnet = typeof r.Magnet === "string" && r.Magnet.startsWith("magnet:") ? r.Magnet : null;
  const torrent = typeof r.Torrent === "string" && /^https?:\/\//.test(r.Torrent) ? r.Torrent : null;
  const tamanoTxt = r.Size || "";
  return {
    titulo: String(r.Name || "").trim(),
    portada: r.Poster || null,
    idioma: idiomaDe(r.Language, r.Name),
    resolucion: calidadDe(r.Name),
    tamanoTxt,
    tamanoBytes: nombrar.aBytes(tamanoTxt),
    tipo: tipoDe(r.Name),
    sitio,
    _semillas: Number(r.Seeders) || 0,
    torrents: (magnet || torrent) ? [{
      indice: 0,
      torrent,
      magnet,
      fecha: r.DateUploaded || null,
      semillas: Number(r.Seeders) || 0,
      clientes: Number(r.Leechers) || 0,
    }] : [],
  };
}

/*
 * Busca en todas las webs a la vez y devuelve una sola lista.
 *
 *   idioma  filtra por el id de IDIOMAS. Los items de idioma desconocido pasan
 *           igual: solo se descarta lo que sabemos que es otro idioma.
 *   calidad filtra por el id de CALIDADES; aqui si se exige coincidir, que es
 *           justo lo que se pide al elegir una calidad.
 */
async function buscar(query, { idioma = "", calidad = "", pagina = 1 } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const p = Math.max(1, Number(pagina) || 1);

  const tandas = await Promise.allSettled(SITIOS.map((s) => pedirSitio(s, q, p)));
  const crudos = tandas.flatMap((t) => (t.status === "fulfilled" ? t.value : []));
  if (!crudos.length && tandas.every((t) => t.status === "rejected")) {
    throw new Error("ninguna web de la API respondió (¿la API está caída o bloqueada?)");
  }

  let items = crudos.map(normalizar).filter((x) => x.titulo && x.torrents.length);

  /* Deduplicar por hash; si se repite, quedarse con el de mas semillas. */
  const porHash = new Map();
  const sinHash = [];
  for (const x of items) {
    const h = hashDe(x.torrents[0].magnet);
    if (!h) { sinHash.push(x); continue; }
    const previo = porHash.get(h);
    if (!previo || x._semillas > previo._semillas) porHash.set(h, x);
  }
  items = [...porHash.values(), ...sinHash];

  if (idioma) {
    items = items.filter((x) => x.idioma === idioma || x.idioma === "");
  }
  if (calidad) {
    items = items.filter((x) => x.resolucion === calidad);
  }

  /* Mas semillas primero: es lo que mejor descarga. */
  items.sort((a, b) => b._semillas - a._semillas);
  for (const x of items) delete x._semillas;
  return items;
}

module.exports = { buscar, IDIOMAS, CALIDADES, SITIOS, nombre: "Varias webs" };
