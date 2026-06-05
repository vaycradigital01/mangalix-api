/**
 * MANGALIX — MangaDex Proxy
 * src/routes/proxy.js (mangalix-api)
 */

const axios = require('axios');

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

// ─── Cache agressivo ──────────────────────────────────────────────────────────
var cache = new Map();
var staleCache = new Map(); // cache antigo para stale-while-revalidate

var TTL = {
  search:   24 * 60 * 60 * 1000, // 24h — títulos não mudam
  chapters:  2 * 60 * 60 * 1000, // 2h  — capítulos
  manga:     6 * 60 * 60 * 1000, // 6h  — info do manga
  default:   1 * 60 * 60 * 1000, // 1h  — resto
};

function getTTL(path) {
  if (path.indexOf('/feed') !== -1) return TTL.chapters;
  if (path.indexOf('/manga?') !== -1 || path.indexOf('/manga/') !== -1) return TTL.manga;
  if (path.indexOf('title=') !== -1) return TTL.search;
  return TTL.default;
}

function cacheSet(key, data) {
  var ttl = getTTL(key);
  cache.set(key, data);
  staleCache.set(key, data); // mantém para fallback
  setTimeout(function () { cache.delete(key); }, ttl);
}

// ─── GET com retry e stale fallback ──────────────────────────────────────────
async function mdxGet(url, path) {
  try {
    var res = await doGet(url);
    return res;
  } catch (err) {
    var status = err.response && err.response.status;
    if (status === 429) {
      // Tenta uma vez após 5s
      console.warn('[PROXY] 429 — waiting 5s before retry:', path.split('?')[0]);
      await sleep(5000);
      try {
        return await doGet(url);
      } catch (err2) {
        // Se ainda 429, lança para usar stale cache
        throw err2;
      }
    }
    throw err;
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────
module.exports = async function proxyMangaDex(req, res) {
  var path = req.url;

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
      res.status(s).json({ error: 'cover proxy error', status: s });
    }
    return;
  }

  // ── MangaDex API — cache agressivo + stale fallback ──────────────────────
  var cacheKey = path;

  // Cache fresco — retorna imediatamente
  if (cache.has(cacheKey)) {
    return res.json(cache.get(cacheKey));
  }

  var target = 'https://api.mangadex.org' + path;
  try {
    var upstream = await mdxGet(target, path);
    cacheSet(cacheKey, upstream.data);
    res.json(upstream.data);
  } catch (err) {
    var status = (err.response && err.response.status) || 502;

    // Se 429 e tem cache antigo — usa stale cache
    if (status === 429 && staleCache.has(cacheKey)) {
      console.warn('[PROXY] 429 — serving stale cache for:', path.split('?')[0]);
      return res.json(staleCache.get(cacheKey));
    }

    var body = (err.response && err.response.data) || { error: 'MangaDex proxy error' };
    console.error('[PROXY] ' + path.split('?')[0] + ' → ' + status);
    res.status(status).json(body);
  }
};
