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

// ── PLAN LIMITS ──
const PLAN_LIMITS = {
  free: 20,
  solo: 500,
  pro: 2000,
  team: 10000
};

// ── INIT DATABASE TABLES ──
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      plan VARCHAR(50) DEFAULT 'free',
      leads_used INTEGER DEFAULT 0,
      leads_reset_date TIMESTAMP DEFAULT NOW(),
      stripe_customer_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Database ready ✅');
}

initDB().catch(console.error);

// ── CORS ──
app.use(cors({
  origin: [
    'https://bburrell5000.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:5500'
  ]
}));

app.use(express.json());

// ── HEALTH CHECK ──
app.get('/', (req, res) => {
  res.json({ status: 'MedLeads backend running ✅' });
});

// ── GET USER STATUS ──
// Called on login to get current plan + lead count
app.get('/user-status', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    let result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    
    if (!result.rows.length) {
      // Create free user
      await pool.query(
        'INSERT INTO users (email, plan, leads_used) VALUES ($1, $2, $3)',
        [email, 'free', 0]
      );
      result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    }

    const user = result.rows[0];
    
    // Reset monthly count if it's been over 30 days
    const daysSinceReset = (Date.now() - new Date(user.leads_reset_date)) / (1000 * 60 * 60 * 24);
    if (daysSinceReset >= 30 && user.plan !== 'free') {
      await pool.query(
        'UPDATE users SET leads_used = 0, leads_reset_date = NOW() WHERE email = $1',
        [email]
      );
      user.leads_used = 0;
    }

    const limit = PLAN_LIMITS[user.plan] || 20;

    res.json({
      email: user.email,
      plan: user.plan,
      leads_used: user.leads_used,
      leads_limit: limit,
      leads_remaining: Math.max(0, limit - user.leads_used),
    });
  } catch (err) {
    console.error('User status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE: Create checkout session ──
app.post('/create-checkout-session', async (req, res) => {
  const { plan, email } = req.body;

  const PRICE_IDS = {
    solo: process.env.STRIPE_PRICE_SOLO,
    pro:  process.env.STRIPE_PRICE_PRO,
    team: process.env.STRIPE_PRICE_TEAM,
  };

  const priceId = PRICE_IDS[plan];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email || undefined,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { plan },
      success_url: `https://bburrell5000.github.io/Med-leads/medleads-auth.html?session_id={CHECKOUT_SESSION_ID}&status=success`,
      cancel_url: `https://bburrell5000.github.io/Med-leads/medleads-auth.html?status=cancelled`,
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE: Verify session + upgrade user plan ──
app.get('/verify-session', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'No session ID' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription', 'customer'],
    });

    const isActive =
      session.payment_status === 'paid' ||
      session.subscription?.status === 'trialing' ||
      session.subscription?.status === 'active';

    if (isActive && session.customer_details?.email) {
      const email = session.customer_details.email;
      const plan = session.metadata?.plan || 'pro';

      // Upsert user with new plan
      await pool.query(`
        INSERT INTO users (email, plan, leads_used, stripe_customer_id)
        VALUES ($1, $2, 0, $3)
        ON CONFLICT (email) DO UPDATE SET plan = $2, stripe_customer_id = $3
      `, [email, plan, session.customer]);
    }

    res.json({
      active: isActive,
      email: session.customer_details?.email,
      plan: session.metadata?.plan || 'pro',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── APIFY: Scrape doctor emails (with lead limit enforcement) ──
app.post('/scrape-emails', async (req, res) => {
  const { specialty, location, limit = 20, email } = req.body;

  if (!specialty && !location) {
    return res.status(400).json({ error: 'Provide specialty or location' });
  }

  try {
    // Check user lead limit
    let userPlan = 'free';
    let leadsUsed = 0;
    let leadsLimit = 20;

    if (email) {
      let result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
      
      if (!result.rows.length) {
        await pool.query('INSERT INTO users (email, plan, leads_used) VALUES ($1, $2, $3)', [email, 'free', 0]);
        result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
      }

      const user = result.rows[0];
      userPlan = user.plan;
      leadsUsed = user.leads_used;
      leadsLimit = PLAN_LIMITS[user.plan] || 20;

      if (leadsUsed >= leadsLimit) {
        return res.status(403).json({
          error: 'Lead limit reached',
          limit: leadsLimit,
          used: leadsUsed,
          plan: userPlan,
          upgrade_required: true
        });
      }
    }

    // Cap search limit to what user has remaining
    const remaining = leadsLimit - leadsUsed;
    const searchLimit = Math.min(parseInt(limit), 20, remaining);

    // Run Apify scraper
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
    if (!runData.data?.id) throw new Error('Failed to start Apify run');

    const runId = runData.data.id;
    let results = [];

    // Poll for results
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${process.env.APIFY_API_KEY}`);
      const statusData = await statusRes.json();
      const status = statusData.data?.status;

      if (status === 'SUCCEEDED') {
        const datasetRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${process.env.APIFY_API_KEY}`);
        results = await datasetRes.json();
        break;
      }
      if (status === 'FAILED' || status === 'ABORTED') throw new Error(`Apify run ${status}`);
    }

    // Update lead count in database
    if (email && results.length > 0) {
      await pool.query(
        'UPDATE users SET leads_used = leads_used + $1 WHERE email = $2',
        [results.length, email]
      );
    }

    // Format results
    const formatted = results.map(r => ({
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
      social: r.scraped_social_media || [],
    }));

    // Return results with updated usage info
    const newUsed = leadsUsed + results.length;
    res.json({
      results: formatted,
      count: formatted.length,
      usage: {
        leads_used: newUsed,
        leads_limit: leadsLimit,
        leads_remaining: Math.max(0, leadsLimit - newUsed),
        plan: userPlan
      }
    });

  } catch (err) {
    console.error('Scrape error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE: Customer portal ──
app.post('/customer-portal', async (req, res) => {
  const { customer_email } = req.body;
  try {
    const customers = await stripe.customers.list({ email: customer_email, limit: 1 });
    if (!customers.data.length) return res.status(404).json({ error: 'Customer not found' });
    const session = await stripe.billingPortal.sessions.create({
      customer: customers.data[0].id,
      return_url: `https://bburrell5000.github.io/Med-leads/medleads-auth.html`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`MedLeads backend running on port ${PORT}`));
