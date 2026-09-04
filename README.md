# l-torrents

Catálogo de descargas autoalojado: busca en un indexador, deja elegir magnet o
`.torrent`, se lo pasa a **Transmission** y deja el resultado en un buzón desde
el que otro proceso lo coloca en la biblioteca de **Jellyfin**. Aquí no se
clasifica ni se transcodifica nada: esto solo busca, descarga y renombra.

Es una app pequeña de **Node + Express** (Express 5) con **SQLite**
(`better-sqlite3`). Toda la interfaz exige sesión mediante un módulo SSO externo
(ver más abajo).

## Créditos: la API original

El catálogo se obtiene, por defecto, del paquete de npm
**[`elitetorrent`](https://www.npmjs.com/package/elitetorrent)** de
**chris5855** ([repositorio en GitHub](https://github.com/chrisperezsantiago1)),
que expone `getMovies()`, `getSeries()`, `search()`, `getNewReleases()`,
`getContentByGenre()`, `getContentByQuality()`, etc.

Todo el mérito del scraping y de la API es suyo. Este proyecto solo la consume.

Dos apuntes sobre cómo se integra, resueltos en `lib/fuente-elitetorrent.js`:

1. **Dominio.** La versión 1.0.1 del paquete trae fijo en su código compilado el
   dominio `www.elitetorrent.se`, que ya no resuelve. El envoltorio reescribe
   `BASE_URL` en tiempo de ejecución (por defecto a `www.elitetorrent.com`) en
   vez de parchear `node_modules`. Se ajusta con la variable `ELITETORRENT_BASE`.
2. **Enlaces.** Los campos `torrent` y `magnet` vienen ofuscados tras un
   acortador (base64 anidado + ROT13); el envoltorio los descifra para que
   Transmission reciba un enlace usable.

El indexador está aislado en `lib/indexador.js`: admite tanto un **módulo de
npm** (`INDEXADOR_MODULO`) como una **API HTTP** (`INDEXADOR_BASE`), así que
puede apuntarse a otra fuente sin tocar el resto.

## Puesta en marcha

```bash
# 1. Dependencias.
#    OJO: elitetorrent trae un preinstall que exige Yarn y rompe un npm install
#    normal. Instala SIEMPRE con --ignore-scripts.
npm install --ignore-scripts

# 2. Configuración.
cp .env.ejemplo .env
#   - Elige indexador: INDEXADOR_MODULO (paquete/envoltorio) o INDEXADOR_BASE (URL).
#     Para usar elitetorrent con el envoltorio incluido:
#       npm install --ignore-scripts elitetorrent
#       INDEXADOR_MODULO=/ruta/absoluta/al/proyecto/lib/fuente-elitetorrent.js
#   - Rellena los datos del RPC de Transmission (los mismos de settings.json).
#   - Ajusta BUZON, márgenes de disco, etc.

# 3. Arrancar.
npm start
```

En `despliegue/` hay ejemplos de la unit de systemd y de la configuración de
nginx que se usan en producción.

## Dependencia externa: SSO

`server.js` exige sesión con `require("/usr/local/lib/lepayimio/sso")`, un módulo
propio de la instalación de origen que **no se incluye** aquí. Para usarlo fuera
de ese entorno hay que sustituir ese middleware por el tuyo (o por un stub que
deje pasar en desarrollo).

## Aviso

Herramienta para uso personal y autoalojado. Descarga solo contenido para el que
tengas derecho. El uso que hagas de ella es responsabilidad tuya.
