require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ── DATABASE ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const PLAN_LIMITS = { free: 20, solo: 500, pro: 2000, team: 10000 };

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      plan VARCHAR(50) DEFAULT 'free',
      leads_used INTEGER DEFAULT 0,
      leads_reset_date TIMESTAMP DEFAULT NOW(),
      stripe_customer_id VARCHAR(255),
      on_trial BOOLEAN DEFAULT FALSE,
      trial_ends_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );
    -- Add trial columns if they don't exist (for existing databases)
    ALTER TABLE users ADD COLUMN IF NOT EXISTS on_trial BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS searches (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      specialty TEXT,
      location TEXT,
      result_count INTEGER DEFAULT 0,
      results JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS search_cache (
      id SERIAL PRIMARY KEY,
      cache_key VARCHAR(500) UNIQUE NOT NULL,
      specialty TEXT,
      location TEXT,
      result_count INTEGER DEFAULT 0,
      results JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      hit_count INTEGER DEFAULT 0
    );
  `);
  console.log('Database ready ✅');
}
initDB().catch(console.error);

// ── CACHE HELPERS ──
const CACHE_TTL_DAYS = 7; // cached results stay fresh for 7 days

function makeCacheKey(specialty, location, limit) {
  // Normalize: lowercase, trim, sort words so "Miami Florida" == "florida miami"
  const spec = (specialty || '').toLowerCase().trim().split(/\s+/).sort().join(' ');
  const loc  = (location  || '').toLowerCase().trim().split(/\s+/).sort().join(' ');
  return `${spec}|${loc}|${limit}`;
}

async function getCached(cacheKey) {
  const result = await pool.query(
    `SELECT * FROM search_cache
     WHERE cache_key = $1
     AND created_at > NOW() - INTERVAL '${CACHE_TTL_DAYS} days'`,
    [cacheKey]
  );
  if (!result.rows.length) return null;
  // Increment hit counter (fire-and-forget)
  pool.query('UPDATE search_cache SET hit_count = hit_count + 1 WHERE cache_key = $1', [cacheKey]).catch(() => {});
  return result.rows[0];
}

async function saveCache(cacheKey, specialty, location, results) {
  await pool.query(
    `INSERT INTO search_cache (cache_key, specialty, location, result_count, results)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (cache_key) DO UPDATE
     SET results = $5, result_count = $4, created_at = NOW(), hit_count = 0`,
    [cacheKey, specialty, location, results.length, JSON.stringify(results)]
  );
}

app.use(cors({
  origin: ['https://bburrell5000.github.io', 'http://localhost:3000', 'http://127.0.0.1:5500']
}));

// Stripe webhook needs raw body — must come BEFORE express.json()
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'MedLeads backend running ✅' }));

// ── USER STATUS ──
app.get('/user-status', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    let result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (!result.rows.length) {
      await pool.query('INSERT INTO users (email, plan, leads_used) VALUES ($1, $2, $3)', [email, 'free', 0]);
      result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    }
    const user = result.rows[0];
    const limit = PLAN_LIMITS[user.plan] || 20;
    res.json({ 
      email: user.email, 
      plan: user.plan, 
      leads_used: user.leads_used, 
      leads_limit: limit, 
      leads_remaining: Math.max(0, limit - user.leads_used),
      on_trial: user.on_trial || false,
      trial_ends_at: user.trial_ends_at || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE ──
app.post('/create-checkout-session', async (req, res) => {
  const { plan, email } = req.body;
  const PRICE_IDS = { solo: process.env.STRIPE_PRICE_SOLO, pro: process.env.STRIPE_PRICE_PRO, team: process.env.STRIPE_PRICE_TEAM };
  const priceId = PRICE_IDS[plan];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan' });
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'], mode: 'subscription',
      customer_email: email || undefined,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { plan },
      success_url: `https://bburrell5000.github.io/Med-leads/medleads-auth.html?session_id={CHECKOUT_SESSION_ID}&status=success`,
      cancel_url: `https://bburrell5000.github.io/Med-leads/medleads-auth.html?status=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── TRIAL CHECKOUT — 30 days free then auto-charges ──
app.post('/create-trial-session', async (req, res) => {
  const { email } = req.body;
  const priceId = process.env.STRIPE_PRICE_SOLO;
  if (!priceId) return res.status(400).json({ error: 'Solo price not configured' });
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email || undefined,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 30,
        metadata: { plan: 'solo', trial: 'true' }
      },
      metadata: { plan: 'solo', trial: 'true' },
      success_url: `https://medleads.org/medleads-auth.html?session_id={CHECKOUT_SESSION_ID}&status=success&trial=true`,
      cancel_url: `https://medleads.org/medleads-auth.html?status=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CANCEL SUBSCRIPTION ──
app.post('/cancel-subscription', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    // Find customer by email
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) return res.status(404).json({ error: 'No customer found' });
    
    const customer = customers.data[0];
    
    // Get active subscriptions
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active',
      limit: 1
    });

    // Also check trialing
    const trialing = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'trialing',
      limit: 1
    });

    const sub = subscriptions.data[0] || trialing.data[0];
    if (!sub) return res.status(404).json({ error: 'No active subscription found' });

    // Cancel at period end — they keep access until billing date
    await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });

    const periodEnd = new Date(sub.current_period_end * 1000).toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric'
    });

    res.json({ 
      cancelled: true, 
      message: `Subscription cancelled. Access continues until ${periodEnd}.`,
      access_until: periodEnd
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SUBSCRIPTION STATUS ──
app.get('/subscription-status', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) return res.json({ has_subscription: false });
    
    const customer = customers.data[0];
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'all',
      limit: 1
    });

    if (!subscriptions.data.length) return res.json({ has_subscription: false });

    const sub = subscriptions.data[0];
    const periodEnd = new Date(sub.current_period_end * 1000).toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric'
    });

    res.json({
      has_subscription: true,
      status: sub.status,
      cancel_at_period_end: sub.cancel_at_period_end,
      current_period_end: periodEnd,
      plan: sub.metadata?.plan || 'unknown'
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/verify-session', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'No session ID' });
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id, { expand: ['subscription', 'customer'] });
    const isActive = session.payment_status === 'paid' || session.subscription?.status === 'trialing' || session.subscription?.status === 'active';
    if (isActive && session.customer_details?.email) {
      const email = session.customer_details.email;
      const plan = session.metadata?.plan || 'pro';
      await pool.query(`INSERT INTO users (email, plan, leads_used, stripe_customer_id) VALUES ($1, $2, 0, $3) ON CONFLICT (email) DO UPDATE SET plan = $2, stripe_customer_id = $3`, [email, plan, session.customer]);
    }
    res.json({ active: isActive, email: session.customer_details?.email, plan: session.metadata?.plan || 'pro' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── APIFY SCRAPE ── 
// Uses async approach: start run, return run_id immediately, poll separately
app.post('/scrape-emails', async (req, res) => {
  const { specialty, location, limit = 20, email } = req.body;
  if (!specialty && !location) return res.status(400).json({ error: 'Provide specialty or location' });

  try {
    // Check lead limit
    let userPlan = 'free', leadsUsed = 0, leadsLimit = 20;
    if (email) {
      let result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
      if (!result.rows.length) {
        await pool.query('INSERT INTO users (email, plan, leads_used) VALUES ($1, $2, $3)', [email, 'free', 0]);
        result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
      }
      const user = result.rows[0];
      userPlan = user.plan; leadsUsed = user.leads_used;
      leadsLimit = PLAN_LIMITS[user.plan] || 20;
      if (leadsUsed >= leadsLimit) {
        return res.status(403).json({ error: 'Lead limit reached', limit: leadsLimit, used: leadsUsed, plan: userPlan, upgrade_required: true });
      }
    }

    const remaining = leadsLimit - leadsUsed;
    const searchLimit = Math.min(parseInt(limit), 100, remaining);

    // ── CACHE CHECK — serve cached results if available ──
    const cacheKey = makeCacheKey(specialty, location, searchLimit);
    const cached = await getCached(cacheKey);
    if (cached) {
      console.log(`Cache HIT: ${cacheKey} (${cached.hit_count + 1} hits)`);
      // Slice to requested limit in case cache has more results
      const cachedResults = (cached.results || []).slice(0, searchLimit);
      const newUsed = leadsUsed + cachedResults.length;

      // Still count against lead limit and save to user history
      if (email && cachedResults.length > 0) {
        await pool.query('UPDATE users SET leads_used = leads_used + $1 WHERE email = $2', [cachedResults.length, email]);
        pool.query(
          'INSERT INTO searches (email, specialty, location, result_count, results) VALUES ($1, $2, $3, $4, $5)',
          [email, specialty || '', location || '', cachedResults.length, JSON.stringify(cachedResults)]
        ).catch(() => {});
      }

      return res.json({
        results: cachedResults,
        count: cachedResults.length,
        cached: true,
        usage: { leads_used: newUsed, leads_limit: leadsLimit, leads_remaining: Math.max(0, leadsLimit - newUsed), plan: userPlan }
      });
    }
    console.log(`Cache MISS: ${cacheKey} — calling Apify`);

    // Start Apify run
    const runResponse = await fetch(
      `https://api.apify.com/v2/acts/contacts-api~doctors-email-scraper/runs?token=${process.env.APIFY_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          googleMapsSearchTerm: specialty || 'Doctors',
          googleMapsLocation: [location || 'United States'],
          maxBusinesses: searchLimit,
          scrapeMaxBusinessesPerLocation: false,
          proxyConfiguration: { useApifyProxy: true }
        }),
      }
    );

    const runData = await runResponse.json();
    if (!runData.data?.id) throw new Error('Failed to start Apify run: ' + JSON.stringify(runData));
    const runId = runData.data.id;
    console.log(`Apify run started: ${runId}`);

    // Poll up to 3 minutes (36 x 5s)
    let results = [];
    for (let i = 0; i < 36; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${process.env.APIFY_API_KEY}`);
      const statusData = await statusRes.json();
      const status = statusData.data?.status;
      console.log(`Poll ${i + 1}: ${status}`);

      if (status === 'SUCCEEDED') {
        const datasetRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${process.env.APIFY_API_KEY}`);
        results = await datasetRes.json();
        break;
      }
      if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
        throw new Error(`Apify run ${status}`);
      }
    }

    // Deduplicate by website
    const seen = new Set();
    const unique = results.filter(r => {
      const key = r.website || r.name;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });

    // Update lead count
    if (email && unique.length > 0) {
      await pool.query('UPDATE users SET leads_used = leads_used + $1 WHERE email = $2', [unique.length, email]);
    }

    const formatted = unique.map(r => ({
      name: r.name || '',
      email: r.scraped_emails?.[0] || '',
      emails: r.scraped_emails || [],
      phone: r.phone || r.scraped_phones?.[0] || '',
      address: r.full_address || '',
      city: r.city || '',
      state: r.state || '',
      website: r.website || '',
      rating: r.avg_rating || null,
      reviews: r.total_reviews || 0,
      social: r.scraped_social_media?.map(s => s.url || s).filter(Boolean) || [],
    }));

    const newUsed = leadsUsed + unique.length;

    // Auto-save search to history
    if (email && formatted.length > 0) {
      try {
        await pool.query(
          'INSERT INTO searches (email, specialty, location, result_count, results) VALUES ($1, $2, $3, $4, $5)',
          [email, specialty || '', location || '', formatted.length, JSON.stringify(formatted)]
        );
      } catch (saveErr) {
        console.error('Failed to save search history:', saveErr.message);
      }
    }

    // Save to shared cache so future searches for same query skip Apify
    saveCache(cacheKey, specialty || '', location || '', formatted).catch(err =>
      console.error('Cache save failed:', err.message)
    );

    res.json({
      results: formatted, count: formatted.length,
      cached: false,
      usage: { leads_used: newUsed, leads_limit: leadsLimit, leads_remaining: Math.max(0, leadsLimit - newUsed), plan: userPlan }
    });

  } catch (err) {
    console.error('Scrape error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── SAVE SEARCH ──
app.post('/save-search', async (req, res) => {
  const { email, specialty, location, results } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    await pool.query(
      'INSERT INTO searches (email, specialty, location, result_count, results) VALUES ($1, $2, $3, $4, $5)',
      [email, specialty || '', location || '', results?.length || 0, JSON.stringify(results || [])]
    );
    res.json({ saved: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET SEARCH HISTORY ──
app.get('/my-searches', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    // Get user plan first
    const userResult = await pool.query('SELECT plan FROM users WHERE email = $1', [email]);
    const plan = userResult.rows[0]?.plan || 'free';

    // Plan-based history limits
    const HISTORY_LIMITS = { free: 5, solo: 20, pro: 50, team: 100 };
    const limit = HISTORY_LIMITS[plan] || 5;

    const result = await pool.query(
      'SELECT id, specialty, location, result_count, results, created_at FROM searches WHERE email = $1 ORDER BY created_at DESC LIMIT $2',
      [email, limit]
    );
    res.json({ searches: result.rows, history_limit: limit, plan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET SINGLE SAVED SEARCH ──
app.get('/my-searches/:id', async (req, res) => {
  const { email } = req.query;
  const { id } = req.params;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const result = await pool.query(
      'SELECT * FROM searches WHERE id = $1 AND email = $2',
      [id, email]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Search not found' });
    res.json({ search: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE SEARCH ──
app.delete('/my-searches/:id', async (req, res) => {
  const { email } = req.query;
  const { id } = req.params;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    await pool.query('DELETE FROM searches WHERE id = $1 AND email = $2', [id, email]);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/customer-portal', async (req, res) => {
  const { customer_email } = req.body;
  try {
    const customers = await stripe.customers.list({ email: customer_email, limit: 1 });
    if (!customers.data.length) return res.status(404).json({ error: 'Customer not found' });
    const session = await stripe.billingPortal.sessions.create({ customer: customers.data[0].id, return_url: `https://bburrell5000.github.io/Med-leads/medleads-auth.html` });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── STRIPE WEBHOOK ──
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`Webhook received: ${event.type}`);

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_details?.email || session.metadata?.email;
      const plan = session.metadata?.plan;

      if (email && plan) {
        await pool.query(
          `INSERT INTO users (email, plan, leads_used)
           VALUES ($1, $2, 0)
           ON CONFLICT (email)
           DO UPDATE SET plan = $2, leads_used = 0`,
          [email, plan]
        );
        console.log(`Plan updated: ${email} → ${plan}`);
      }
    }

    if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      // Get customer email from Stripe
      const customer = await stripe.customers.retrieve(sub.customer);
      const email = customer.email;
      const status = sub.status;

      if (email && (status === 'active' || status === 'trialing')) {
        // Find which plan based on price ID
        const priceId = sub.items.data[0]?.price?.id;
        const PRICE_MAP = {
          [process.env.STRIPE_PRICE_SOLO]: 'solo',
          [process.env.STRIPE_PRICE_PRO]: 'pro',
          [process.env.STRIPE_PRICE_TEAM]: 'team',
        };
        const plan = PRICE_MAP[priceId];
        if (plan) {
          await pool.query(
            'UPDATE users SET plan = $1 WHERE email = $2',
            [plan, email]
          );
          console.log(`Subscription updated: ${email} → ${plan}`);
        }
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      // Subscription cancelled — revert to free
      const sub = event.data.object;
      const customer = await stripe.customers.retrieve(sub.customer);
      const email = customer.email;
      if (email) {
        await pool.query(
          'UPDATE users SET plan = $1 WHERE email = $2',
          ['free', email]
        );
        console.log(`Subscription cancelled: ${email} → free`);
      }
    }

  } catch (err) {
    console.error('Webhook handler error:', err.message);
  }

  res.json({ received: true });
});

app.listen(PORT, () => console.log(`MedLeads backend running on port ${PORT}`));
