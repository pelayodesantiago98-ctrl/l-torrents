# l-torrents

Catálogo de descargas autoalojado: busca en uno o varios indexadores, deja
elegir magnet o `.torrent`, se lo pasa a **Transmission** y deja el resultado en
un buzón desde el que otro proceso lo coloca en la biblioteca de **Jellyfin**.
Aquí no se clasifica ni se transcodifica nada: esto solo busca, descarga y
renombra.

Es una app pequeña de **Node + Express** (Express 5) con **SQLite**
(`better-sqlite3`). Toda la interfaz exige sesión mediante un módulo SSO externo
(ver más abajo).

## Fuentes del catálogo

El indexador está aislado en `lib/indexador.js` y admite tanto un **módulo de
npm** (`INDEXADOR_MODULO`) como una **API HTTP** (`INDEXADOR_BASE`). Encima de
eso, el buscador puede consultar varias fuentes seleccionables desde la interfaz.

### 1. elitetorrent (fuente principal, navegación + búsqueda)

El catálogo por defecto sale del paquete de npm
**[`elitetorrent`](https://www.npmjs.com/package/elitetorrent)** de
**chris5855** ([perfil en GitHub](https://github.com/chrisperezsantiago1)), que
expone `getMovies()`, `getSeries()`, `search()`, `getNewReleases()`,
`getContentByGenre()`, `getContentByQuality()`, etc. Todo el mérito del scraping
y de la API es suyo; este proyecto solo la consume.

Dos apuntes de integración, resueltos en `lib/fuente-elitetorrent.js`:

1. **Dominio.** La versión 1.0.1 trae fijo en su código compilado el dominio
   `www.elitetorrent.se`, que ya no resuelve. El envoltorio reescribe `BASE_URL`
   en tiempo de ejecución (por defecto a `www.elitetorrent.com`) en vez de
   parchear `node_modules`. Se ajusta con `ELITETORRENT_BASE`.
2. **Enlaces.** Los campos `torrent` y `magnet` vienen ofuscados tras un
   acortador (base64 anidado + ROT13); el envoltorio los descifra.

### 2. 1337x, vía Torrents-Api (búsqueda con filtro de idioma y calidad)

La segunda fuente usa
**[Torrents-Api](https://github.com/Ryuk-me/Torrents-Api)** de **Ryuk-me**, un
scraper HTTP de muchos sitios de torrents. El adaptador `lib/fuente-torrents-api.js`
consulta **varias webs en paralelo** (por defecto 1337x, PirateBay y TorrentProject;
se ajusta con `TORRENTS_API_SITIOS`), **fusiona** los resultados, los **deduplica**
por su hash y los ordena por número de semillas. De nuevo, todo el mérito de esa
API es de su autor; aquí solo se consume. Además añade dos filtros que las webs
ajenas no ofrecen de fábrica: **idioma** (del campo `Language` cuando existe, o
deducido del nombre) y **calidad** de película (2160p/1080p/720p/480p, leída del
nombre).

Hay que **autoalojar** la Torrents-Api (la instancia pública que figura en su
README ya no existe):

```sh
git clone https://github.com/Ryuk-me/Torrents-Api
cd Torrents-Api && npm install
PORT=3012 node app.js   # mejor atado a 127.0.0.1
```

Y apuntar l-torrents a ella con `TORRENTS_API_BASE` (por defecto
`http://127.0.0.1:3012`). El sitio 1337x bloquea peticiones seguidas desde IPs
de datacenter, así que puede fallar de vez en cuando; el adaptador lo reporta en
claro.

## Puesta en marcha

```bash
# 1. Dependencias.
#    OJO: elitetorrent trae un preinstall que exige Yarn y rompe un npm install
#    normal. Instala SIEMPRE con --ignore-scripts.
npm install --ignore-scripts

# 2. Configuración.
cp .env.ejemplo .env
#   - Elige indexador principal: INDEXADOR_MODULO o INDEXADOR_BASE.
#     Para elitetorrent con el envoltorio incluido:
#       npm install --ignore-scripts elitetorrent
#       INDEXADOR_MODULO=/ruta/absoluta/al/proyecto/lib/fuente-elitetorrent.js
#   - Para la segunda fuente, levanta Torrents-Api y pon TORRENTS_API_BASE.
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
