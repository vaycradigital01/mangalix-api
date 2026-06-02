/**
 * MANGALIX — MangaDex Proxy
 * Salva em: src/routes/proxy.js  (no mangalix-api)
 *
 * No server.js, ANTES do express.json():
 *   app.use('/proxy/mangadex', require('./src/routes/proxy'));
 */

const axios = require('axios');

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Duas filas independentes de rate limiting ────────────────────────────────
// Capas: 1500ms — lento, não bloqueia a fila de API
// API (manga, chapters, search): 500ms — rápido, prioritário

var lastCoverRequest = 0;
var lastApiRequest = 0;

async function mdxGetCover(url) {
  var elapsed = Date.now() - lastCoverRequest;
  if (elapsed < 1500) await sleep(1500 - elapsed);
  lastCoverRequest = Date.now();
  return doGet(url);
}

async function mdxGetApi(url) {
  var elapsed = Date.now() - lastApiRequest;
  if (elapsed < 500) await sleep(500 - elapsed);
  lastApiRequest = Date.now();

  try {
    return await doGet(url);
  } catch (err) {
    var status = err.response && err.response.status;
    if (status === 429) {
      console.warn('[PROXY] 429 from MangaDex — waiting 5s before retry');
      await sleep(5000);
      lastApiRequest = Date.now();
      return doGet(url);
    }
    throw err;
  }
}

// ─── Cache ────────────────────────────────────────────────────────────────────
// Cache geral (search, manga info): 1 hora
// Cache de capítulos (/feed): 30 minutos

var cache = new Map();
var chaptersCache = new Map();

var CACHE_TTL          = 60 * 60 * 1000;      // 1 hora
var CHAPTERS_CACHE_TTL = 30 * 60 * 1000;      // 30 minutos

function cacheSet(key, data) {
  cache.set(key, data);
  setTimeout(function () { cache.delete(key); }, CACHE_TTL);
}

function chaptersCacheSet(key, data) {
  chaptersCache.set(key, data);
  setTimeout(function () { chaptersCache.delete(key); }, CHAPTERS_CACHE_TTL);
}

// ─── Middleware ───────────────────────────────────────────────────────────────

module.exports = async function proxyMangaDex(req, res) {
  var path = req.url; // inclui query string

  // ── Cover image (/cover/:mangaId/:fileName) ──────────────────────────────
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

  // ── Chapter feed (/manga/:id/feed*) — cache 30 min, fila API ────────────
  var isFeed = path.indexOf('/feed') !== -1;
  if (isFeed) {
    var chapKey = path;
    if (chaptersCache.has(chapKey)) {
      return res.json(chaptersCache.get(chapKey));
    }
    var feedTarget = 'https://api.mangadex.org' + path;
    try {
      var feedUpstream = await mdxGetApi(feedTarget);
      chaptersCacheSet(chapKey, feedUpstream.data);
      return res.json(feedUpstream.data);
    } catch (err) {
      var fs = (err.response && err.response.status) || 502;
      var fb = (err.response && err.response.data) || { error: 'MangaDex proxy error' };
      console.error('[PROXY] feed ' + path.split('?')[0] + ' → ' + fs);
      return res.status(fs).json(fb);
    }
  }

  // ── Generic MangaDex API — cache 1h, fila API ────────────────────────────
  var cacheKey = path;
  if (cache.has(cacheKey)) {
    return res.json(cache.get(cacheKey));
  }
  var target = 'https://api.mangadex.org' + path;
  try {
    var upstream = await mdxGetApi(target);
    cacheSet(cacheKey, upstream.data);
    res.json(upstream.data);
  } catch (err) {
    var status = (err.response && err.response.status) || 502;
    var body = (err.response && err.response.data) || { error: 'MangaDex proxy error' };
    console.error('[PROXY] ' + path.split('?')[0] + ' → ' + status);
    res.status(status).json(body);
  }
};
