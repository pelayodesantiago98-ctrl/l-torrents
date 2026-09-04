'use strict';
/*
 * El indexador: lo unico de aqui que depende de una web ajena.
 *
 * Todo lo demas —transmission, el buzon, el panel— funciona igual venga de
 * donde venga el catalogo. Por eso vive aislado en este fichero: si la API
 * cambia de forma, o se cambia de fuente, se toca esto y nada mas.
 *
 * Admite las dos maneras en que se suele publicar una API asi:
 *
 *   INDEXADOR_MODULO=nombre-del-paquete
 *       Una libreria de npm que exporta getMovies(), getSeries(), search()...
 *       Es lo que describe la documentacion, con funciones y no con rutas.
 *
 *   INDEXADOR_BASE=https://ejemplo/api
 *       Un servicio HTTP. Las rutas se declaran en RUTAS, mas abajo, porque
 *       ahi es donde varian entre APIs.
 *
 * Si no hay ninguna de las dos configuradas, las busquedas devuelven un error
 * claro que lo dice. Preferible a arrancar fingiendo que el catalogo esta
 * vacio: un catalogo vacio parece un problema de la web ajena y se tarda mucho
 * mas en descubrir que lo que faltaba era una linea del .env.
 */

const nombrar = require('./nombrar');

const MODULO  = process.env.INDEXADOR_MODULO || '';
const BASE    = (process.env.INDEXADOR_BASE || '').replace(/\/+$/, '');
const ESPERA  = Number(process.env.INDEXADOR_ESPERA_MS || 15000);

/*
 * Las rutas del modo HTTP.
 *
 * Estan aqui arriba y no repartidas por el codigo justo para que se puedan
 * ajustar de un vistazo: es lo primero que hay que cambiar si la API resulta
 * llamarlas de otra manera. `{p}` es la pagina, `{q}` el argumento.
 */
const RUTAS = {
  peliculas: '/movies?page={p}',
  series:    '/series?page={p}',
  novedades: '/new-releases?page={p}',
  hdrip:     '/movies/hdrip?page={p}',
  microhd:   '/movies/microhd?page={p}',
  genero:    '/genre/{q}?page={p}',
  calidad:   '/quality/{q}?page={p}',
  buscar:    '/search?q={q}',
};

/* Los generos y calidades que admite la API, con su etiqueta para la
   interfaz. Los identificadores llevan el numero pegado, tal cual los pide. */
const GENEROS = [
  { id: 'accion-3',                 nombre: 'Acción' },
  { id: 'action-and-adventure-2',   nombre: 'Acción y aventura' },
  { id: 'animacion-8',              nombre: 'Animación' },
  { id: 'aventura-9',               nombre: 'Aventura' },
  { id: 'comedia-19',               nombre: 'Comedia' },
  { id: 'crimen-3',                 nombre: 'Crimen' },
  { id: 'drama-5',                  nombre: 'Drama' },
  { id: 'misterio-1',               nombre: 'Misterio' },
  { id: 'romance-2',                nombre: 'Romance' },
  { id: 'sci-fi-and-fantasy-3',     nombre: 'Ciencia ficción y fantasía' },
  { id: 'suspenso-2',               nombre: 'Suspense' },
];

const CALIDADES = [
  { id: '1080p-10', nombre: '1080p' },
  { id: '720p-2',   nombre: '720p' },
];

/* El modulo de npm se carga una sola vez y tarde: si el paquete no esta
   instalado, el fallo tiene que salir cuando alguien busca —con un mensaje
   que se pueda leer en el panel— y no impedir que arranque el servicio. */
let modulo = null;
function cargarModulo() {
  if (modulo) return modulo;
  try {
    modulo = require(MODULO);
  } catch (e) {
    throw new Error(`no se pudo cargar el indexador "${MODULO}": ${e.message}`);
  }
  return modulo;
}

async function porHttp(plantilla, { p = 1, q = '' } = {}) {
  const ruta = plantilla
    .replace('{p}', encodeURIComponent(p))
    .replace('{q}', encodeURIComponent(q));
  let res;
  try {
    res = await fetch(BASE + ruta, {
      signal: AbortSignal.timeout(ESPERA),
      headers: { Accept: 'application/json', 'User-Agent': 'l-torrents/0.1 (lepayimio.es)' },
    });
  } catch (e) {
    if (e.name === 'TimeoutError') throw new Error('el indexador no responde a tiempo');
    throw new Error(`no se puede llegar al indexador: ${e.message}`);
  }
  if (!res.ok) throw new Error(`el indexador responde ${res.status} ${res.statusText}`);
  try {
    return await res.json();
  } catch {
    throw new Error('el indexador no devolvio JSON (¿una página de error?)');
  }
}

async function porModulo(fn, args) {
  const m = cargarModulo();
  if (typeof m[fn] !== 'function') {
    throw new Error(`el indexador "${MODULO}" no exporta ${fn}()`);
  }
  return m[fn](...args);
}

/* Cada consulta se escribe una sola vez y elige el modo aqui dentro. */
async function pedir(clave, fnModulo, args, opciones) {
  if (MODULO) return porModulo(fnModulo, args);
  if (BASE)   return porHttp(RUTAS[clave], opciones);
  throw new Error(
    'no hay indexador configurado: pon INDEXADOR_MODULO (paquete npm) '
    + 'o INDEXADOR_BASE (URL de la API) en /var/www/l-torrents/.env'
  );
}

/*
 * Normaliza un elemento del catalogo.
 *
 * Hay una errata en la documentacion de la API que conviene recordar: en el
 * primer ejemplo de getSeries el objeto con date/seeds/clients cuelga de
 * `magnet` en vez de venir en `torrentInfo`, que es como aparece en todos los
 * demas. Se contemplan las dos formas y ademas el caso de que no venga: sin
 * esto, un elemento asi tira la respuesta entera por un `undefined.seeds`.
 */
function normalizar(item, tipo) {
  const torrents = (item.torrents || []).map((t, i) => {
    const magnetEsTexto = typeof t.magnet === 'string';
    const info = t.torrentInfo || (!magnetEsTexto && t.magnet) || {};
    return {
      indice:  i,
      torrent: typeof t.torrent === 'string' ? t.torrent : null,
      magnet:  magnetEsTexto ? t.magnet : null,
      fecha:   info.date || null,
      semillas: Number(info.seeds) || 0,
      clientes: Number(info.clients) || 0,
    };
  /* Un elemento sin ninguno de los dos enlaces no se puede descargar, asi que
     no se ensena: pintar una tarjeta con los dos botones muertos solo hace
     perder tiempo a quien la pulsa. */
  }).filter((t) => t.torrent || t.magnet);

  const tamanoTxt = item.size || '';
  return {
    titulo:     String(item.title || '').trim(),
    portada:    item.poster || null,
    idioma:     item.lang || '',
    resolucion: item.resolution && item.resolution !== '---' ? item.resolution : '',
    tamanoTxt,
    tamanoBytes: nombrar.aBytes(tamanoTxt),
    tipo,
    torrents,
  };
}

/*
 * Que es serie y que es pelicula.
 *
 * Lo normal es que lo diga de donde salio la consulta: getSeries() son series
 * y getMovies() son peliculas. Pero search(), los generos y las calidades
 * mezclan las dos, y ahi hay que mirar el titulo — que en estas webs suele
 * traer "Temporada 3" o "Cap 305" delatandose solo. Si no hay ninguna senal,
 * pelicula, que es lo mas frecuente.
 *
 * Esto no es cosmetico: de este valor depende como se renombra al llegar al
 * buzon. Por eso la interfaz deja cambiarlo antes de descargar.
 */
function adivinarTipo(item) {
  const t = String(item.title || '');
  if (/\bTemporada\b/i.test(t)) return 'serie';
  if (nombrar.episodioDe(t)) return 'serie';
  return 'pelicula';
}

function normalizarLista(datos, tipoFijo) {
  if (!Array.isArray(datos)) {
    throw new Error('el indexador devolvio algo que no es una lista');
  }
  return datos
    .map((item) => normalizar(item, tipoFijo || adivinarTipo(item)))
    .filter((x) => x.titulo && x.torrents.length);
}

const peliculas = async (p = 1) => normalizarLista(await pedir('peliculas', 'getMovies',      [p], { p }), 'pelicula');
const series    = async (p = 1) => normalizarLista(await pedir('series',    'getSeries',      [p], { p }), 'serie');
const novedades = async (p = 1) => normalizarLista(await pedir('novedades', 'getNewReleases', [p], { p }), null);
const hdrip     = async (p = 1) => normalizarLista(await pedir('hdrip',     'getMoviesHDRip', [p], { p }), 'pelicula');
const microhd   = async (p = 1) => normalizarLista(await pedir('microhd',   'getMoviesMicroHD', [p], { p }), 'pelicula');

const porGenero  = async (g, p = 1) => normalizarLista(await pedir('genero',  'getContentByGenre',   [g, p], { p, q: g }), null);
const porCalidad = async (c, p = 1) => normalizarLista(await pedir('calidad', 'getContentByQuality', [c, p], { p, q: c }), null);

/* search() es la unica que no pagina en la documentacion. */
const buscar = async (q) => normalizarLista(await pedir('buscar', 'search', [q], { q }), null);

const FUENTES = {
  novedades: { nombre: 'Novedades', fn: novedades },
  peliculas: { nombre: 'Películas', fn: peliculas },
  series:    { nombre: 'Series',    fn: series },
  hdrip:     { nombre: 'HDRip',     fn: hdrip },
  microhd:   { nombre: 'MicroHD',   fn: microhd },
};

module.exports = {
  FUENTES, GENEROS, CALIDADES,
  peliculas, series, novedades, hdrip, microhd, porGenero, porCalidad, buscar,
  configurado: () => Boolean(MODULO || BASE),
  comoEstaConfigurado: () => (MODULO ? `módulo npm "${MODULO}"` : BASE ? `API en ${BASE}` : 'sin configurar'),
};
