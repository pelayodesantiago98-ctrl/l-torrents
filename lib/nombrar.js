'use strict';
/*
 * De lo que trae el torrent al nombre que entiende el buzon.
 *
 * ─ Por que existe este fichero ──────────────────────────────────────────────
 *
 * /usr/local/sbin/procesar-entrada.js decide si algo es serie o pelicula
 * MIRANDO SOLO EL NOMBRE DEL FICHERO. No hay formulario ni metadatos: si el
 * nombre no casa con ninguno de sus tres patrones, lo da por pelicula y lo
 * deja en /var/media/peliculas, donde Jellyfin lo casa con el primer
 * largometraje de titulo parecido. Asi es como dos temporadas enteras de una
 * serie acabaron en Peliculas con la portada de otra cosa.
 *
 * l-torrents tiene una ventaja que el buzon no tiene: SABE si el usuario pulso
 * en la pestana de series o en la de peliculas, porque son dos llamadas
 * distintas del indexador. Este fichero gasta esa informacion en renombrar lo
 * descargado a algo que procesar-entrada.js no pueda malinterpretar, en vez de
 * confiar en como haya decidido llamarlo quien empaqueto el torrent.
 *
 * Los patrones de abajo son deliberadamente LOS MISMOS que los del buzon. Si
 * alli cambian, aqui tienen que cambiar: el objetivo es generar nombres que
 * aquel sepa leer, no inventar un formato nuevo.
 */

/* Copiados de procesar-entrada.js, a proposito. */
const RE_EP   = /[Ss](\d{1,2})[ ._-]*[Ee](\d{1,3})/;
const RE_X    = /(?:^|[ ._-])(\d{1,2})x(\d{2,3})(?!\d)/i;
const RE_CAP  = /\bCap(?:[íi]tulo)?\.?\s*(\d{3,4})\b/i;
const RE_ANYO = /[([]?((?:19|20)\d{2})[)\]]?/;

/* Propios de aqui: sirven para recortar el titulo de la serie, no para
   clasificar. */
const RE_TEMPORADA = /\s*[-–]?\s*Temporada\s*\d{1,2}\b/i;
const RE_CORCHETES = /\s*[[(][^\])]*[\])]\s*/g;

const VIDEO  = /\.(mkv|mp4|avi|m4v|mov|webm|ts|m2ts|wmv|flv)$/i;
/* Muestras, adelantos y "no lo veas antes de tiempo": son ficheros de video de
   verdad, asi que el filtro de extension no los quita, y si se cuelan Jellyfin
   se queda con el trailer en lugar del capitulo. */
const BASURA = /(^|[ ._-])(sample|muestra|trailer|proof|screens?)([ ._-]|\.|$)/i;

/*
 * "606.19 MBs" -> 635636285
 *
 * El indexador manda el tamano como texto y con la unidad pegada de cualquier
 * manera ("2 GBs", "1.98 GBs", "484.57 MBs"). Hace falta en numero para dos
 * cosas: ordenar y, sobre todo, negarse a empezar una descarga que no cabe.
 * Ante la duda devuelve 0, que el resto del codigo lee como "no se sabe" y no
 * como "ocupa cero".
 */
function aBytes(texto) {
  const m = String(texto || '').match(/([\d]+(?:[.,]\d+)?)\s*(K|M|G|T)i?Bs?\b/i);
  if (!m) return 0;
  const n = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(n)) return 0;
  const factor = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()];
  return Math.round(n * factor);
}

function humano(bytes) {
  if (!bytes) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 2)} ${u[i]}`;
}

/*
 * Temporada y episodio a partir de un texto cualquiera.
 *
 * Se prueban los tres patrones en el mismo orden que el buzon. El de "Cap 107"
 * pide 3 digitos como minimo porque los dos ultimos son el episodio y lo que
 * sobra por delante es la temporada: con "Cap 7" no se sabria de que temporada
 * habla, y adivinarlo seria peor que rendirse.
 */
function episodioDe(texto) {
  const t = String(texto || '');

  let m = t.match(RE_EP);
  if (m) return { temporada: Number(m[1]), episodio: Number(m[2]) };

  m = t.match(RE_X);
  if (m) return { temporada: Number(m[1]), episodio: Number(m[2]) };

  m = t.match(RE_CAP);
  if (m) {
    const n = m[1];
    const episodio = Number(n.slice(-2));
    const temporada = Number(n.slice(0, -2));
    if (temporada > 0 && episodio > 0) return { temporada, episodio };
  }

  return null;
}

function anyoDe(texto) {
  const m = String(texto || '').match(RE_ANYO);
  if (!m) return null;
  const n = Number(m[1]);
  /* Un limite alto y flojo: lo que se pretende es descartar numeros que solo
     parecen anos, como una resolucion 2160 o un "1080" suelto. */
  return n >= 1900 && n <= 2100 ? n : null;
}

/*
 * El titulo, limpio de todo lo que el indexador le cuelga detras.
 *
 * Llega cosas como "Juego de Tronos - Temporada 8 [Cap 807]" o
 * "Interstellar (2014) [BR-Screener]". Para Jellyfin solo sirve la parte de
 * delante; el resto lo aporta el patron SxxEyy o el ano, ya por separado.
 */
function tituloLimpio(texto) {
  let t = String(texto || '')
    .replace(RE_TEMPORADA, ' ')
    .replace(RE_CORCHETES, ' ')
    .replace(RE_EP, ' ')
    .replace(RE_X, ' ');

  /* El ano se quita del titulo pero se recupera aparte: en el nombre final va
     entre parentesis y en su sitio, que es como Jellyfin lo busca. */
  t = t.replace(RE_ANYO, ' ');

  return t
    .replace(/[._]+/g, ' ')
    .replace(/\s*[-–]\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* Windows y Jellyfin se llevan mal con estos, y un nombre con "/" dentro
   crearia carpetas por accidente. */
function seguro(nombre) {
  return String(nombre)
    .replace(/[/\\?%*:|"<>]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extension(ruta) {
  const m = String(ruta).match(/\.([A-Za-z0-9]{2,5})$/);
  return m ? m[1].toLowerCase() : 'mkv';
}

/*
 * El plan de traslado: que ficheros del torrent van al buzon y con que nombre.
 *
 * Devuelve { enlaces: [...], aviso } y NUNCA lanza. Un aviso significa "esto
 * se ha descargado bien pero no me atrevo a colocarlo": es preferible dejarlo
 * quieto y contarlo en el panel que soltarlo en el buzon con un nombre que
 * acabaria mandandolo a la biblioteca equivocada. Deshacer eso a mano es mucho
 * mas caro que leer un aviso.
 */
function planDeNombres({ tipo, tituloApi, ficheros }) {
  const videos = (ficheros || [])
    .filter((f) => VIDEO.test(f.nombre) && !BASURA.test(f.nombre))
    /* Los restos de menos de 40 MB en un pack casi siempre son extras o un
       capitulo cortado; colarlos en la biblioteca solo ensucia. */
    .filter((f) => f.bytes > 40 * 1024 * 1024);

  if (!videos.length) {
    return { enlaces: [], aviso: 'el torrent no trae ningun fichero de video aprovechable' };
  }

  const titulo = seguro(tituloLimpio(tituloApi)) || 'Sin titulo';

  if (tipo === 'pelicula') {
    /* De una pelicula interesa un solo fichero: el grande. Un torrent de
       pelicula con varios videos suele traer extras, y el largometraje es
       siempre el mayor con diferencia. */
    const principal = videos.slice().sort((a, b) => b.bytes - a.bytes)[0];
    const anyo = anyoDe(tituloApi) || anyoDe(principal.nombre);
    const nombre = seguro(anyo ? `${titulo} (${anyo})` : titulo);
    return {
      enlaces: [{ origen: principal.nombre, destino: `${nombre}.${extension(principal.nombre)}` }],
      aviso: null,
    };
  }

  /* Serie: cada video es un capitulo y cada uno necesita su propio SxxEyy.
     Se busca primero en el nombre del fichero, que es lo especifico, y solo
     si ahi no hay nada se recurre al titulo del indexador, que es igual para
     todos los ficheros del torrent y por tanto solo sirve cuando hay uno. */
  const enlaces = [];
  const sinEpisodio = [];

  for (const v of videos) {
    const ep = episodioDe(v.nombre)
      || (videos.length === 1 ? episodioDe(tituloApi) : null);

    if (!ep) { sinEpisodio.push(v.nombre); continue; }

    const s = String(ep.temporada).padStart(2, '0');
    const e = String(ep.episodio).padStart(2, '0');
    enlaces.push({
      origen: v.nombre,
      destino: seguro(`${titulo} S${s}E${e}`) + '.' + extension(v.nombre),
    });
  }

  if (!enlaces.length) {
    return {
      enlaces: [],
      aviso: 'no se pudo deducir temporada y episodio de ningun fichero, '
           + 'asi que no se mueve: en el buzon acabaria en Peliculas con la portada equivocada. '
           + `Ficheros: ${sinEpisodio.slice(0, 3).map((n) => n.split('/').pop()).join(', ')}`
           + (sinEpisodio.length > 3 ? ` y ${sinEpisodio.length - 3} mas` : ''),
    };
  }

  return {
    enlaces,
    /* Un pack donde SOLO algunos capitulos se dejan leer: se mueven los que
       si y se dice cuantos quedaron fuera. Media temporada colocada es mejor
       que ninguna, pero callarse los que faltan no. */
    aviso: sinEpisodio.length
      ? `${enlaces.length} capitulos colocados; ${sinEpisodio.length} sin temporada/episodio legible, quedan sin mover`
      : null,
  };
}

module.exports = { aBytes, humano, episodioDe, anyoDe, tituloLimpio, planDeNombres, seguro, VIDEO };
