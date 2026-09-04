'use strict';
/*
 * La memoria de l-torrents.
 *
 * transmission ya sabe que torrents tiene y como van, asi que esto NO duplica
 * su estado. Guarda lo que transmission no puede saber y se perderia:
 *
 *   - Que se pidio realmente: el titulo del indexador, la portada, el idioma.
 *     transmission solo conoce el nombre del torrent, que a veces es un hash.
 *   - Si el usuario venia de series o de peliculas. Sin eso no se puede
 *     renombrar bien al llegar al buzon (ver nombrar.js).
 *   - Que paso DESPUES de descargar: si se movio al buzon, a donde, o por que
 *     no. Eso ocurre fuera de transmission y no queda registrado en ningun
 *     otro sitio.
 *   - El historico. Cuando un torrent se quita de transmission desaparece con
 *     el todo rastro de que existio; aqui la linea se queda, que es lo que
 *     permite contestar "que se completo y que fallo".
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const RUTA = process.env.BASE_DATOS || '/var/www/l-torrents/data/l-torrents.sqlite3';

fs.mkdirSync(path.dirname(RUTA), { recursive: true });
const db = new Database(RUTA);

/* WAL para que el bucle de vigilancia, que escribe cada pocos segundos, no
   bloquee a las peticiones web que solo leen. */
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

/*
 * Los estados posibles, y son pocos a proposito:
 *
 *   pendiente    aceptada, todavia no esta en transmission
 *   descargando  transmission trabajando (incluye buscar metadatos del magnet)
 *   moviendo     descargada, colocandola en el buzon
 *   lista        en el buzon; a partir de aqui manda procesar-entrada.js
 *   aviso        descargada pero SIN colocar, y se explica por que
 *   error        no hay fichero utilizable; `motivo` dice que paso
 *
 * `motivo` se escribe siempre en castellano y en claro, porque es literalmente
 * lo que se le ensena al usuario. Un "ENOENT" ahi dentro no le sirve a nadie.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS descargas (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    creada       INTEGER NOT NULL,
    actualizada  INTEGER NOT NULL,
    usuario      TEXT    NOT NULL,
    titulo       TEXT    NOT NULL,
    tipo         TEXT    NOT NULL,
    via          TEXT    NOT NULL,
    enlace       TEXT    NOT NULL,
    portada      TEXT,
    idioma       TEXT,
    resolucion   TEXT,
    tamano_txt   TEXT,
    tamano_bytes INTEGER DEFAULT 0,
    hash         TEXT,
    estado       TEXT    NOT NULL,
    motivo       TEXT,
    progreso     REAL    DEFAULT 0,
    velocidad    INTEGER DEFAULT 0,
    semillas     INTEGER DEFAULT 0,
    destino      TEXT,
    terminada    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_estado ON descargas (estado);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_hash ON descargas (hash) WHERE hash IS NOT NULL;
`);

const ahora = () => Date.now();

const insertar = db.prepare(`
  INSERT INTO descargas
    (creada, actualizada, usuario, titulo, tipo, via, enlace, portada, idioma,
     resolucion, tamano_txt, tamano_bytes, estado)
  VALUES
    (@creada, @creada, @usuario, @titulo, @tipo, @via, @enlace, @portada, @idioma,
     @resolucion, @tamano_txt, @tamano_bytes, 'pendiente')
`);

function crear(d) {
  const r = insertar.run({ ...d, creada: ahora() });
  return Number(r.lastInsertRowid);
}

/*
 * Actualizacion generica por campos sueltos.
 *
 * Se construye el SET a partir de las claves, pero SOLO de una lista blanca:
 * los nombres de columna no pueden ir parametrizados en SQL y aceptar
 * cualquier clave que llegue seria dejar que quien llame escriba SQL.
 */
const CAMPOS = new Set([
  'hash', 'estado', 'motivo', 'progreso', 'velocidad', 'semillas',
  'destino', 'terminada', 'titulo', 'tamano_bytes',
]);

function actualizar(id, campos) {
  const claves = Object.keys(campos).filter((k) => CAMPOS.has(k));
  if (!claves.length) return;
  const set = claves.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE descargas SET ${set}, actualizada = @actualizada WHERE id = @id`)
    .run({ ...campos, id, actualizada: ahora() });
}

/* Las que el bucle de vigilancia tiene que seguir mirando. Las terminales
   (lista, aviso, error) ya no se tocan: se quedan como historico. */
const ACTIVAS = ['pendiente', 'descargando', 'moviendo'];

const qActivas = db.prepare(
  `SELECT * FROM descargas WHERE estado IN (${ACTIVAS.map(() => '?').join(',')})`
);
const listarActivas = () => qActivas.all(...ACTIVAS);

const qTodas = db.prepare(`
  SELECT * FROM descargas
  ORDER BY
    CASE estado WHEN 'descargando' THEN 0 WHEN 'moviendo' THEN 0 WHEN 'pendiente' THEN 0 ELSE 1 END,
    actualizada DESC
  LIMIT ?
`);
const listar = (limite = 200) => qTodas.all(limite);

const qUna = db.prepare('SELECT * FROM descargas WHERE id = ?');
const una = (id) => qUna.get(id);

const qPorHash = db.prepare('SELECT * FROM descargas WHERE hash = ?');
const porHash = (hash) => qPorHash.get(String(hash || '').toLowerCase());

const qBorrar = db.prepare('DELETE FROM descargas WHERE id = ?');
const borrar = (id) => qBorrar.run(id);

/* Para el resumen de la cabecera: cuantas van, cuantas fallaron. */
const qResumen = db.prepare('SELECT estado, COUNT(*) AS n FROM descargas GROUP BY estado');
function resumen() {
  const r = { pendiente: 0, descargando: 0, moviendo: 0, lista: 0, aviso: 0, error: 0 };
  for (const fila of qResumen.all()) r[fila.estado] = fila.n;
  return r;
}

module.exports = { crear, actualizar, listar, listarActivas, una, porHash, borrar, resumen, ACTIVAS };
