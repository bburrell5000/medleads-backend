require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// ── CORS: allow requests from your GitHub Pages site ──
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

// ── STRIPE: Create checkout session ──
// Called when user clicks "Start Free Trial" and picks a plan
app.post('/create-checkout-session', async (req, res) => {
  const { plan, email } = req.body;

  const PRICE_IDS = {
    solo: process.env.STRIPE_PRICE_SOLO,
    pro:  process.env.STRIPE_PRICE_PRO,
    team: process.env.STRIPE_PRICE_TEAM,
  };

  const priceId = PRICE_IDS[plan];
  if (!priceId) {
    return res.status(400).json({ error: 'Invalid plan selected' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email || undefined,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 14, // 14-day free trial
      },
      success_url: `https://bburrell5000.github.io/Med-leads/medleads-auth.html?session_id={CHECKOUT_SESSION_ID}&status=success`,
      cancel_url: `https://bburrell5000.github.io/Med-leads/medleads-auth.html?status=cancelled`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE: Verify subscription after checkout ──
// Called when user lands back on site after paying
app.get('/verify-session', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'No session ID' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription', 'customer'],
    });

    const isActive =
      session.payment_status === 'paid' ||
      session.subscription?.status === 'trialing';

    res.json({
      active: isActive,
      email: session.customer_details?.email,
      plan: session.metadata?.plan || 'pro',
      trial: session.subscription?.status === 'trialing',
      trial_end: session.subscription?.trial_end,
    });
  } catch (err) {
    console.error('Verify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── APIFY: Scrape doctor emails ──
// Called when a user wants email data for a physician
app.post('/scrape-emails', async (req, res) => {
  const { specialty, location, limit = 10 } = req.body;

  if (!specialty && !location) {
    return res.status(400).json({ error: 'Provide specialty or location' });
  }

  try {
    // Start Apify actor run
    const runResponse = await fetch(
      `https://api.apify.com/v2/acts/contacts-api~doctors-email-scraper/runs?token=${process.env.APIFY_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          specialty: specialty || 'doctor',
          location: location || 'United States',
          maxResults: Math.min(limit, 20), // cap at 20 per request
        }),
      }
    );

    const runData = await runResponse.json();

    if (!runData.data?.id) {
      throw new Error('Failed to start Apify run');
    }

    const runId = runData.data.id;

    // Poll for results (max 30 seconds)
    let results = [];
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 5000)); // wait 5s

      const statusRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}?token=${process.env.APIFY_API_KEY}`
      );
      const statusData = await statusRes.json();

      if (statusData.data?.status === 'SUCCEEDED') {
        // Get results from dataset
        const datasetRes = await fetch(
          `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${process.env.APIFY_API_KEY}`
        );
        results = await datasetRes.json();
        break;
      }

      if (statusData.data?.status === 'FAILED') {
        throw new Error('Apify run failed');
      }
    }

    res.json({ results, count: results.length });
  } catch (err) {
    console.error('Apify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE: Customer portal (manage billing) ──
app.post('/customer-portal', async (req, res) => {
  const { customer_email } = req.body;

  try {
    // Find customer by email
    const customers = await stripe.customers.list({ email: customer_email, limit: 1 });
    if (!customers.data.length) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customers.data[0].id,
      return_url: `https://bburrell5000.github.io/Med-leads/medleads-auth.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`MedLeads backend running on port ${PORT}`);
});
