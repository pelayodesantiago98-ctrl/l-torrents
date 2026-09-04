'use strict';
/*
 * Prueba de lib/nombrar.js — `node prueba-nombres.js`
 *
 * Es la unica parte con logica de verdad y la unica que puede fallar en
 * silencio: si aqui se cuela un nombre mal compuesto, el fichero acaba en la
 * biblioteca equivocada de Jellyfin y solo se descubre al ver la portada rara
 * un rato despues. Las demas piezas (RPC, buzon, panel) fallan de forma
 * ruidosa y se ven al momento.
 */

const assert = require('assert');
const n = require('./lib/nombrar');

let hechas = 0, malas = 0;
function prueba(nombre, fn) {
  hechas += 1;
  try { fn(); console.log(`  ok  ${nombre}`); }
  catch (e) { malas += 1; console.log(`  MAL ${nombre}\n      ${e.message}`); }
}

console.log('\ntamanos');
prueba('MB con decimales', () => assert.strictEqual(n.aBytes('606.19 MBs'), Math.round(606.19 * 1024 ** 2)));
prueba('GB con decimales', () => assert.strictEqual(n.aBytes('1.98 GBs'), Math.round(1.98 * 1024 ** 3)));
prueba('GB entero',        () => assert.strictEqual(n.aBytes('2 GBs'), 2 * 1024 ** 3));
prueba('coma decimal',     () => assert.strictEqual(n.aBytes('1,25 GBs'), Math.round(1.25 * 1024 ** 3)));
prueba('vacio da 0',       () => assert.strictEqual(n.aBytes(''), 0));
prueba('sin unidad da 0',  () => assert.strictEqual(n.aBytes('---'), 0));

console.log('\nepisodios (los tres patrones del buzon)');
prueba('S01E07',     () => assert.deepStrictEqual(n.episodioDe('Serie S01E07 1080p'), { temporada: 1, episodio: 7 }));
prueba('1x07',       () => assert.deepStrictEqual(n.episodioDe('Serie - 1x07'), { temporada: 1, episodio: 7 }));
prueba('Cap 107',    () => assert.deepStrictEqual(n.episodioDe('Serie Temporada 1 [Cap 107]'), { temporada: 1, episodio: 7 }));
prueba('Cap 1203',   () => assert.deepStrictEqual(n.episodioDe('Serie [Cap 1203]'), { temporada: 12, episodio: 3 }));
prueba('Cap 7 no vale', () => assert.strictEqual(n.episodioDe('Serie Cap 7'), null));
prueba('pelicula no casa', () => assert.strictEqual(n.episodioDe('Interstellar (2014) 1080p'), null));

console.log('\npeliculas');
prueba('titulo con ano', () => {
  const p = n.planDeNombres({
    tipo: 'pelicula',
    tituloApi: 'Interstellar (2014) [BR-Screener]',
    ficheros: [{ nombre: 'Interstellar.2014.1080p.mkv', bytes: 2e9 }],
  });
  assert.deepStrictEqual(p.enlaces, [{ origen: 'Interstellar.2014.1080p.mkv', destino: 'Interstellar (2014).mkv' }]);
});

prueba('se queda el video grande y descarta la muestra', () => {
  const p = n.planDeNombres({
    tipo: 'pelicula',
    tituloApi: 'Alguna Peli (2019)',
    ficheros: [
      { nombre: 'sample.mkv', bytes: 5e7 },
      { nombre: 'peli.mkv',   bytes: 2e9 },
    ],
  });
  assert.strictEqual(p.enlaces.length, 1);
  assert.strictEqual(p.enlaces[0].origen, 'peli.mkv');
});

prueba('sin video da aviso y no mueve nada', () => {
  const p = n.planDeNombres({ tipo: 'pelicula', tituloApi: 'X', ficheros: [{ nombre: 'lee.txt', bytes: 1e3 }] });
  assert.strictEqual(p.enlaces.length, 0);
  assert.ok(p.aviso);
});

console.log('\nseries — lo que evita que acaben en Peliculas');
prueba('un capitulo con SxxEyy en el fichero', () => {
  const p = n.planDeNombres({
    tipo: 'serie',
    tituloApi: 'Juego de Tronos - Temporada 8 [Cap 803]',
    ficheros: [{ nombre: 'JuegoDeTronos.S08E03.1080p.mkv', bytes: 2e9 }],
  });
  assert.deepStrictEqual(p.enlaces, [{ origen: 'JuegoDeTronos.S08E03.1080p.mkv', destino: 'Juego de Tronos S08E03.mkv' }]);
});

prueba('fichero sin episodio pero titulo con Cap: lo saca del titulo', () => {
  const p = n.planDeNombres({
    tipo: 'serie',
    tituloApi: 'Juego de Tronos - Temporada 8 [Cap 803]',
    ficheros: [{ nombre: 'video.mkv', bytes: 2e9 }],
  });
  assert.deepStrictEqual(p.enlaces, [{ origen: 'video.mkv', destino: 'Juego de Tronos S08E03.mkv' }]);
});

prueba('pack de temporada entero', () => {
  const p = n.planDeNombres({
    tipo: 'serie',
    tituloApi: 'Miercoles - Temporada 1',
    ficheros: [
      { nombre: 'Miercoles.1x01.mkv', bytes: 1e9 },
      { nombre: 'Miercoles.1x02.mkv', bytes: 1e9 },
      { nombre: 'Miercoles.1x03.mkv', bytes: 1e9 },
    ],
  });
  assert.strictEqual(p.enlaces.length, 3);
  assert.deepStrictEqual(p.enlaces.map((e) => e.destino), [
    'Miercoles S01E01.mkv', 'Miercoles S01E02.mkv', 'Miercoles S01E03.mkv',
  ]);
  assert.strictEqual(p.aviso, null);
});

prueba('pack con varios ficheros y titulo generico: NO se inventa el episodio', () => {
  /* El caso peligroso. Con dos videos sin SxxEyy, sacar el episodio del titulo
     comun daria el MISMO nombre a los dos y uno pisaria al otro. Rendirse es
     lo correcto. */
  const p = n.planDeNombres({
    tipo: 'serie',
    tituloApi: 'Serie X - Temporada 2 [Cap 205]',
    ficheros: [
      { nombre: 'parte-a.mkv', bytes: 1e9 },
      { nombre: 'parte-b.mkv', bytes: 1e9 },
    ],
  });
  assert.strictEqual(p.enlaces.length, 0);
  assert.ok(/no se pudo deducir/.test(p.aviso));
});

prueba('pack a medias: coloca lo legible y avisa del resto', () => {
  const p = n.planDeNombres({
    tipo: 'serie',
    tituloApi: 'Serie Y - Temporada 1',
    ficheros: [
      { nombre: 'Serie.S01E01.mkv', bytes: 1e9 },
      { nombre: 'extra-raro.mkv',   bytes: 1e9 },
    ],
  });
  assert.strictEqual(p.enlaces.length, 1);
  assert.ok(/1 sin temporada/.test(p.aviso));
});

prueba('titulo con barras no crea carpetas', () => {
  const p = n.planDeNombres({
    tipo: 'pelicula',
    tituloApi: 'AC/DC: Live (2011)',
    ficheros: [{ nombre: 'live.mkv', bytes: 2e9 }],
  });
  assert.ok(!p.enlaces[0].destino.includes('/'));
});

console.log(`\n${hechas - malas}/${hechas} correctas\n`);
process.exit(malas ? 1 : 0);
