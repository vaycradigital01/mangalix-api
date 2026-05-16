require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

// Webhooks ANTES do json parser
try { app.use('/webhook/stripe',      require('./routes/webhook-stripe')); } catch(e) { console.error('webhook-stripe:', e.message); }
try { app.use('/webhook/infinitepay', require('./routes/webhook-infinitepay')); } catch(e) { console.error('webhook-infinitepay:', e.message); }

app.use(express.json({ limit: '10mb' }));

// Rotas públicas
app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'Mangalix API', ts: Date.now() });
});

app.get('/plans', (req, res) => {
  res.json({ plans: [
    { id: 'starter',        name: 'Starter',       price: 990,   pages: 150, interval: 'month' },
    { id: 'pro',            name: 'Pro',            price: 2490,  pages: 500, interval: 'month' },
    { id: 'starter_annual', name: 'Starter Anual', price: 8900,  pages: 150, interval: 'year'  },
    { id: 'pro_annual',     name: 'Pro Anual',     price: 21900, pages: 500, interval: 'year'  },
  ]});
});

// Rotas autenticadas
try {
  const auth = require('./middleware/auth');
  app.use('/user',         auth, require('./routes/user'));
  app.use('/payment',      auth, require('./routes/payment'));
  app.use('/translate',    auth, require('./routes/translate'));
  app.use('/subscription', auth, require('./routes/payment'));
  app.use('/ranking',           require('./routes/ranking'));
} catch(e) {
  console.error('Rotas:', e.message);
}

// Cron jobs
try {
  const cron = require('node-cron');
  cron.schedule('*/30 * * * *', async () => {
    try { await require('./jobs/chapterNotifier').checkNewChapters(); } catch(e) { console.error('[CRON]', e.message); }
  });
  cron.schedule('0 0 * * *', async () => {
    try { await require('./jobs/coins').resetDailyCoins(); } catch(e) { console.error('[CRON]', e.message); }
  });
  cron.schedule('0 10 * * *', async () => {
    try { await require('./jobs/pixRenewal').processPixRenewals(); } catch(e) { console.error('[CRON]', e.message); }
  });
} catch(e) {
  console.error('Cron:', e.message);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Mangalix API rodando na porta ${PORT}`);
});
