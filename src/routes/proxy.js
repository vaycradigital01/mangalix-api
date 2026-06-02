/**
 * MANGALIX — MangaDex Proxy Routes
 *
 * Cole em src/routes/proxy.js no mangalix-api.
 * No server.js, adicione ANTES das outras rotas:
 *
 *   const proxyRouter = require('./src/routes/proxy');
 *   app.use('/proxy/mangadex', proxyRouter);
 */

const express = require('express');
const axios = require('axios');

const router = express.Router();

const MDX_API = 'https://api.mangadex.org';
const MDX_UPLOADS = 'https://uploads.mangadex.org';
const HEADERS = {
  'User-Agent': 'Mangalix/1.0 (api.mangalix.com.br)',
  Accept: 'application/json',
};

// ─── In-memory cache ──────────────────────────────────────────────────────────

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60; // 1 hora

function cacheSet(key, data) {
  cache.set(key, data);
  setTimeout(() => cache.delete(key), CACHE_TTL);
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────
// Garante no mínimo 500 ms entre requisições upstream ao MangaDex.
// lastRequestTime é compartilhado entre todas as rotas deste módulo.

let lastRequestTime = 0;

async function mdxGet(url) {
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < 500) {
    await new Promise((r) => setTimeout(r, 500 - elapsed));
  }
  lastRequestTime = Date.now();
  return axios.get(url, { headers: HEADERS, timeout: 20_000 });
}

// ─── Cover image proxy ────────────────────────────────────────────────────────
// DEVE vir ANTES do wildcard abaixo — Express avalia rotas em ordem.

router.get('/cover/:mangaId/:fileName', async (req, res) => {
  const { mangaId, fileName } = req.params;
  const url = `${MDX_UPLOADS}/covers/${mangaId}/${fileName}`;
  try {
    const upstream = await axios.get(url, {
      headers: { 'User-Agent': HEADERS['User-Agent'], Accept: 'image/*' },
      responseType: 'stream',
      timeout: 15_000,
    });
    res.set('Content-Type', upstream.headers['content-type'] ?? 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    upstream.data.pipe(res);
  } catch (err) {
    const status = err.response?.status ?? 502;
    console.error(`[PROXY] cover ${mangaId}/${fileName} → ${status}`);
    res.status(status).json({ error: 'cover proxy error', status });
  }
});

// ─── Generic MangaDex API proxy ───────────────────────────────────────────────
// Usa req.url (não req.query) para preservar a query string raw e evitar
// re-serialização incorreta de params como links[al]= e includes[]=.

router.get('*', async (req, res) => {
  // req.url dentro do router = path + query string relativos ao mount point
  const cacheKey = req.url;

  if (cache.has(cacheKey)) {
    return res.json(cache.get(cacheKey));
  }

  const target = `${MDX_API}${req.url}`;

  try {
    const upstream = await mdxGet(target);
    cacheSet(cacheKey, upstream.data);
    res.json(upstream.data);
  } catch (err) {
    const status = err.response?.status ?? 502;
    const body = err.response?.data ?? { error: 'MangaDex proxy error' };
    console.error(`[PROXY] ${req.path} → ${status}`);
    res.status(status).json(body);
  }
});

module.exports = router;
