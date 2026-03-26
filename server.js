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
                // Calculate grace period end: 30 days from now
                const subscriptionEndsAt = new Date();
                subscriptionEndsAt.setDate(subscriptionEndsAt.getDate() + 30);

                const { error } = await supabase
                    .from('users')
                    .update({
                        subscription_status: 'premium',
                        subscription_ends_at: subscriptionEndsAt.toISOString(),
                        cancel_at_period_end: false
                    })
                    .eq('id', userId);

                if (error) {
                    console.error('Error updating user in Supabase:', error);
                } else {
                    console.log(`Payment successful for user ${userId}. Premium active until ${subscriptionEndsAt.toISOString()}.`);
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

// Endpoint to schedule subscription cancellation at period end.
// The user keeps Premium access until subscription_ends_at, then loses it.
app.post('/api/stripe/cancel-subscription', async (req, res) => {
    try {
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }

        // Fetch current subscription_ends_at so we can return it to the frontend
        const { data: userData, error: fetchError } = await supabase
            .from('users')
            .select('subscription_ends_at')
            .eq('id', userId)
            .single();

        if (fetchError) {
            console.error('Error fetching user in Supabase:', fetchError);
            return res.status(500).json({ error: 'Failed to fetch subscription data' });
        }

        // Mark cancellation scheduled — do NOT revert status yet; access remains until subscription_ends_at
        const { error } = await supabase
            .from('users')
            .update({ cancel_at_period_end: true })
            .eq('id', userId);

        if (error) {
            console.error('Error updating user in Supabase:', error);
            return res.status(500).json({ error: 'Failed to cancel subscription' });
        }

        const endsAt = userData?.subscription_ends_at || null;
        console.log(`Cancellation scheduled for user ${userId}. Access remains until ${endsAt}.`);
        res.status(200).json({
            message: 'Cancellation scheduled. Access remains until period end.',
            cancel_at_period_end: true,
            subscription_ends_at: endsAt
        });
    } catch (error) {
        console.error('Error creating cancel request:', error);
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
