'use strict';
/*
 * El bucle que vigila las descargas y las coloca en el buzon.
 *
 * ─ El traslado, y por que es un ENLACE DURO y no un mv ──────────────────────
 *
 * /var/torrents/completos y /var/media/entrada estan en el mismo disco
 * (/dev/vda1), asi que se puede crear un enlace duro: dos nombres para el
 * MISMO fichero, sin copiar un solo byte y sin ocupar el doble.
 *
 * Mover el fichero seria mas simple, pero rompe el envio: transmission
 * dejaria de encontrarlo y la descarga pasaria a "falta el fichero". Con el
 * enlace, transmission sigue compartiendo desde su nombre mientras
 * procesar-entrada.js se lleva el otro a la biblioteca. Cada uno tiene el
 * suyo y ninguno estorba al otro.
 *
 * Que esto funcione depende de tres cosas que ya estaban bien puestas en el
 * servidor, y conviene saberlo por si algun dia deja de ir:
 *
 *   - /var/torrents/completos es del grupo www-data y tiene el bit setgid,
 *     y transmission usa umask 2. Resultado: los ficheros salen rw-rw-r--
 *     con grupo www-data.
 *   - /proc/sys/fs/protected_hardlinks vale 1, o sea que solo se puede
 *     enlazar un fichero ajeno si se tiene lectura Y escritura sobre el.
 *     Lo de arriba es justo lo que lo cumple.
 *   - /var/media/entrada es del grupo jellyfin y www-data pertenece a el.
 *
 * Si alguien cambia los permisos de /var/torrents, esto empezara a dar EPERM
 * y la copia de respaldo (copiar el fichero) entrara sola, gastando disco.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const transmision = require('./transmision');
const almacen = require('./almacen');
const nombrar = require('./nombrar');

const ENTRADA   = process.env.BUZON || '/var/media/entrada';
const INTERVALO = Number(process.env.VIGILANCIA_MS || 15000);
/* Cuanto se deja compartiendo antes de borrar el torrent y sus datos. El
   fichero de la biblioteca no se toca: es el otro nombre del enlace y sigue
   ahi. Esto solo libera el disco local. 0 = no borrar nunca. */
const DIAS_SEMBRANDO = Number(process.env.DIAS_SEMBRANDO || 14);
/* Un torrent parado sin una sola semilla durante tanto tiempo se da por
   muerto. Sin esto se quedan "descargando" para siempre y el panel miente.
 *
 * Son DOS umbrales porque los dos casos no se parecen en nada:
 *
 *   - A cero bytes no hay enjambre que esperar. Si en doce horas no ha
 *     aparecido un solo peer, no va a aparecer: esperar mas solo ensucia
 *     la cola.
 *   - Con algo ya bajado si hay enjambre, aunque ahora mismo duerma. Los
 *     trackers espanoles (DivxTotaL, divxatope) caen y vuelven en ciclos de
 *     horas, y midiendo la cola se vieron huecos de hasta 32 h antes de
 *     revivir. A doce horas se mataba justo a los que seguian trabajando.
 *
 * Esperar de mas sale barato: `queue-stalled-minutes` (30 min) ya saca del
 * recuento de activos al que no avanza, asi que un torrent esperando no
 * ocupa turno, solo disco. */
const HORAS_SIN_AVANCE = Number(process.env.HORAS_SIN_AVANCE || 12);
const HORAS_SIN_AVANCE_CON_PROGRESO =
  Number(process.env.HORAS_SIN_AVANCE_CON_PROGRESO || 48);

/* El hueco que hay que dejar libre pase lo que pase: es el que exige
   procesar-entrada.js para ponerse a trabajar. */
const MARGEN_BYTES = Number(process.env.MARGEN_GB || 8) * 1024 ** 3;
const DESCARGAS = '/var/torrents/completos';
// La misma holgura que usa el planificador de l-archivos para arrancar. Se
// repite el numero a proposito: si aqui se admitiera con el limite justo, lo
// admitido lo aparcaria el otro en la vuelta siguiente.
const HOLGURA = 2 * 1024 ** 3;

/*
 * Lo que las subidas de l-archivos tienen pedido.
 *
 * Se lee de un fichero y no por HTTP porque son dos procesos distintos y esto
 * corre cada quince segundos: un fichero de cien bytes con una fecha de
 * caducidad dentro es mas barato y mas dificil de romper que una llamada. Lo
 * escribe el planificador de l-archivos en cada pasada suya.
 *
 * Si no existe, esta viejo o no se entiende, sale cero: perder la prioridad es
 * molesto, pero frenar todas las descargas por un fichero raro seria peor.
 */
const RESERVA_SUBIDAS = '/var/archivos/.parciales/.reserva.json';

function reservadoPorSubidas() {
  try {
    const r = JSON.parse(fs.readFileSync(RESERVA_SUBIDAS, 'utf8'));
    if (!r || !(Number(r.hasta) > Date.now())) return { bytes: 0, mayor: 0 };
    return { bytes: Number(r.bytes) || 0, mayor: Number(r.mayor) || 0 };
  } catch {
    return { bytes: 0, mayor: 0 };
  }
}

const registro = (m) => console.log(`[cosecha] ${m}`);

/*
 * Coloca un fichero en el buzon.
 *
 * Devuelve el nombre final, que puede no ser el pedido: si ya habia algo con
 * ese nombre se le anade un sufijo en vez de pisarlo. Pisar seria perder la
 * version anterior sin que nadie se entere, y aqui "ya existe" suele
 * significar que se pidio dos veces la misma cosa.
 */
async function colocar(origen, destino) {
  let final = path.join(ENTRADA, destino);
  const ext = path.extname(destino);
  const base = destino.slice(0, -ext.length || undefined);

  for (let i = 2; fs.existsSync(final) && i < 50; i += 1) {
    final = path.join(ENTRADA, `${base} (${i})${ext}`);
  }

  try {
    await fsp.link(origen, final);
    return { nombre: path.basename(final), copiado: false };
  } catch (e) {
    /* EXDEV = distinto sistema de ficheros; EPERM = protected_hardlinks dijo
       que no. En ambos casos queda copiar, que funciona igual pero gasta el
       doble de disco. Se registra porque es sintoma de que algo cambio en el
       servidor, no de un problema de esta descarga. */
    if (e.code !== 'EXDEV' && e.code !== 'EPERM' && e.code !== 'EMLINK') throw e;
    registro(`no se pudo enlazar (${e.code}), copiando: ${path.basename(origen)}`);
    await fsp.copyFile(origen, final);
    return { nombre: path.basename(final), copiado: true };
  }
}

/*
 * Una descarga que transmission ya termino: se decide que hacer con ella.
 *
 * Puede acabar en tres sitios distintos y los tres son finales:
 *   lista  -> colocada en el buzon; procesar-entrada.js hara el resto
 *   aviso  -> descargada pero sin colocar, y se explica el motivo
 *   error  -> no habia nada aprovechable, o fallo el traslado
 */
async function recoger(d) {
  almacen.actualizar(d.id, { estado: 'moviendo', motivo: null });

  const info = await transmision.ficheros(d.hash);
  if (!info) {
    almacen.actualizar(d.id, {
      estado: 'error',
      motivo: 'transmission dice que ya no tiene este torrent',
    });
    return;
  }

  const plan = nombrar.planDeNombres({
    tipo: d.tipo,
    tituloApi: d.titulo,
    ficheros: info.ficheros,
  });

  if (!plan.enlaces.length) {
    /* Sin nada que colocar. Es "aviso" y no "error" cuando el problema es que
       no se sabe como nombrarlo: el fichero esta bien y esta ahi, solo hace
       falta que alguien decida. Se dice donde esta para poder ir a por el. */
    almacen.actualizar(d.id, {
      estado: 'aviso',
      motivo: `${plan.aviso}. Los ficheros siguen en ${info.carpeta}`,
      progreso: 1,
      terminada: Date.now(),
    });
    registro(`aviso en #${d.id} "${d.titulo}": ${plan.aviso}`);
    return;
  }

  const puestos = [];
  for (const e of plan.enlaces) {
    const origen = path.resolve(info.carpeta, e.origen);
    /* Un torrent malicioso podria traer rutas con ".." para escribir fuera.
       transmission ya las rechaza, pero esto no cuesta nada y es la ultima
       linea antes de tocar el disco. */
    if (!origen.startsWith(path.resolve(info.carpeta) + path.sep)) {
      registro(`ruta sospechosa descartada en #${d.id}: ${e.origen}`);
      continue;
    }
    try {
      const r = await colocar(origen, e.destino);
      puestos.push(r.nombre);
    } catch (err) {
      almacen.actualizar(d.id, {
        estado: 'error',
        motivo: `descargada, pero no se pudo dejar en el buzón: ${err.code || ''} ${err.message}`.trim(),
        progreso: 1,
        terminada: Date.now(),
      });
      registro(`fallo al colocar #${d.id}: ${err.message}`);
      return;
    }
  }

  almacen.actualizar(d.id, {
    estado: 'lista',
    /* El aviso puede sobrevivir a un final correcto: es el caso del pack al
       que le faltan capitulos legibles. Se colocaron los que se pudo y hay
       que decir que no fue todo. */
    motivo: plan.aviso,
    progreso: 1,
    destino: puestos.join(' · '),
    terminada: Date.now(),
  });
  registro(`#${d.id} "${d.titulo}": ${puestos.length} fichero(s) en el buzón`);
}

/* El texto que se le ensena al usuario cuando transmission marca error. Su
   `errorString` lo escribe el tracker y suele venir en ingles y sin contexto;
   se le pone delante de que tipo de fallo es. */
function explicarError(t) {
  const familia = t.errorFamilia || 'error';
  const texto = t.errorTexto || 'sin detalle';
  if (t.errorNum === 2 && /unregistered|not (found|registered)|torrent not/i.test(texto)) {
    return `${familia}: el tracker ya no conoce este torrent (${texto}). Suele pasar con enlaces viejos; prueba otra versión.`;
  }
  if (t.errorNum === 3 && /no space|espacio/i.test(texto)) {
    return `${familia}: se quedó sin espacio en disco (${texto})`;
  }
  if (t.errorNum === 3 && /permission/i.test(texto)) {
    return `${familia}: transmission no puede escribir donde descarga (${texto})`;
  }
  return `${familia}: ${texto}`;
}

/*
 * ── La cola de entrada ──────────────────────────────────────────────────────
 *
 * Antes, una descarga que no cabía se rechazaba en la puerta con un 507 y había
 * que acordarse de volver a pedirla más tarde. Ya no: se acepta siempre y se
 * queda en `pendiente`, que es un estado que ya existía para justo esto —
 * «aceptada, todavía no está en transmission». Aquí se le va dando salida.
 *
 * La cuenta es la misma que hace el planificador de l-archivos, y tiene que
 * serlo, porque los dos escriben en el mismo disco:
 *
 *   de lo libre se descuenta lo que las descargas en marcha aún tienen que
 *   escribir, se aparta el tamaño del fichero más grande —- porque
 *   procesar-entrada.js hace una COPIA ENTERA en /var/media/.trabajo al
 *   prepararlo, y hasta que no acaba ocupa el doble -- y se deja el margen.
 *
 * Sin apartar esa copia pasa lo peor: el disco se llena de descargas, el buzón
 * se niega a arrancar por falta de sitio, nada sube a la Storage Box, nada se
 * borra del VPS y el disco se queda lleno para siempre.
 *
 * El orden es estricto, por fecha de petición. Dejar que las pequeñas adelanten
 * a las grandes es como una descarga de 30 GB se queda esperando eternamente
 * mientras van pasando capítulos por delante.
 */
function mayorEnBuzon() {
  let mayor = 0;
  try {
    for (const n of fs.readdirSync(ENTRADA)) {
      if (n.startsWith('.')) continue;
      try { mayor = Math.max(mayor, fs.statSync(path.join(ENTRADA, n)).size); } catch { /* se fue */ }
    }
  } catch { /* sin buzón, sin reserva */ }
  return mayor;
}

async function admitir() {
  const cola = almacen.listar(500)
    .filter((d) => d.estado === 'pendiente' && !d.hash)
    .sort((a, b) => a.creada - b.creada);
  if (!cola.length) return;

  let libre, torrents;
  try {
    libre = await transmision.espacioLibre(DESCARGAS);
    torrents = await transmision.consultar();
  } catch (e) {
    registro(`no puedo mirar el disco, la cola espera: ${e.message}`);
    return;
  }

  /* Las subidas de casa van por delante: su sitio se aparta antes de repartir
     nada entre las descargas. */
  const subidas = reservadoPorSubidas();
  let porEscribir = subidas.bytes;
  let mayor = Math.max(mayorEnBuzon(), subidas.mayor);
  for (const t of torrents) {
    if (t.terminado) continue;
    porEscribir += t.faltan || 0;
    mayor = Math.max(mayor, t.bytes || 0);
  }

  for (const d of cola) {
    const suyo = d.tamano_bytes || 0;
    const conEl = porEscribir + suyo;
    const conMayor = Math.max(mayor, suyo);

    /* Si no se sabe lo que ocupa (el indexador no lo dijo) se deja pasar: es lo
       que se hacía antes, y pararla sería no bajarla nunca. En cuanto tenga
       metadatos su tamaño ya cuenta como el de cualquier otra. */
    if (suyo && libre - conEl - conMayor - MARGEN_BYTES - HOLGURA < 0) {
      const hueco = Math.max(0, libre - porEscribir - mayor - MARGEN_BYTES - HOLGURA);
      almacen.actualizar(d.id, {
        motivo: `en cola: no hay sitio en el disco todavía. Ocupa ${nombrar.humano(suyo)} y `
              + (hueco > 0
                  ? `ahora mismo solo se puede pedir ${nombrar.humano(hueco)}. `
                  : 'ahora mismo no hay nada disponible. ')
              + 'Arranca sola en cuanto el buzón suba a la caja lo que tiene pendiente.',
      });
      break;                      // orden estricto: los de detrás también esperan
    }

    try {
      const alta = d.via === 'magnet'
        ? await transmision.anadirMagnet(d.enlace)
        : await transmision.anadirTorrent(d.enlace);

      const previa = almacen.porHash(alta.hash);
      if (previa && previa.id !== d.id) {
        almacen.actualizar(d.id, {
          estado: 'aviso',
          motivo: `ya se había pedido lo mismo (descarga #${previa.id}); no se duplica`,
          terminada: Date.now(),
        });
        continue;
      }

      almacen.actualizar(d.id, {
        hash: alta.hash,
        estado: 'descargando',
        motivo: alta.repetido ? 'ya estaba en transmission; se reaprovecha' : null,
      });
      registro(`#${d.id} "${d.titulo}" sale de la cola y empieza (${nombrar.humano(suyo)})`);
      porEscribir = conEl;
      mayor = conMayor;
    } catch (e) {
      almacen.actualizar(d.id, { estado: 'error', motivo: e.message, terminada: Date.now() });
      registro(`#${d.id} "${d.titulo}" no se pudo dar de alta: ${e.message}`);
    }
  }
}

/*
 * Una pasada completa.
 *
 * Se pide a transmission el estado de TODOS los torrents de una vez y luego se
 * cruza con lo que hay guardado: una sola llamada al RPC por vuelta, aunque
 * haya cuarenta descargas activas.
 */
async function pasada() {
  const activas = almacen.listarActivas();
  if (!activas.length) return;

  let torrents;
  try {
    torrents = await transmision.consultar();
  } catch (e) {
    /* Si transmission no contesta NO se marca nada como fallido: lo mas
       probable es que este reiniciandose. Las descargas siguen donde estaban
       y en la siguiente vuelta se vera. Marcar error aqui seria mentir. */
    registro(`no se pudo consultar: ${e.message}`);
    return;
  }

  const porHash = new Map(torrents.map((t) => [t.hash, t]));
  const ahora = Date.now();
  const limiteSinBytes = ahora - HORAS_SIN_AVANCE * 3600 * 1000;
  const limiteConBytes = ahora - HORAS_SIN_AVANCE_CON_PROGRESO * 3600 * 1000;

  for (const d of activas) {
    if (!d.hash) continue;                       // aun no dada de alta
    const t = porHash.get(d.hash);

    if (!t) {
      almacen.actualizar(d.id, {
        estado: 'error',
        motivo: 'el torrent ya no está en transmission (se quitó desde fuera)',
        terminada: Date.now(),
      });
      continue;
    }

    if (t.errorNum) {
      almacen.actualizar(d.id, { estado: 'error', motivo: explicarError(t), terminada: Date.now() });
      registro(`#${d.id} "${d.titulo}" falla: ${t.errorTexto}`);
      continue;
    }

    if (t.terminado) {
      try {
        await recoger({ ...d, hash: d.hash });
      } catch (e) {
        almacen.actualizar(d.id, {
          estado: 'error',
          motivo: `fallo al colocar en el buzón: ${e.message}`,
          terminada: Date.now(),
        });
      }
      continue;
    }

    /* Aparcada por falta de disco, no muerta.
     *
     * transmission lo comparten esta app y la pestaña de torrents de
     * l-archivos, y el planificador de allí para lo que no cabe. Un torrent
     * parado no tiene semillas ni avanza, que es exactamente la firma de una
     * descarga muerta: sin esta salida, a las doce horas se daría por perdida
     * una que solo estaba esperando su turno. */
    if (t.esperandoDisco) {
      almacen.actualizar(d.id, {
        estado: 'descargando',
        progreso: t.progreso,
        velocidad: 0,
        semillas: 0,
        tamano_bytes: t.bytes || d.tamano_bytes,
        motivo: 'esperando sitio en el disco; arranca sola cuando el buzón libere',
      });
      continue;
    }

    /* Sigue viva: se refresca el progreso para el panel. */
    const avanzo = t.progreso > (d.progreso || 0) + 0.0001 || t.velocidad > 0;
    almacen.actualizar(d.id, {
      estado: 'descargando',
      progreso: t.progreso,
      velocidad: t.velocidad,
      semillas: t.semillas,
      tamano_bytes: t.bytes || d.tamano_bytes,
      /* Un magnet sin metadatos no esta parado, esta buscando: decirlo evita
         que parezca colgado durante los primeros minutos. */
      motivo: t.metadatos < 1
        ? 'buscando los datos del magnet en la red…'
        : (!t.semillas && !avanzo ? 'sin semillas ahora mismo' : null),
    });

    /* Lo que ya trae bytes ha demostrado enjambre: se le espera más. */
    const conProgreso = (t.progreso || 0) > 0;
    const limiteQuieto = conProgreso ? limiteConBytes : limiteSinBytes;
    const horasEsperadas = conProgreso
      ? HORAS_SIN_AVANCE_CON_PROGRESO
      : HORAS_SIN_AVANCE;

    if (!avanzo && !t.semillas && d.actualizada < limiteQuieto) {
      almacen.actualizar(d.id, {
        estado: 'error',
        motivo: `sin una sola semilla ni avance en ${horasEsperadas} h; se da por muerta. `
              + 'El torrent sigue en transmission por si quieres esperar más.',
        terminada: ahora,
      });
      registro(`#${d.id} "${d.titulo}" abandonada por falta de semillas`);
    }
  }
}

/*
 * Limpieza del disco local.
 *
 * Solo toca torrents que YA estan colocados en la biblioteca y que llevan
 * compartiendo mas de DIAS_SEMBRANDO. Borra el torrent y sus datos de
 * /var/torrents; el fichero de Jellyfin no se ve afectado porque es el otro
 * nombre del enlace duro.
 *
 * Hace falta: el VPS tiene 63 GB libres y procesar-entrada.js se niega a
 * trabajar por debajo de 8 GB. Sin esto, unas cuantas peliculas en 1080p
 * bastan para dejar el buzon parado sin que nada lo explique.
 */
async function limpiar() {
  const listas = almacen.listar(500).filter((d) => d.estado === 'lista' && d.hash);
  if (!listas.length) return;

  /* Un fichero desaparece del buzon en cuanto procesar-entrada.js lo sube a la
     Storage Box (borra el enlace duro). Cuando TODOS los de una descarga han
     salido del buzon, la copia que transmission sigue compartiendo es lo unico
     que queda ocupando disco local: se quita ya, con sus datos, sin esperar. */
  const fueraDelBuzon = (d) => {
    const nombres = String(d.destino || '').split(' · ').map((s) => s.trim()).filter(Boolean);
    if (!nombres.length) return false;
    return nombres.every((n) => !fs.existsSync(path.join(ENTRADA, n)));
  };
  const subidas = listas.filter(fueraDelBuzon);

  /* Red de seguridad por tiempo: descargas que se quedan en el buzon sin llegar
     a subirse (p. ej. algo que ni convirtiendo cabe). Pasado DIAS_SEMBRANDO se
     corta al menos el sembrado. Con 0 se desactiva este plazo. */
  const limite = DIAS_SEMBRANDO > 0 ? Date.now() - DIAS_SEMBRANDO * 24 * 3600 * 1000 : null;
  const viejas = limite
    ? listas.filter((d) => !subidas.includes(d) && d.terminada && d.terminada < limite)
    : [];

  const objetivo = [...subidas, ...viejas];
  if (!objetivo.length) return;

  try {
    await transmision.quitar(objetivo.map((d) => d.hash), true);
    for (const d of objetivo) {
      const nota = subidas.includes(d)
        ? 'colocada en la Storage Box; el disco local se liberó'
        : `dejó de compartirse tras ${DIAS_SEMBRANDO} días; el disco local se liberó`;
      almacen.actualizar(d.id, {
        hash: null,
        motivo: [d.motivo, nota].filter(Boolean).join('. '),
      });
    }
    registro(`liberado el disco de ${objetivo.length} descarga(s) ya en la caja`);
  } catch (e) {
    registro(`no se pudo limpiar: ${e.message}`);
  }
}

let temporizador = null;

function arrancar() {
  if (temporizador) return;
  /* El orden importa: primero se mira lo que hay, luego se libera lo que ya
     está en la caja y solo al final se admite de la cola. Al revés, la cola
     miraría un disco que está a punto de vaciarse y esperaría una vuelta de
     más por nada. */
  const vuelta = async () => {
    try { await pasada(); } catch (e) { registro(`pasada con error: ${e.message}`); }
    try { await limpiar(); } catch (e) { registro(`limpieza con error: ${e.message}`); }
    try { await admitir(); } catch (e) { registro(`cola con error: ${e.message}`); }
  };
  /* unref() para que este temporizador no impida que el proceso termine
     cuando systemd lo pare. */
  temporizador = setInterval(vuelta, INTERVALO);
  temporizador.unref();
  vuelta();
  registro(`vigilando cada ${INTERVALO / 1000} s; buzón en ${ENTRADA}`);
}

module.exports = { arrancar, pasada, recoger, admitir, explicarError };
