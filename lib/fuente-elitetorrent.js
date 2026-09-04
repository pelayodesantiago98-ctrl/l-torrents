"use strict";
/*
 * Envoltorio de elitetorrent. INDEXADOR_MODULO apunta aqui, no al paquete.
 *
 * Resuelve dos cosas que el paquete de npm (v1.0.1) hace mal para nuestro uso:
 *
 * 1. DOMINIO MUERTO. El paquete trae fijo en su codigo compilado
 *      build/{main,module}/urls/index.js -> BASE_URL = "https://www.elitetorrent.se"
 *    y ese dominio ya no resuelve. El sitio se mudo a www.elitetorrent.com, que
 *    sirve el mismo HTML y el scraper sigue valiendo. En vez de parchear
 *    node_modules (se pierde al reinstalar) se sobreescribe BASE_URL en runtime:
 *    el codigo del paquete lee esa constante al construir cada URL.
 *
 * 2. ENLACES OFUSCADOS. Los campos torrent y magnet no vienen directos, sino
 *    envueltos en el acortador acortame-esto.com/s.php?i=<blob>. Ese <blob> es
 *    base64 anidado varias veces y, en la ultima capa, ROT13. Al descifrarlo
 *    sale el .torrent o el magnet de verdad. Si no se hace esto, transmision
 *    recibe una pagina HTML en vez de un torrent y toda descarga falla.
 *    Se descifra aqui, en la fuente, porque es una rareza de este indexador y
 *    no algo que deba conocer el resto de l-torrents.
 *
 * Si el dominio vuelve a cambiar, se toca DOMINIO (o la env ELITETORRENT_BASE).
 */

const DOMINIO = process.env.ELITETORRENT_BASE || "https://www.elitetorrent.com";
require("elitetorrent/build/main/urls").BASE_URL = DOMINIO;
const et = require("elitetorrent");

const rot13 = (s) =>
  s.replace(/[A-Za-z]/g, (c) =>
    String.fromCharCode((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26)
  );

/*
 * Descifra un enlace del acortador. Va pelando capas de base64 mientras el
 * resultado siga siendo texto imprimible y, en cada capa, prueba si aplicarle
 * ROT13 ya deja un http(s):// o un magnet: — que es la senal de haber llegado
 * al fondo. Si el enlace no es del acortador o no se puede descifrar, se
 * devuelve tal cual: fallara mas adelante, pero con el mensaje claro que ya da
 * transmision, y nunca peor que ahora.
 */
function descifrarEnlace(url) {
  const m = /[?&]i=([^&]+)/.exec(url || "");
  if (!m) return url;
  let v = decodeURIComponent(m[1]);
  for (let n = 0; n < 12; n++) {
    const r = rot13(v);
    if (/^(https?:|magnet:)/i.test(r)) return r;
    let d;
    try { d = Buffer.from(v, "base64").toString("latin1"); } catch { break; }
    if (!d || !/^[\x20-\x7e]+$/.test(d)) break;
    v = d;
  }
  return url;
}

/* Reescribe torrent y magnet de cada elemento dejando el resto intacto. */
function limpiar(lista) {
  if (!Array.isArray(lista)) return lista;
  for (const item of lista) {
    for (const t of item && item.torrents || []) {
      if (typeof t.torrent === "string") t.torrent = descifrarEnlace(t.torrent);
      if (typeof t.magnet === "string") t.magnet = descifrarEnlace(t.magnet);
    }
  }
  return lista;
}

/* Se reexporta cada funcion del paquete envuelta para descifrar su salida. Las
   ocho que consume lib/indexador.js devuelven listas de elementos. */
const FUNCIONES = [
  "getMovies", "getSeries", "getNewReleases", "getMoviesHDRip",
  "getMoviesMicroHD", "getContentByGenre", "getContentByQuality", "search",
];
for (const nombre of FUNCIONES) {
  const original = et[nombre];
  module.exports[nombre] =
    typeof original === "function"
      ? async (...args) => limpiar(await original.apply(et, args))
      : original;
}
