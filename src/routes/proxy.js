/**
 * MANGALIX — MangaDex Proxy
 * Salva em: src/routes/proxy.js  (no mangalix-api)
 *
 * No server.js, ANTES do express.json():
 *   app.use('/proxy/mangadex', require('./src/routes/proxy'));
 */

const axios = require('axios');

// ─── Cache ────────────────────────────────────────────────────────────────────

var cache = new Map();
var CACHE_TTL = 60 * 60 * 1000; // 1 hora

function cacheSet(key, data) {
  cache.set(key, data);
  setTimeout(function () { cache.delete(key); }, CACHE_TTL);
}

// ─── Rate limiter + retry ─────────────────────────────────────────────────────
// Garante 1000ms entre requisições upstream. Retenta 1x após 5s no 429.

var lastRequestTime = 0;

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function doGet(url) {
  return axios.get(url, {
    headers: {
      'User-Agent': 'Mangalix/1.0 (api.mangalix.com.br)',
      'Accept': 'application/json',
    },
    timeout: 20000,
  });
}

async function mdxGet(url) {
  var elapsed = Date.now() - lastRequestTime;
  if (elapsed < 1000) await sleep(1000 - elapsed);
  lastRequestTime = Date.now();

  try {
    return await doGet(url);
  } catch (err) {
    var status = err.response && err.response.status;
    if (status === 429) {
      console.warn('[PROXY] 429 from MangaDex — waiting 5s before retry');
      await sleep(5000);
      lastRequestTime = Date.now();
      return doGet(url); // uma segunda tentativa
    }
    throw err;
  }
}

// ─── Middleware exportado diretamente ─────────────────────────────────────────

module.exports = async function proxyMangaDex(req, res) {
  var path = req.url; // inclui query string, ex: /manga?title=One+Piece

  // ── Cover image ──────────────────────────────────────────────────────────
  var coverMatch = path.match(/^\/cover\/([^/]+)\/([^?]+)/);
  if (coverMatch) {
    var coverUrl = 'https://uploads.mangadex.org/covers/' + coverMatch[1] + '/' + coverMatch[2];
    try {
      var img = await axios.get(coverUrl, {
        headers: {
          'User-Agent': 'Mangalix/1.0 (api.mangalix.com.br)',
          'Accept': 'image/*',
        },
        responseType: 'stream',
        timeout: 15000,
      });
      res.set('Content-Type', img.headers['content-type'] || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      img.data.pipe(res);
    } catch (err) {
      var s = (err.response && err.response.status) || 502;
      console.error('[PROXY] cover ' + coverMatch[1] + ' → ' + s);
      res.status(s).json({ error: 'cover proxy error', status: s });
    }
    return;
  }

  // ── MangaDex API ─────────────────────────────────────────────────────────
  var cacheKey = path;
  if (cache.has(cacheKey)) {
    return res.json(cache.get(cacheKey));
  }

  var target = 'https://api.mangadex.org' + path;
  try {
    var upstream = await mdxGet(target);
    cacheSet(cacheKey, upstream.data);
    res.json(upstream.data);
  } catch (err) {
    var status = (err.response && err.response.status) || 502;
    var body = (err.response && err.response.data) || { error: 'MangaDex proxy error' };
    console.error('[PROXY] ' + path.split('?')[0] + ' → ' + status);
    res.status(status).json(body);
  }
};
