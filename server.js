require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase with service role key for admin privileges inside webhook
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Webhook endpoint MUST use raw body for Stripe signature verification
// It must be defined before express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const signature = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            signature,
            endpointSecret
        );
    } catch (err) {
        console.error(`⚠️  Webhook signature verification failed.`, err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the checkout.session.completed event
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;

        // Retrieve the userId from metadata
        const userId = session.metadata.userId;

        if (userId) {
            try {
                // Update user in Supabase
                // Using subscription_status to allow access to AI features
                // or pagou_stripe if you prefer. Setting subscription_status to 'premium'
                const { data, error } = await supabase
                    .from('users') // Adjust if your table name is 'usuarios'
                    .update({ subscription_status: 'premium' })
                    .eq('id', userId);

                if (error) {
                    console.error('Error updating user in Supabase:', error);
                } else {
                    console.log(`Payment successful for user ${userId}. Updated subscription_status to 'premium'.`);
                }
            } catch (updateError) {
                console.error('Supabase update exception:', updateError);
            }
        }
    }

    // Return a 200 response to acknowledge receipt of the event
    res.status(200).send();
});

// Middleware for parsing JSON for the rest of the endpoints
app.use(express.json());

app.post('/api/stripe/create-checkout-session', async (req, res) => {
    try {
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment', // using onetime payment
            line_items: [
                {
                    price_data: {
                        currency: 'brl',
                        product_data: {
                            name: 'Assinatura Premium Horizon AI',
                            description: 'Acesso vitalício ou mensal às análises inteligentes de Revenue Management.',
                        },
                        unit_amount: 100, // R$ 49,90 = 4990 centavos
                    },
                    quantity: 1,
                },
            ],
            // Adding userId to metadata to retrieve it in the webhook
            metadata: {
                userId: userId
            },
            success_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/success`,
            cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/dashboard`,
        });

        res.status(200).json({ url: session.url });
    } catch (error) {
        console.error('Error creating checkout session:', error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint to cancel the subscription and revert to trial
app.post('/api/stripe/cancel-subscription', async (req, res) => {
    try {
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }

        const { data, error } = await supabase
            .from('users') // Adjust if your table name is 'usuarios'
            .update({ subscription_status: 'trial' })
            .eq('id', userId);

        if (error) {
            console.error('Error updating user in Supabase:', error);
            return res.status(500).json({ error: 'Failed to cancel subscription' });
        }

        console.log(`Subscription cancelled for user ${userId}. Reverted to 'trial'.`);
        res.status(200).json({ message: 'Subscription cancelled successfully', status: 'trial' });
    } catch (error) {
        console.error('Error creating cancel request:', error);
        res.status(500).json({ error: error.message });
    }
});

// ─── Gemini AI Proxy ─────────────────────────────────────────────────────────
// Recebe { prompt, model? } do frontend e repassa ao Google Generative AI API.
// Evita erros de CORS pois a chamada é feita server-side.
app.post('/api/gemini/generate', async (req, res) => {
    try {
        const { prompt, model = 'gemini-2.5-flash' } = req.body;

        if (!prompt) {
            return res.status(400).json({ error: 'O campo "prompt" é obrigatório.' });
        }

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'GEMINI_API_KEY não configurada no servidor.' });
        }

        const geminiUrl = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`;

        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }]
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('Gemini API error:', errorData);
            return res.status(response.status).json({
                error: 'Erro na API do Gemini',
                details: errorData
            });
        }

        const data = await response.json();

        // Extrai o texto gerado de forma segura
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

        res.status(200).json({ text, raw: data });
    } catch (error) {
        console.error('Erro na rota /api/gemini/generate:', error);
        res.status(500).json({ error: error.message });
    }
});

// Simple health check endpoint
app.get('/health', (req, res) => {
    res.status(200).send('Stripe Backend is running!');
});

app.listen(PORT, () => {
    console.log(`Stripe Backend Server running on port ${PORT}`);
});
