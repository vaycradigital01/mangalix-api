require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const cron      = require('node-cron');

const app = express();

// ── Segurança ──────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*'
}));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
}));

// Rate limit específico para tradução
const translateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Muitas requisições. Aguarde.' }
});

// ── Webhooks ANTES do json parser ──────────────────────────
app.use('/webhook/stripe',      require('./src/routes/webhook-stripe'));
app.use('/webhook/infinitepay', require('./src/routes/webhook-infinitepay'));

// ── Body parsing ───────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

// ── Rotas públicas ─────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'Mangalix API', ts: Date.now() });
});

app.get('/plans', (req, res) => {
  res.json({
    plans: [
      { id: 'starter',        name: 'Starter',       price: 990,   pages: 150, interval: 'month' },
      { id: 'pro',            name: 'Pro',            price: 2490,  pages: 500, interval: 'month' },
      { id: 'starter_annual', name: 'Starter Anual', price: 8900,  pages: 150, interval: 'year'  },
      { id: 'pro_annual',     name: 'Pro Anual',     price: 21900, pages: 500, interval: 'year'  },
    ]
  });
});

// ── Rotas autenticadas ─────────────────────────────────────
const auth = require('./src/middleware/auth');
app.use('/user',         auth, require('./src/routes/user'));
app.use('/payment',      auth, require('./src/routes/payment'));
app.use('/translate',    auth, translateLimiter, require('./src/routes/translate'));
app.use('/subscription', auth, require('./src/routes/payment'));
app.use('/ranking',           require('./src/routes/ranking'));

// ── Cron Jobs ──────────────────────────────────────────────
// Novos capítulos — a cada 30 min
cron.schedule('*/30 * * * *', async () => {
  console.log('[CRON] Verificando novos capítulos...');
  try { await require('./src/jobs/chapterNotifier').checkNewChapters(); }
  catch(e) { console.error('[CRON] Erro capítulos:', e.message); }
});

// Reset moedas — meia-noite
cron.schedule('0 0 * * *', async () => {
  console.log('[CRON] Reset de moedas...');
  try { await require('./src/jobs/coins').resetDailyCoins(); }
  catch(e) { console.error('[CRON] Erro moedas:', e.message); }
});

// Avisos Pix — 10h da manhã
cron.schedule('0 10 * * *', async () => {
  console.log('[CRON] Avisos renovação Pix...');
  try { await require('./src/jobs/pixRenewal').processPixRenewals(); }
  catch(e) { console.error('[CRON] Erro Pix:', e.message); }
});

// ── Start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Mangalix API rodando na porta ${PORT}`);
});
