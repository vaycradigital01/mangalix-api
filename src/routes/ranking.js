// ══════════════════════════════════════════════════════════
// ranking.js
// ══════════════════════════════════════════════════════════
const express = require('express');
const router  = express.Router();
const { supabaseAdmin } = require('../config/supabase');

router.get('/', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('nick, avatar_preset, plan, pages_read_total, coins_lifetime')
    .order('pages_read_total', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map((u, i) => ({ ...u, position: i + 1 })));
});

module.exports = router;
