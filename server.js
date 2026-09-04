'use strict';
/*
 * l-torrents: catalogo de descargas de lepayimio.
 *
 * Busca en el indexador, deja elegir magnet o .torrent, se lo pasa a
 * transmission y cuenta como fue. Lo que se descarga acaba en el buzon de
 * /var/media/entrada, que es de donde procesar-entrada.js lo recoge cada 5
 * minutos y lo coloca en la biblioteca de Jellyfin.
 *
 * Aqui NO se clasifica ni se transcodifica nada: eso ya lo hace el buzon y
 * duplicarlo seria tener dos sitios que discrepan. Lo unico que se hace de mas
 * es renombrar antes de dejarlo ahi, porque este servicio si sabe si lo pedido
 * era serie o pelicula y el buzon solo puede adivinarlo por el nombre.
 */

const path = require('path');
const express = require('express');

const { exigirSesion } = require('/usr/local/lib/lepayimio/sso');
const indexador = require('./lib/indexador');
const transmision = require('./lib/transmision');
const almacen = require('./lib/almacen');
const cosecha = require('./lib/cosecha');
const nombrar = require('./lib/nombrar');
const torrentsApi = require('./lib/fuente-torrents-api');

const app = express();
const PUERTO = Number(process.env.PORT || 3011);
/* El margen que exige procesar-entrada.js para ponerse a trabajar. Si se baja
   de ahi el buzon se planta, asi que no tiene sentido aceptar una descarga que
   vaya a dejarlo por debajo. */
const MARGEN_BYTES = Number(process.env.MARGEN_GB || 8) * 1024 ** 3;

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

/* Toda la aplicacion pide sesion, incluidos los estaticos: no hay nada aqui
   que tenga sentido ensenar a quien no ha entrado. El middleware distingue
   solo las rutas /api/ para contestarles 401 en vez de mandarlas al login. */
app.use(exigirSesion());

/* Envoltorio para no repetir el try/catch en cada ruta. Lo importante es el
   mensaje: lo que salga por aqui se pinta tal cual en la interfaz, asi que se
   manda el texto del error y no un "algo ha fallado". */
const ruta = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(`[${req.method} ${req.path}]`, e.message);
    if (!res.headersSent) res.status(502).json({ error: e.message });
  });
};

/* ── Catalogo ──────────────────────────────────────────────────────────── */

app.get('/api/opciones', (req, res) => {
  res.json({
    // El browse por genero/calidad de elitetorrent redirige a la home en el
    // dominio actual (.com), y la seccion hdrip revienta; se dejan de ofrecer.
    // Para filtrar por calidad/idioma esta la fuente "Varias webs".
    fuentes: Object.entries(indexador.FUENTES)
      .filter(([id]) => id !== 'hdrip')
      .map(([id, f]) => ({ id, nombre: f.nombre })),
    generos: [],
    calidades: [],
    indexador: indexador.comoEstaConfigurado(),
    configurado: indexador.configurado(),
    buscadores: [
      { id: 'principal', nombre: 'Catálogo', filtros: false },
      { id: 'torrents-api', nombre: torrentsApi.nombre, filtros: true, idiomas: torrentsApi.IDIOMAS, calidades: torrentsApi.CALIDADES },
    ],
  });
});

app.get('/api/catalogo', ruta(async (req, res) => {
  const pagina = Math.max(1, Number(req.query.pagina) || 1);
  const q = String(req.query.q || '').trim();

  let items;
  if (q) {
    if (String(req.query.buscador || '') === 'torrents-api') {
      items = await torrentsApi.buscar(q, {
        idioma: String(req.query.idioma || ''),
        calidad: String(req.query.calidad || ''),
        pagina,
      });
    } else {
      items = await indexador.buscar(q);
    }
  } else if (req.query.genero) {
    items = await indexador.porGenero(String(req.query.genero), pagina);
  } else if (req.query.calidad) {
    items = await indexador.porCalidad(String(req.query.calidad), pagina);
  } else {
    const fuente = indexador.FUENTES[String(req.query.fuente || 'novedades')];
    if (!fuente) return res.status(400).json({ error: 'esa sección no existe' });
    items = await fuente.fn(pagina);
  }

  /* Se marca lo que ya se pidio antes para que la interfaz pueda avisar en vez
     de dejar que se pida dos veces la misma pelicula. */
  const yaPedidos = new Set(almacen.listar(500).map((d) => d.titulo));
  res.json({
    pagina,
    items: items.map((x) => ({ ...x, yaPedido: yaPedidos.has(x.titulo) })),
  });
}));

/*
 * Proxy de portadas.
 *
 * Las portadas son URLs de la web del indexador. Servirlas desde aqui evita
 * dos cosas: que el navegador de cada uno vaya a pedirle imagenes a esa web
 * (con su Referer diciendo de donde viene), y que una portada en http rompa la
 * pagina por contenido mixto. Ademas se cachean un dia, que no cambian.
 */
app.get('/api/portada', ruta(async (req, res) => {
  const u = String(req.query.u || '');
  let url;
  try { url = new URL(u); } catch { return res.status(400).end(); }
  /* Solo http(s): sin esto, un "file:///etc/passwd" en el campo poster
     convertiria este proxy en un lector de ficheros del servidor. */
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return res.status(400).end();

  const r = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': 'l-torrents/0.1 (lepayimio.es)' },
  });
  if (!r.ok) return res.status(404).end();

  const tipo = r.headers.get('content-type') || '';
  if (!tipo.startsWith('image/')) return res.status(415).end();

  res.set('Content-Type', tipo);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(Buffer.from(await r.arrayBuffer()));
}));

/* ── Descargas ─────────────────────────────────────────────────────────── */

app.post('/api/descargas', ruta(async (req, res) => {
  const b = req.body || {};
  const via = b.via === 'torrent' ? 'torrent' : 'magnet';
  const enlace = String(b.enlace || '').trim();
  const tipo = b.tipo === 'serie' ? 'serie' : 'pelicula';
  const titulo = String(b.titulo || '').trim();

  if (!enlace) return res.status(400).json({ error: 'falta el enlace' });
  if (!titulo) return res.status(400).json({ error: 'falta el título' });
  if (via === 'magnet' && !/^magnet:\?/i.test(enlace)) {
    return res.status(400).json({ error: 'eso no es un enlace magnet' });
  }
  if (via === 'torrent' && !/^https?:\/\//i.test(enlace)) {
    return res.status(400).json({ error: 'eso no es una dirección de .torrent' });
  }

  const tamanoBytes = Number(b.tamanoBytes) || nombrar.aBytes(b.tamanoTxt);

  /* El disco se comprueba ANTES de dar de alta nada. Empezar una descarga que
     no cabe termina en un "error local: no space left" a medias, con el disco
     lleno y el buzon parado de rebote. */
  if (tamanoBytes) {
    try {
      const libre = await transmision.espacioLibre('/var/torrents/completos');
      if (libre && libre - tamanoBytes < MARGEN_BYTES) {
        return res.status(507).json({
          error: `no cabe: ocupa ${nombrar.humano(tamanoBytes)} y solo quedan `
               + `${nombrar.humano(libre)}, de los que hay que dejar `
               + `${nombrar.humano(MARGEN_BYTES)} libres para que el buzón pueda trabajar`,
        });
      }
    } catch (e) {
      /* Que falle la comprobacion no debe impedir descargar: se sigue, y si
         de verdad no cabe, transmission lo dira con su propio error. */
      console.error('[espacio]', e.message);
    }
  }

  const id = almacen.crear({
    usuario: req.sesion.id,
    titulo,
    tipo,
    via,
    enlace,
    portada: b.portada || null,
    idioma: b.idioma || null,
    resolucion: b.resolucion || null,
    tamano_txt: b.tamanoTxt || null,
    tamano_bytes: tamanoBytes,
  });

  try {
    const alta = via === 'magnet'
      ? await transmision.anadirMagnet(enlace)
      : await transmision.anadirTorrent(enlace);

    /* Un hash repetido choca con el indice unico. Es un caso real: pedir dos
       veces lo mismo, o dos versiones distintas que apuntan al mismo torrent.
       Se cuenta como aviso sobre la fila nueva y se deja la vieja mandando. */
    const previa = almacen.porHash(alta.hash);
    if (previa && previa.id !== id) {
      almacen.actualizar(id, {
        estado: 'aviso',
        motivo: `ya se había pedido lo mismo (descarga #${previa.id}); no se duplica`,
        terminada: Date.now(),
      });
      return res.json({ id, duplicado: previa.id, estado: 'aviso' });
    }

    almacen.actualizar(id, {
      hash: alta.hash,
      estado: 'descargando',
      motivo: alta.repetido ? 'ya estaba en transmission; se reaprovecha' : null,
    });
    res.json({ id, hash: alta.hash, estado: 'descargando' });
  } catch (e) {
    /* El fallo se guarda en la fila en vez de perderse en un 500: asi aparece
       en el panel con su motivo, que es justo lo que se pidio. */
    almacen.actualizar(id, { estado: 'error', motivo: e.message, terminada: Date.now() });
    res.status(502).json({ id, error: e.message });
  }
}));

app.get('/api/descargas', (req, res) => {
  res.json({
    resumen: almacen.resumen(),
    descargas: almacen.listar(200).map((d) => ({
      id: d.id,
      titulo: d.titulo,
      tipo: d.tipo,
      via: d.via,
      portada: d.portada,
      idioma: d.idioma,
      resolucion: d.resolucion,
      estado: d.estado,
      motivo: d.motivo,
      progreso: d.progreso,
      velocidad: d.velocidad,
      semillas: d.semillas,
      destino: d.destino,
      tamano: nombrar.humano(d.tamano_bytes),
      creada: d.creada,
      terminada: d.terminada,
    })),
  });
});

/*
 * Reintentar.
 *
 * Crea una fila nueva con los mismos datos en vez de resucitar la vieja: asi
 * queda constancia de que hubo un primer intento fallido y de por que, que es
 * la informacion que se pierde si se sobrescribe.
 */
app.post('/api/descargas/:id/reintentar', ruta(async (req, res) => {
  const d = almacen.una(Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'esa descarga no existe' });

  const nuevo = almacen.crear({
    usuario: req.sesion.id,
    titulo: d.titulo,
    tipo: d.tipo,
    via: d.via,
    enlace: d.enlace,
    portada: d.portada,
    idioma: d.idioma,
    resolucion: d.resolucion,
    tamano_txt: d.tamano_txt,
    tamano_bytes: d.tamano_bytes,
  });

  try {
    const alta = d.via === 'magnet'
      ? await transmision.anadirMagnet(d.enlace)
      : await transmision.anadirTorrent(d.enlace);
    almacen.actualizar(nuevo, { hash: alta.hash, estado: 'descargando' });
    res.json({ id: nuevo, estado: 'descargando' });
  } catch (e) {
    almacen.actualizar(nuevo, { estado: 'error', motivo: e.message, terminada: Date.now() });
    res.status(502).json({ id: nuevo, error: e.message });
  }
}));

/*
 * Quitar del panel. Con ?datos=1 borra tambien lo descargado del disco local.
 *
 * Lo que ya esta en la biblioteca de Jellyfin NO se toca nunca desde aqui:
 * es el otro nombre del enlace duro y borrar el de /var/torrents no lo afecta.
 * Para quitar algo de la mediateca se hace desde la mediateca.
 */
app.delete('/api/descargas/:id', ruta(async (req, res) => {
  const d = almacen.una(Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'esa descarga no existe' });
  if (d.hash) {
    try {
      await transmision.quitar([d.hash], req.query.datos === '1');
    } catch (e) {
      return res.status(502).json({ error: `no se pudo quitar de transmission: ${e.message}` });
    }
  }
  almacen.borrar(d.id);
  res.json({ ok: true });
}));

/* Estado de las piezas de las que esto depende, para saber donde mirar cuando
   algo no va sin tener que entrar por ssh. */
app.get('/api/estado', ruta(async (req, res) => {
  const estado = { indexador: indexador.comoEstaConfigurado(), transmision: null, disco: null };
  try {
    const s = await transmision.comprobar();
    estado.transmision = `transmission ${s.version}, descargando en ${s.carpetaDescargas}`;
    const libre = await transmision.espacioLibre(s.carpetaDescargas);
    estado.disco = `${nombrar.humano(libre)} libres`;
  } catch (e) {
    estado.transmision = `NO responde: ${e.message}`;
  }
  res.json(estado);
}));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

/*
 * Manejador de errores propio.
 *
 * Sin uno, Express suelta el stack trace entero en la respuesta cuando no esta
 * en produccion: rutas absolutas del servidor, versiones y estructura interna.
 * La unit ya pone NODE_ENV=production, pero esto no depende de acordarse.
 */
app.use((err, req, res, siguiente) => {
  console.error('[sin capturar]', err);
  if (res.headersSent) return siguiente(err);
  res.status(500).json({ error: 'error interno' });
});

const servidor = app.listen(PUERTO, '127.0.0.1', () => {
  console.log(`l-torrents en 127.0.0.1:${PUERTO} · indexador: ${indexador.comoEstaConfigurado()}`);
  cosecha.arrancar();
});

/* systemd manda SIGTERM al parar; sin esto espera los 90 s del timeout. */
for (const senal of ['SIGTERM', 'SIGINT']) {
  process.on(senal, () => servidor.close(() => process.exit(0)));
}
