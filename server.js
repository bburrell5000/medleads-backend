require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: [
    'https://bburrell5000.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:5500'
  ]
}));

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'MedLeads backend running ✅' });
});

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
      success_url: `https://bburrell5000.github.io/Med-leads/medleads-auth.html?session_id={CHECKOUT_SESSION_ID}&status=success`,
      cancel_url: `https://bburrell5000.github.io/Med-leads/medleads-auth.html?status=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/verify-session', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'No session ID' });
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription', 'customer'],
    });
    const isActive = session.payment_status === 'paid' || session.subscription?.status === 'trialing' || session.subscription?.status === 'active';
    res.json({ active: isActive, email: session.customer_details?.email, plan: session.metadata?.plan || 'pro' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/scrape-emails', async (req, res) => {
  const { specialty, location, limit = 20 } = req.body;
  if (!specialty && !location) return res.status(400).json({ error: 'Provide specialty or location' });
  try {
    const runResponse = await fetch(
      `https://api.apify.com/v2/acts/contacts-api~doctors-email-scraper/runs?token=${process.env.APIFY_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          googleMapsSearchTerm: specialty || 'Doctors',
          googleMapsLocation: [location || 'United States'],
          maxBusinesses: Math.min(parseInt(limit), 20),
          scrapeMaxBusinessesPerLocation: false,
          proxyConfiguration: { useApifyProxy: true }
        }),
      }
    );
    const runData = await runResponse.json();
    if (!runData.data?.id) throw new Error('Failed to start Apify run');
    const runId = runData.data.id;
    let results = [];
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
    res.json({ results: formatted, count: formatted.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
