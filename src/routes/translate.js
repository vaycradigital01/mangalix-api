// ══════════════════════════════════════════════════════════
// translate.js — Proxy seguro da Torii API
// ══════════════════════════════════════════════════════════
const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const FormData = require('form-data');
const { supabaseAdmin } = require('../config/supabase');

const PAGE_LIMITS = { free: 0, starter: 150, pro: 500 };

router.post('/', async (req, res) => {
  const { imageUrl, targetLang } = req.body;
  if (!imageUrl || !targetLang)
    return res.status(400).json({ error: 'imageUrl e targetLang são obrigatórios.' });

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('plan, plan_expires_at, pages_translated_this_month')
    .eq('id', req.userId).single();

  if (!user || user.plan === 'free')
    return res.status(403).json({
      error: 'Tradução disponível nos planos Starter e Pro.',
      upgradeUrl: 'https://mangalix.com.br/planos',
    });

  if (user.plan_expires_at && new Date(user.plan_expires_at) < new Date())
    return res.status(403).json({
      error: 'Sua assinatura expirou.',
      upgradeUrl: 'https://mangalix.com.br/planos',
    });

  const limit = PAGE_LIMITS[user.plan] || 0;
  if ((user.pages_translated_this_month || 0) >= limit)
    return res.status(429).json({
      error: `Limite de ${limit} páginas/mês atingido.`,
      upgradeUrl: 'https://mangalix.com.br/planos',
    });

  try {
    const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const fd = new FormData();
    fd.append('file', Buffer.from(imgResp.data), { filename: 'page.jpg', contentType: 'image/jpeg' });
    fd.append('target_lang', targetLang);
    fd.append('translator', 'gemini-2.0-flash-lite');
    fd.append('font', 'NotoSans');
    fd.append('text_align', 'auto');
    fd.append('bubbles_only', 'false');

    const toriiRes = await axios.post('https://api.toriitranslate.com/api/v2/upload', fd, {
      headers: { ...fd.getHeaders(), Authorization: `Bearer ${process.env.TORII_API_KEY}` },
      timeout: 30000,
    });

    await supabaseAdmin.rpc('increment_pages_translated', { p_user_id: req.userId });
    res.json({ image: toriiRes.data.image });
  } catch(e) {
    console.error('Torii error:', e.response?.data || e.message);
    if (e.response?.status === 402)
      return res.status(402).json({ error: 'Créditos insuficientes. Contate o suporte.' });
    res.status(500).json({ error: 'Erro ao traduzir. Tente novamente.' });
  }
});

module.exports = router;
