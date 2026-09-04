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
   muerto. Sin esto se quedan "descargando" para siempre y el panel miente. */
const HORAS_SIN_AVANCE = Number(process.env.HORAS_SIN_AVANCE || 12);

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
  const limiteQuieto = Date.now() - HORAS_SIN_AVANCE * 3600 * 1000;

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

    if (!avanzo && !t.semillas && d.actualizada < limiteQuieto) {
      almacen.actualizar(d.id, {
        estado: 'error',
        motivo: `sin una sola semilla ni avance en ${HORAS_SIN_AVANCE} h; se da por muerta. `
              + 'El torrent sigue en transmission por si quieres esperar más.',
        terminada: Date.now(),
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
  if (DIAS_SEMBRANDO <= 0) return;
  const limite = Date.now() - DIAS_SEMBRANDO * 24 * 3600 * 1000;
  const viejas = almacen.listar(500).filter(
    (d) => d.estado === 'lista' && d.hash && d.terminada && d.terminada < limite
  );
  if (!viejas.length) return;

  const hashes = viejas.map((d) => d.hash);
  try {
    await transmision.quitar(hashes, true);
    for (const d of viejas) {
      almacen.actualizar(d.id, {
        hash: null,
        motivo: [d.motivo, `dejó de compartirse tras ${DIAS_SEMBRANDO} días; el disco local se liberó`]
          .filter(Boolean).join('. '),
      });
    }
    registro(`liberado el disco de ${viejas.length} descarga(s) ya colocadas`);
  } catch (e) {
    registro(`no se pudo limpiar: ${e.message}`);
  }
}

let temporizador = null;

function arrancar() {
  if (temporizador) return;
  const vuelta = async () => {
    try { await pasada(); } catch (e) { registro(`pasada con error: ${e.message}`); }
    try { await limpiar(); } catch (e) { registro(`limpieza con error: ${e.message}`); }
  };
  /* unref() para que este temporizador no impida que el proceso termine
     cuando systemd lo pare. */
  temporizador = setInterval(vuelta, INTERVALO);
  temporizador.unref();
  vuelta();
  registro(`vigilando cada ${INTERVALO / 1000} s; buzón en ${ENTRADA}`);
}

module.exports = { arrancar, pasada, recoger, explicarError };
