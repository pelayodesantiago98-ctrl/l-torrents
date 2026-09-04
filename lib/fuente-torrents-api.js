"use strict";
/*
 * Segunda fuente del catalogo: Torrents-Api de Ryuk-me (autoalojada).
 *
 *   https://github.com/Ryuk-me/Torrents-Api
 *
 * Es un scraper HTTP de varios sitios; aqui se usa 1337x, que es el que
 * devuelve idioma (campo Language) y del que se puede sacar la calidad del
 * propio nombre. Corre en el VPS como el servicio systemd `torrents-api`,
 * escuchando solo en 127.0.0.1. La URL base se ajusta con TORRENTS_API_BASE.
 *
 * A diferencia de elitetorrent (que ademas navega por secciones), esta fuente
 * es solo de busqueda, con dos filtros que la web ajena no ofrece de fabrica y
 * que se aplican aqui sobre los resultados: idioma y calidad de pelicula.
 */

const nombrar = require("./nombrar");

const BASE = (process.env.TORRENTS_API_BASE || "http://127.0.0.1:3012").replace(/\/+$/, "");
const SITIO = process.env.TORRENTS_API_SITIO || "1337x";
const ESPERA = Number(process.env.TORRENTS_API_ESPERA_MS || 30000);

/* Los idiomas y calidades que ofrece el desplegable. El id es lo que se compara
   (en minusculas, por inclusion) contra el campo Language o contra el nombre. */
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

/* La calidad no viene en un campo aparte: se lee del nombre, que en estas webs
   casi siempre la trae. 4k y 2160p son lo mismo. */
function calidadDe(nombre) {
  const n = String(nombre || "").toLowerCase();
  if (/\b(2160p|4k|uhd)\b/.test(n)) return "2160p";
  if (/\b1080p\b/.test(n)) return "1080p";
  if (/\b720p\b/.test(n)) return "720p";
  if (/\b480p\b/.test(n)) return "480p";
  return "";
}

/* Serie o pelicula, por las mismas pistas del nombre que usa el indexador. */
function tipoDe(nombre) {
  const t = String(nombre || "");
  if (/\b(S\d{1,2}E\d{1,2}|Temporada|Season|Complete)\b/i.test(t)) return "serie";
  if (nombrar.episodioDe && nombrar.episodioDe(t)) return "serie";
  return "pelicula";
}

async function pedir(query, pagina) {
  const ruta = `/api/${encodeURIComponent(SITIO)}/${encodeURIComponent(query)}/${pagina}`;
  let res;
  try {
    res = await fetch(BASE + ruta, {
      signal: AbortSignal.timeout(ESPERA),
      headers: { Accept: "application/json" },
    });
  } catch (e) {
    if (e.name === "TimeoutError") throw new Error("la API de torrents no responde a tiempo");
    throw new Error(`no se puede llegar a la API de torrents: ${e.message}`);
  }
  if (!res.ok) throw new Error(`la API de torrents responde ${res.status}`);
  let datos;
  try { datos = await res.json(); } catch { throw new Error("la API de torrents no devolvio JSON"); }
  /* La API contesta un objeto {error:...} cuando la web esta bloqueada o no hay
     resultados; se traduce a un mensaje legible en vez de reventar el .map. */
  if (!Array.isArray(datos)) {
    const msg = datos && datos.error ? datos.error : "respuesta inesperada";
    if (/no search result/i.test(msg)) return [];
    throw new Error(`la API de torrents (${SITIO}): ${msg}`);
  }
  return datos;
}

function normalizar(r) {
  const magnet = typeof r.Magnet === "string" && r.Magnet.startsWith("magnet:") ? r.Magnet : null;
  const torrent = typeof r.Torrent === "string" && /^https?:\/\//.test(r.Torrent) ? r.Torrent : null;
  const tamanoTxt = r.Size || "";
  return {
    titulo: String(r.Name || "").trim(),
    portada: r.Poster || null,
    idioma: r.Language || "",
    resolucion: calidadDe(r.Name),
    tamanoTxt,
    tamanoBytes: nombrar.aBytes(tamanoTxt),
    tipo: tipoDe(r.Name),
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
 * Busca y filtra. `idioma` y `calidad` son los id de las listas de arriba; si
 * vienen vacios no filtran. El idioma se compara por inclusion (Language suele
 * decir "English" a secas, pero a veces trae mas de un idioma).
 */
async function buscar(query, { idioma = "", calidad = "", pagina = 1 } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const crudos = await pedir(q, Math.max(1, Number(pagina) || 1));
  let items = crudos.map(normalizar).filter((x) => x.titulo && x.torrents.length);
  if (idioma) {
    const id = idioma.toLowerCase();
    items = items.filter((x) => x.idioma.toLowerCase().includes(id));
  }
  if (calidad) {
    items = items.filter((x) => x.resolucion === calidad);
  }
  return items;
}

module.exports = { buscar, IDIOMAS, CALIDADES, SITIO, nombre: "1337x" };
