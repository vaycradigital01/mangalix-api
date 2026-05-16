const express = require('express');
const router  = express.Router();
const { supabaseAdmin } = require('../config/supabase');

// GET /user/profile
router.get('/profile', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('id', req.userId)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PUT /user/profile
router.put('/profile', async (req, res) => {
  const { nick, avatar_preset, avatar_url, push_token } = req.body;

  // Validação de nick
  if (nick) {
    if (nick.length < 3 || nick.length > 24)
      return res.status(400).json({ error: 'Nick deve ter 3–24 caracteres.' });

    const blocked = [
      /\b(sex|sexy|porno?|nude|foda|buceta|pica|putx|viado|bicha)\b/i,
      /\b(nigger|faggot|dyke|tranny|nazi|kkk)\b/i,
    ];
    for (const p of blocked) {
      if (p.test(nick))
        return res.status(400).json({ error: 'Nick contém conteúdo não permitido.' });
    }
  }

  const { data, error } = await supabaseAdmin
    .from('users')
    .update({ nick, avatar_preset, avatar_url, push_token, updated_at: new Date() })
    .eq('id', req.userId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /user/favorites
router.get('/favorites', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('user_favorites')
    .select('*')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /user/favorites/:mangaId
router.post('/favorites/:mangaId', async (req, res) => {
  const { mangaId } = req.params;
  const { mdx_id, title, cover_url } = req.body;

  // Verificar limite free (5 favoritos)
  const { data: user } = await supabaseAdmin
    .from('users').select('plan').eq('id', req.userId).single();

  if (user?.plan === 'free') {
    const { count } = await supabaseAdmin
      .from('user_favorites')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.userId);
    if (count >= 5)
      return res.status(403).json({ error: 'Limite de 5 favoritos no plano Free.', upgrade: true });
  }

  const { data, error } = await supabaseAdmin
    .from('user_favorites')
    .upsert({ user_id: req.userId, manga_id: mangaId, mdx_id, title, cover_url })
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /user/favorites/:mangaId
router.delete('/favorites/:mangaId', async (req, res) => {
  const { error } = await supabaseAdmin
    .from('user_favorites')
    .delete()
    .eq('user_id', req.userId)
    .eq('manga_id', req.params.mangaId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// GET /user/history
router.get('/history', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('reading_history')
    .select('*')
    .eq('user_id', req.userId)
    .order('updated_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /user/history
router.post('/history', async (req, res) => {
  const { manga_id, chapter_id, chapter_num, page_num, completed } = req.body;

  const { data, error } = await supabaseAdmin
    .from('reading_history')
    .upsert({
      user_id: req.userId, manga_id, chapter_id,
      chapter_num, page_num, completed,
      updated_at: new Date()
    })
    .select().single();

  if (error) return res.status(500).json({ error: error.message });

  // Registrar sessão de leitura para streak
  await supabaseAdmin.from('user_reading_sessions')
    .insert({ user_id: req.userId });

  // Conceder moedas
  if (page_num % 10 === 0 || completed) {
    const { awardCoinsForReading } = require('../jobs/coins');
    await awardCoinsForReading(req.userId, page_num % 10 === 0 ? 10 : 0, completed);
  }

  res.json(data);
});

// GET /user/coins
router.get('/coins', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('coins, coins_lifetime')
    .eq('id', req.userId)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
