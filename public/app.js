'use strict';
/*
 * Interfaz de l-torrents.
 *
 * Sin framework a proposito: son dos vistas y una lista que se refresca sola.
 * Meter React aqui costaria mas de mantener que lo que ahorraria.
 */

const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* Todo lo que venga del indexador se pinta con textContent o pasa por aqui.
   El titulo de un torrent lo escribe un desconocido: si se metiera con
   innerHTML, un titulo con <script> dentro se ejecutaria en esta pagina. */
function esc(t) {
  return String(t ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const estado = {
  vista: 'catalogo',
  fuente: 'novedades',
  genero: '',
  calidad: '',
  q: '',
  buscador: 'principal',
  fIdioma: '',
  fCalidad: '',
  pagina: 1,
  items: [],
};

/* Config de los buscadores, rellenada en cargarOpciones(). */
const BUSCADORES = {};

/* ── Avisos ──────────────────────────────────────────────────────────── */

let brindisTemporizador = null;
function brindis(texto, clase = '') {
  const b = $('#brindis');
  b.textContent = texto;
  b.className = 'brindis ' + clase;
  b.hidden = false;
  clearTimeout(brindisTemporizador);
  /* Los fallos se quedan mas tiempo: suelen ser una frase larga que hay que
     poder leer entera. */
  brindisTemporizador = setTimeout(() => { b.hidden = true; }, clase === 'mal' ? 9000 : 4000);
}

async function pedir(url, opciones) {
  const res = await fetch(url, opciones);
  let cuerpo = {};
  try { cuerpo = await res.json(); } catch { /* respuesta sin JSON */ }
  if (!res.ok) throw new Error(cuerpo.error || `error ${res.status}`);
  return cuerpo;
}

/* ── Catálogo ────────────────────────────────────────────────────────── */

async function cargarOpciones() {
  const o = await pedir('/api/opciones');

  $('#fuentes').innerHTML = o.fuentes
    .map((f) => `<button data-fuente="${esc(f.id)}">${esc(f.nombre)}</button>`).join('');

  for (const g of o.generos) {
    $('#genero').append(new Option(`Género: ${g.nombre}`, g.id));
  }
  for (const c of o.calidades) {
    $('#calidad').append(new Option(`Calidad: ${c.nombre}`, c.id));
  }

  // El browse por genero/calidad de elitetorrent esta roto en el dominio
  // actual, asi que el backend ya no los manda; si vienen vacios, se oculta
  // ese grupo. El filtro que funciona vive en la fuente "Varias webs".
  if (!o.generos.length && !o.calidades.length) {
    const g = $('#genero').closest('.grupo');
    if (g) g.hidden = true;
  }

  // Buscadores (fuentes de la caja de busqueda) y sus filtros.
  const selB = $('#buscador-fuente');
  for (const b of (o.buscadores || [])) {
    BUSCADORES[b.id] = b;
    selB.append(new Option(`Buscar en: ${b.nombre}`, b.id));
  }
  selB.value = estado.buscador;
  aplicarFiltrosBuscador();
  selB.addEventListener('change', () => {
    estado.buscador = selB.value;
    estado.fIdioma = ''; estado.fCalidad = '';
    aplicarFiltrosBuscador();
    estado.pagina = 1;
    if (estado.q) cargarCatalogo();
  });
  $('#f-idioma').addEventListener('change', (ev) => {
    estado.fIdioma = ev.target.value; estado.pagina = 1;
    if (estado.q) cargarCatalogo();
  });
  $('#f-calidad').addEventListener('change', (ev) => {
    estado.fCalidad = ev.target.value; estado.pagina = 1;
    if (estado.q) cargarCatalogo();
  });

  $$('#fuentes button').forEach((b) => b.addEventListener('click', () => {
    estado.fuente = b.dataset.fuente;
    estado.q = ''; $('#q').value = '';
    estado.genero = ''; $('#genero').value = '';
    estado.calidad = ''; $('#calidad').value = '';
    estado.pagina = 1;
    cargarCatalogo();
  }));

  if (!o.configurado) {
    mostrarAviso('No hay ningún indexador configurado todavía: falta poner '
      + 'INDEXADOR_MODULO o INDEXADOR_BASE en /var/www/l-torrents/.env. '
      + 'El resto del servicio (transmission, buzón y panel de descargas) sí funciona.');
  }
}

/* Segun el buscador elegido, muestra u oculta los filtros de idioma y
   calidad y los rellena con lo que declare ese buscador. */
function aplicarFiltrosBuscador() {
  const b = BUSCADORES[estado.buscador] || {};
  const selI = $('#f-idioma');
  const selC = $('#f-calidad');
  if (b.filtros) {
    selI.innerHTML = '<option value="">Idioma: todos</option>'
      + (b.idiomas || []).map((x) => `<option value="${esc(x.id)}">${esc(x.nombre)}</option>`).join('');
    selC.innerHTML = '<option value="">Calidad: toda</option>'
      + (b.calidades || []).map((x) => `<option value="${esc(x.id)}">${esc(x.nombre)}</option>`).join('');
    selI.value = estado.fIdioma; selC.value = estado.fCalidad;
    selI.hidden = false; selC.hidden = false;
  } else {
    selI.hidden = true; selC.hidden = true;
  }
}

function mostrarAviso(texto) {
  const a = $('#aviso-catalogo');
  a.textContent = texto;
  a.hidden = !texto;
}

function urlCatalogo() {
  const p = new URLSearchParams();
  if (estado.q) {
    p.set('q', estado.q);
    if (estado.buscador && estado.buscador !== 'principal') {
      p.set('buscador', estado.buscador);
      if (estado.fIdioma) p.set('idioma', estado.fIdioma);
      if (estado.fCalidad) p.set('calidad', estado.fCalidad);
      p.set('pagina', estado.pagina);
    }
  }
  else if (estado.genero) { p.set('genero', estado.genero); p.set('pagina', estado.pagina); }
  else if (estado.calidad) { p.set('calidad', estado.calidad); p.set('pagina', estado.pagina); }
  else { p.set('fuente', estado.fuente); p.set('pagina', estado.pagina); }
  return '/api/catalogo?' + p;
}

async function cargarCatalogo() {
  $('#rejilla').innerHTML = '<p class="vacio">Cargando…</p>';
  $('#paginacion').hidden = true;
  mostrarAviso('');

  $$('#fuentes button').forEach((b) =>
    b.classList.toggle('activa', !estado.q && !estado.genero && !estado.calidad && b.dataset.fuente === estado.fuente));

  try {
    const r = await pedir(urlCatalogo());
    estado.items = r.items;
    pintarCatalogo();
  } catch (e) {
    $('#rejilla').innerHTML = '';
    mostrarAviso(`No se pudo consultar el indexador. ${e.message}`);
  }
}

function pintarCatalogo() {
  const rejilla = $('#rejilla');

  if (!estado.items.length) {
    rejilla.innerHTML = '<p class="vacio">Nada por aquí. Prueba con otra búsqueda o con otra sección.</p>';
    return;
  }

  rejilla.innerHTML = estado.items.map((x, i) => `
    <button class="tarjeta" data-i="${i}">
      ${x.portada
        ? `<img class="portada" loading="lazy" alt="" src="/api/portada?u=${encodeURIComponent(x.portada)}">`
        : '<div class="portada"></div>'}
      <div class="cuerpo">
        <div class="titulo">${esc(x.titulo)}</div>
        <div class="etiquetas">
          <span class="etiqueta ${x.tipo}">${x.tipo === 'serie' ? 'Serie' : 'Película'}</span>
          ${x.resolucion ? `<span class="etiqueta">${esc(x.resolucion)}</span>` : ''}
          ${x.yaPedido ? '<span class="etiqueta pedido">Ya pedida</span>' : ''}
        </div>
        <div class="meta">${esc(x.tamanoTxt || '')}${x.idioma ? ' · ' + esc(x.idioma) : ''}</div>
      </div>
    </button>`).join('');

  $$('.tarjeta').forEach((b) =>
    b.addEventListener('click', () => abrirCajon(estado.items[Number(b.dataset.i)])));

  /* search() no pagina en la API, así que ahí no se ofrece. */
  $('#paginacion').hidden = Boolean(estado.q) && estado.buscador === 'principal';
  $('#npagina').textContent = estado.pagina;
  $('#anterior').disabled = estado.pagina <= 1;
}

/* ── Cajón de una ficha ──────────────────────────────────────────────── */

let fichaAbierta = null;

function abrirCajon(item) {
  fichaAbierta = { ...item, tipo: item.tipo };
  pintarCajon();
  $('#cajon').hidden = false;
}

function pintarCajon() {
  const x = fichaAbierta;

  const versiones = x.torrents.map((t, i) => `
    <div class="version">
      <div class="datos">
        ${t.semillas} semillas · ${t.clientes} clientes${t.fecha ? ' · ' + esc(t.fecha) : ''}
      </div>
      <div class="botones">
        <button data-i="${i}" data-via="magnet" ${t.magnet ? '' : 'disabled'}>Magnet</button>
        <button class="alterno" data-i="${i}" data-via="torrent" ${t.torrent ? '' : 'disabled'}>.torrent</button>
      </div>
    </div>`).join('');

  $('#cajon-contenido').innerHTML = `
    <div class="ficha">
      ${x.portada ? `<img alt="" src="/api/portada?u=${encodeURIComponent(x.portada)}">` : ''}
      <div>
        <h2>${esc(x.titulo)}</h2>
        <div class="etiquetas">
          ${x.resolucion ? `<span class="etiqueta">${esc(x.resolucion)}</span>` : ''}
          ${x.tamanoTxt ? `<span class="etiqueta">${esc(x.tamanoTxt)}</span>` : ''}
        </div>
        <div class="meta" style="margin-top:8px;color:var(--tenue);font-size:12.5px">${esc(x.idioma || '')}</div>
      </div>
    </div>

    <div class="selector-tipo">
      <button data-tipo="pelicula" class="${x.tipo === 'pelicula' ? 'activa' : ''}">Es una película</button>
      <button data-tipo="serie" class="${x.tipo === 'serie' ? 'activa' : ''}">Es una serie</button>
    </div>

    <p class="nota">
      Esto decide en qué biblioteca de Jellyfin acaba. Si te equivocas aquí, una
      serie termina en Películas con la portada de otra cosa — compruébalo antes
      de darle.
    </p>

    <p class="nota">
      <b>Magnet</b> empieza al momento pero tarda un poco en saber qué descarga.
      <b>.torrent</b> se comprueba aquí antes de empezar, así que si el enlace
      está roto te lo digo ya.
    </p>

    ${versiones || '<p class="vacio">Esta ficha no trae ningún enlace.</p>'}`;

  $$('.selector-tipo button').forEach((b) => b.addEventListener('click', () => {
    fichaAbierta.tipo = b.dataset.tipo;
    pintarCajon();
  }));

  $$('.version .botones button').forEach((b) => b.addEventListener('click', () => descargar(b)));
}

async function descargar(boton) {
  const t = fichaAbierta.torrents[Number(boton.dataset.i)];
  const via = boton.dataset.via;

  const todos = $$('.version .botones button');
  todos.forEach((b) => { b.disabled = true; });
  boton.textContent = 'Enviando…';

  try {
    const r = await pedir('/api/descargas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        titulo: fichaAbierta.titulo,
        tipo: fichaAbierta.tipo,
        portada: fichaAbierta.portada,
        idioma: fichaAbierta.idioma,
        resolucion: fichaAbierta.resolucion,
        tamanoTxt: fichaAbierta.tamanoTxt,
        tamanoBytes: fichaAbierta.tamanoBytes,
        via,
        enlace: via === 'magnet' ? t.magnet : t.torrent,
      }),
    });

    if (r.duplicado) brindis(`Ya la habías pedido (descarga #${r.duplicado}).`, '');
    else brindis(`En marcha: ${fichaAbierta.titulo}`, 'bien');

    $('#cajon').hidden = true;
    refrescarDescargas();
  } catch (e) {
    brindis(e.message, 'mal');
    pintarCajon();   // devuelve los botones a su sitio
  }
}

/* ── Panel de descargas ──────────────────────────────────────────────── */

const TEXTO_ESTADO = {
  pendiente:   'En cola',
  descargando: 'Descargando',
  moviendo:    'Colocando en el buzón',
  lista:       'Lista',
  aviso:       'Necesita que la mires',
  error:       'Falló',
};

function pintarDescargas(d) {
  const r = d.resumen;

  $('#resumen').innerHTML = [
    ['descargando', 'en curso', r.descargando + r.pendiente + r.moviendo],
    ['lista', 'completadas', r.lista],
    ['aviso', 'con aviso', r.aviso],
    ['error', 'fallidas', r.error],
  ].map(([c, etq, n]) => `<div class="dato"><b>${n}</b><span>${etq}</span></div>`).join('');

  const enCurso = r.descargando + r.pendiente + r.moviendo;
  $('#chapa').hidden = !enCurso;
  $('#chapa').textContent = enCurso;

  if (!d.descargas.length) {
    $('#lista').innerHTML = '<p class="vacio">Todavía no has pedido nada.</p>';
    return;
  }

  $('#lista').innerHTML = d.descargas.map((x) => {
    /* "lista" choca con la clase .lista del contenedor, de ahí el guión. */
    const clase = x.estado === 'lista' ? 'lista_' : x.estado;
    const pct = Math.round((x.progreso || 0) * 100);

    const sub = x.estado === 'descargando'
      ? `${pct}% · ${(x.velocidad / 1048576).toFixed(2)} MB/s · ${x.semillas} semillas · ${x.tamano}`
      : `${TEXTO_ESTADO[x.estado]} · ${x.tipo === 'serie' ? 'serie' : 'película'} · ${x.via} · ${x.tamano}`;

    return `
      <div class="fila ${clase}">
        ${x.portada
          ? `<img alt="" loading="lazy" src="/api/portada?u=${encodeURIComponent(x.portada)}">`
          : '<div></div>'}
        <div>
          <div class="nombre">${esc(x.titulo)}</div>
          <div class="sub">${esc(sub)}</div>
          ${x.motivo ? `<div class="motivo">${esc(x.motivo)}</div>` : ''}
          ${x.destino && x.estado === 'lista'
            ? `<div class="motivo">En el buzón como: ${esc(x.destino)}</div>` : ''}
          ${x.estado === 'descargando'
            ? `<div class="barra-progreso"><i style="width:${pct}%"></i></div>` : ''}
        </div>
        <div class="acciones">
          ${x.estado === 'error' ? `<button data-reintentar="${x.id}">Reintentar</button>` : ''}
          <button data-quitar="${x.id}">Quitar</button>
        </div>
      </div>`;
  }).join('');

  $$('[data-reintentar]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await pedir(`/api/descargas/${b.dataset.reintentar}/reintentar`, { method: 'POST' }); brindis('Reintentando…', 'bien'); }
    catch (e) { brindis(e.message, 'mal'); }
    refrescarDescargas();
  }));

  $$('[data-quitar]').forEach((b) => b.addEventListener('click', async () => {
    /* Se pregunta con confirm() porque la variante con datos borra ficheros.
       Lo que ya esté en Jellyfin no se toca: es el otro nombre del enlace. */
    const conDatos = confirm(
      'Quitar del panel.\n\n'
      + 'Aceptar = borrar también lo descargado del disco del servidor.\n'
      + 'Cancelar = quitarlo solo de esta lista.\n\n'
      + 'Lo que ya esté en Jellyfin no se borra en ninguno de los dos casos.');
    b.disabled = true;
    try { await pedir(`/api/descargas/${b.dataset.quitar}?datos=${conDatos ? 1 : 0}`, { method: 'DELETE' }); }
    catch (e) { brindis(e.message, 'mal'); }
    refrescarDescargas();
  }));
}

async function refrescarDescargas() {
  try { pintarDescargas(await pedir('/api/descargas')); }
  catch (e) { console.error(e); }
}

async function cargarEstadoSistema() {
  try {
    const e = await pedir('/api/estado');
    $('#estado-sistema').textContent =
      `${e.transmision}${e.disco ? ' · ' + e.disco : ''} · indexador: ${e.indexador}`;
  } catch { /* no es critico */ }
}

/* ── Arranque ────────────────────────────────────────────────────────── */

$('#buscador').addEventListener('submit', (ev) => {
  ev.preventDefault();
  estado.q = $('#q').value.trim();
  estado.genero = ''; $('#genero').value = '';
  estado.calidad = ''; $('#calidad').value = '';
  estado.pagina = 1;
  cargarCatalogo();
});

$('#genero').addEventListener('change', (ev) => {
  estado.genero = ev.target.value; estado.calidad = ''; $('#calidad').value = '';
  estado.q = ''; $('#q').value = ''; estado.pagina = 1;
  cargarCatalogo();
});

$('#calidad').addEventListener('change', (ev) => {
  estado.calidad = ev.target.value; estado.genero = ''; $('#genero').value = '';
  estado.q = ''; $('#q').value = ''; estado.pagina = 1;
  cargarCatalogo();
});

$('#anterior').addEventListener('click', () => { estado.pagina -= 1; cargarCatalogo(); });
$('#siguiente').addEventListener('click', () => { estado.pagina += 1; cargarCatalogo(); });

$$('.pestana').forEach((b) => b.addEventListener('click', () => {
  estado.vista = b.dataset.vista;
  $$('.pestana').forEach((o) => o.classList.toggle('activa', o === b));
  $('#vista-catalogo').hidden = estado.vista !== 'catalogo';
  $('#vista-descargas').hidden = estado.vista !== 'descargas';
  if (estado.vista === 'descargas') { refrescarDescargas(); cargarEstadoSistema(); }
}));

$$('[data-cerrar]').forEach((e) => e.addEventListener('click', () => { $('#cajon').hidden = true; }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#cajon').hidden = true; });

cargarOpciones().then(cargarCatalogo);
refrescarDescargas();
/* El panel se refresca solo mientras la pestaña esté visible. Con la pestaña
   en segundo plano no se pide nada: no hay nadie mirando. */
setInterval(() => { if (!document.hidden) refrescarDescargas(); }, 5000);
