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

const allowedOrigins = [
    'https://www.horizonrevenuelmtd.com',
    'https://horizonrevenuelmtd.com',
    'https://horizon-revenue.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000',
];

const corsOptions = {
    origin: (origin, callback) => {
        // Permite requisições sem origin (ex: Postman, curl) e origens autorizadas
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.warn(`[CORS] Origem bloqueada: ${origin}`);
            // Usa false em vez de Error para evitar 500 sem headers CORS no Express 5
            callback(null, false);
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
};

app.use(cors(corsOptions));

// Responde ao preflight OPTIONS em todas as rotas
app.options(/(.*)/, cors(corsOptions));

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
                        unit_amount: process.env.PRICE, // R$ 49,90 = 4990 centavos
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
// Recebe { userMsg, datasetContext, model? } do frontend.
// Monta o prompt de Revenue Management e repassa ao Google Generative AI API.
// Evita erros de CORS e mantém a chave de API segura no servidor.
app.post('/api/gemini/generate', async (req, res) => {
    // Timeout de 25s para não deixar a conexão travada no Render
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    try {
        const { userMsg, datasetContext } = req.body;

        if (!userMsg) {
            clearTimeout(timeoutId);
            return res.status(400).json({ error: 'O campo "userMsg" é obrigatório.' });
        }

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            clearTimeout(timeoutId);
            return res.status(500).json({ error: 'GEMINI_API_KEY não configurada no servidor.' });
        }

        // Limita o contexto a 200 linhas para evitar payloads gigantes que travam o Render
        const contextData = Array.isArray(datasetContext)
            ? datasetContext.slice(0, 200)
            : datasetContext;
        const dataContext = contextData ? JSON.stringify(contextData) : 'Nenhum dado de contexto fornecido.';

        const prompt = `Especialista em Revenue Management Hoteleiro (RevPAR). Dados: ${dataContext}. Pergunta: "${userMsg}". Responda em markdown: título H3, parágrafos curtos, números em **negrito**, bullet points para sugestões. Seja direto e objetivo.`;

        const geminiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }]
            }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('Gemini API error:', errorData);
            return res.status(response.status).json({
                error: 'Erro na API do Gemini',
                details: errorData
            });
        }

        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

        res.status(200).json({ text });
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            console.error('[Gemini] Timeout: requisição demorou mais de 25s');
            return res.status(504).json({ error: 'A IA demorou demais para responder. Tente novamente.' });
        }
        console.error('Erro na rota /api/gemini/generate:', error);
        res.status(500).json({ error: error.message });
    }
});

// Simple health check endpoint
app.get('/health', (req, res) => {
    res.status(200).send('Stripe Backend is running!');
});

// Global error handler — garante que erros 500 ainda enviem headers CORS
// para o browser conseguir ler a resposta de erro
app.use((err, req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    console.error('[Server Error]', err.message);
    res.status(err.status || 500).json({ error: err.message });
});

// Impede que erros não tratados derrubem o servidor inteiro
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException] Servidor não derrubado:', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection] Promessa não tratada:', reason);
});

app.listen(PORT, () => {
    console.log(`Stripe Backend Server running on port ${PORT}`);

    // Evita hibernação no Render (plano gratuito dorme após 15 min sem requests)
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://horizon-back-u0iy.onrender.com';
    if (RENDER_URL) {
        setInterval(() => {
            fetch(`${RENDER_URL}/health`)
                .then(() => console.log('[keep-alive] ping OK'))
                .catch((err) => console.warn('[keep-alive] ping falhou:', err.message));
        }, 14 * 60 * 1000); // a cada 14 minutos
    }
});
