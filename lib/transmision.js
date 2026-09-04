'use strict';
/*
 * Cliente del RPC de transmission-daemon.
 *
 * transmission ya estaba instalado y corriendo en el VPS antes que esto, con
 * el RPC escuchando solo en 127.0.0.1 y con usuario y clave. Aqui no se
 * gestiona ninguna descarga a mano: transmission es quien descarga, verifica
 * y comparte, y este fichero es solo la forma de hablarle.
 *
 * Dos rarezas del protocolo que hay que conocer para no volverse loco:
 *
 * 1. La primera peticion SIEMPRE responde 409 con una cabecera
 *    X-Transmission-Session-Id. No es un error: es su proteccion contra CSRF.
 *    Hay que guardar ese valor y repetir la peticion con el. Ademas caduca,
 *    asi que el 409 puede reaparecer en cualquier momento y hay que rehacer el
 *    saludo, no solo al arrancar.
 *
 * 2. `result` viene como texto: "success" o el motivo del fallo. Un HTTP 200
 *    con result "invalid or corrupt torrent file" es un fallo, y si no se mira
 *    se cuela como si todo hubiera ido bien.
 */

const RPC      = process.env.TRANSMISION_URL || 'http://127.0.0.1:9091/transmission/rpc';
const USUARIO  = process.env.TRANSMISION_USUARIO || '';
const CLAVE    = process.env.TRANSMISION_CLAVE || '';
const ESPERA_MS = Number(process.env.TRANSMISION_ESPERA_MS || 20000);

/* El id de sesion se cachea porque vale para todas las peticiones siguientes.
   Es lo unico con estado que hay aqui. */
let idSesion = null;

/* Los estados que devuelve transmission son numeros. Traducirlos aqui, en un
   solo sitio, evita que el resto del codigo lleve numeros magicos sueltos. */
const ESTADOS = {
  0: 'parado',
  1: 'esperando comprobacion',
  2: 'comprobando',
  3: 'en cola',
  4: 'descargando',
  5: 'esperando para compartir',
  6: 'compartiendo',
};

/* Y los codigos de error, que son solo cuatro. El texto de `errorString` lo
   escribe el tracker o el sistema operativo y puede ser cualquier cosa, asi
   que se conserva tal cual y esto solo dice de que familia es. */
const ERRORES = {
  1: 'aviso del tracker',
  2: 'error del tracker',
  3: 'error local',
};

function cabeceras() {
  const h = { 'Content-Type': 'application/json' };
  if (USUARIO) {
    h.Authorization = 'Basic ' + Buffer.from(`${USUARIO}:${CLAVE}`).toString('base64');
  }
  if (idSesion) h['X-Transmission-Session-Id'] = idSesion;
  return h;
}

async function llamar(metodo, argumentos = {}, yaReintentado = false) {
  let res;
  try {
    res = await fetch(RPC, {
      method: 'POST',
      headers: cabeceras(),
      body: JSON.stringify({ method: metodo, arguments: argumentos }),
      signal: AbortSignal.timeout(ESPERA_MS),
    });
  } catch (e) {
    /* Aqui caen tanto "transmission esta parado" como "tarda demasiado". Se
       distinguen porque el mensaje de arriba es lo unico que vera el usuario
       en el panel de descargas. */
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new Error(`transmission no responde (mas de ${Math.round(ESPERA_MS / 1000)} s)`);
    }
    throw new Error(`no se puede hablar con transmission: ${e.message}`);
  }

  if (res.status === 409) {
    const nuevo = res.headers.get('x-transmission-session-id');
    /* El guardia del reintento importa: sin el, un 409 permanente (por ejemplo
       si algo se pone delante del RPC) seria recursion infinita. */
    if (!nuevo || yaReintentado) throw new Error('transmission no entrega un X-Transmission-Session-Id valido');
    idSesion = nuevo;
    return llamar(metodo, argumentos, true);
  }

  if (res.status === 401) throw new Error('transmission rechaza el usuario o la clave del RPC');
  if (!res.ok) throw new Error(`transmission responde ${res.status}`);

  const cuerpo = await res.json();
  if (cuerpo.result !== 'success') throw new Error(`transmission: ${cuerpo.result}`);
  return cuerpo.arguments || {};
}

/*
 * Anadir por magnet.
 *
 * El magnet se le pasa entero a transmission en `filename` y es el quien
 * resuelve los metadatos por la red. Por eso una descarga por magnet tarda un
 * rato en saber siquiera como se llama o cuanto ocupa: hasta que no encuentra
 * a alguien que le pase el .torrent, el nombre que muestra es el hash.
 */
async function anadirMagnet(magnet) {
  return interpretarAlta(await llamar('torrent-add', { filename: magnet, paused: false }));
}

/*
 * Anadir por .torrent.
 *
 * Aqui NO se le pasa la URL a transmission para que la baje el. Se baja desde
 * este proceso y se le entrega el contenido en base64 (`metainfo`), por dos
 * motivos:
 *
 *   - Si la descarga del .torrent falla (403, la web caida, una redireccion a
 *     una pagina de anuncios), el error se ve aqui y se puede contar en claro.
 *     Dejandoselo a transmission, lo unico que se saca es un "invalid or
 *     corrupt torrent file" que no dice donde estuvo el problema.
 *   - transmission corre con hardening de systemd y sin salir a buscar cosas
 *     por HTTP a webs de terceros; ese trabajo es mejor aqui.
 *
 * Esta es la diferencia real entre los dos botones de la interfaz, y no un
 * capricho: por .torrent se sabe el tamano y el contenido desde el primer
 * segundo; por magnet hay que esperar a los metadatos.
 */
async function anadirTorrent(url) {
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(ESPERA_MS),
      headers: { 'User-Agent': 'l-torrents/0.1 (lepayimio.es)' },
    });
  } catch (e) {
    throw new Error(`no se pudo descargar el .torrent: ${e.message}`);
  }
  if (!res.ok) throw new Error(`el .torrent responde ${res.status} ${res.statusText}`);

  const datos = Buffer.from(await res.arrayBuffer());
  if (!datos.length) throw new Error('el .torrent vino vacio');
  /* Un .torrent es bencode y siempre empieza por "d". Si lo que llega es HTML
     —una pagina de error, un captcha, un aviso de "espera 10 segundos"— se
     detecta aqui y no tres pasos mas adelante como "corrupto". */
  if (datos[0] !== 0x64) {
    const pista = datos.subarray(0, 80).toString('utf8').replace(/\s+/g, ' ').trim();
    throw new Error(`el enlace no devolvio un .torrent sino otra cosa: "${pista}"`);
  }

  return interpretarAlta(await llamar('torrent-add', {
    metainfo: datos.toString('base64'),
    paused: false,
  }));
}

/* torrent-add contesta en una clave o en otra segun sea nuevo o repetido. Que
   este duplicado no es un error: casi siempre significa que ya se pidio antes
   y sigue compartiendose, asi que se devuelve el mismo hash y se avisa. */
function interpretarAlta(r) {
  const t = r['torrent-added'] || r['torrent-duplicate'];
  if (!t) throw new Error('transmission acepto la peticion pero no devolvio ningun torrent');
  return {
    id: t.id,
    hash: String(t.hashString || '').toLowerCase(),
    nombre: t.name || '',
    repetido: Boolean(r['torrent-duplicate']),
  };
}

/* Consulta ligera, la del bucle de vigilancia: solo lo que hace falta para
   pintar la barra de progreso y detectar fallos. La lista de ficheros NO se
   pide aqui a proposito — en un pack de temporada son decenas de entradas y
   esto se ejecuta cada pocos segundos. */
const CAMPOS = [
  'hashString', 'id', 'name', 'percentDone', 'rateDownload', 'status',
  'error', 'errorString', 'eta', 'totalSize', 'sizeWhenDone', 'leftUntilDone',
  'isFinished', 'doneDate', 'peersSendingToUs', 'metadataPercentComplete',
];

async function consultar(hashes) {
  const args = { fields: CAMPOS };
  if (Array.isArray(hashes)) {
    if (!hashes.length) return [];
    args.ids = hashes;
  }
  const r = await llamar('torrent-get', args);
  return (r.torrents || []).map(normalizar);
}

/* La consulta cara, solo cuando un torrent termina: hace falta saber que
   ficheros trae para decidir cuales se enlazan al buzon. */
async function ficheros(hash) {
  const r = await llamar('torrent-get', { ids: [hash], fields: ['hashString', 'downloadDir', 'files'] });
  const t = (r.torrents || [])[0];
  if (!t) return null;
  return {
    carpeta: t.downloadDir,
    ficheros: (t.files || []).map((f) => ({ nombre: f.name, bytes: f.length })),
  };
}

function normalizar(t) {
  return {
    id: t.id,
    hash: String(t.hashString || '').toLowerCase(),
    nombre: t.name || '',
    progreso: Number(t.percentDone) || 0,
    /* Con magnet, antes de tener metadatos percentDone es 0 y no significa
       "no avanza": significa "todavia no sabe que descargar". Se distingue
       con este campo para poder decirselo al usuario. */
    metadatos: Number(t.metadataPercentComplete ?? 1),
    velocidad: Number(t.rateDownload) || 0,
    estadoNum: Number(t.status),
    estado: ESTADOS[t.status] || `desconocido (${t.status})`,
    errorNum: Number(t.error) || 0,
    errorFamilia: ERRORES[t.error] || null,
    errorTexto: t.errorString || '',
    segundosRestantes: Number(t.eta),
    bytes: Number(t.sizeWhenDone) || Number(t.totalSize) || 0,
    faltan: Number(t.leftUntilDone) || 0,
    terminado: Boolean(t.isFinished) || Number(t.percentDone) >= 1,
    semillas: Number(t.peersSendingToUs) || 0,
  };
}

async function quitar(hashes, borrarDatos) {
  if (!hashes.length) return;
  await llamar('torrent-remove', { ids: hashes, 'delete-local-data': Boolean(borrarDatos) });
}

/* Para el arranque y para la pagina de estado: comprueba que se puede hablar
   con transmission y de paso devuelve donde deja las descargas, que es lo que
   necesita la cosecha para encontrar los ficheros. */
async function comprobar() {
  const s = await llamar('session-get', {});
  return {
    version: s.version,
    carpetaDescargas: s['download-dir'],
    libreBytes: null,
    sembrando: s['seedRatioLimited'] ? s['seedRatioLimit'] : null,
  };
}

/* Espacio libre segun el propio transmission: es el numero que importa, porque
   es el del sistema de ficheros donde el va a escribir, no donde corra esto. */
async function espacioLibre(carpeta) {
  const r = await llamar('free-space', { path: carpeta });
  return Number(r['size-bytes']) || 0;
}

module.exports = {
  anadirMagnet, anadirTorrent, consultar, ficheros, quitar, comprobar, espacioLibre,
  ESTADOS, ERRORES,
};
