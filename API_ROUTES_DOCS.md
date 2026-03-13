# Backend API Documentation

Este documento detalha todas as rotas disponíveis no backend (Stripe, Gemini AI e utilitários). Todas as rotas (exceto `/health`) devem ser acessadas usando o prefixo da sua URL base (ex: `http://localhost:3000`).

---

## 1. Criar Sessão de Checkout (Pagamento)
Cria uma nova sessão de pagamento no Stripe para que o usuário possa assinar o plano Premium. O usuário será redirecionado para esta URL no frontend.

- **Rota:** `/api/stripe/create-checkout-session`
- **Método HTTP:** `POST`
- **Headers:**
  - `Content-Type: application/json`
- **Parâmetros Necessários (Body / JSON):**
  - `userId` (string, obrigatório): O ID único do usuário no Supabase. É fundamental para identificar quem está pagando.
- **Retorno de Sucesso (200 OK):**
  ```json
  {
    "url": "https://checkout.stripe.com/..."
  }
  ```
  *(O frontend deve redirecionar o usuário para esta `url` recebida).*
- **Erros Comuns:**
  - `400 Bad Request`: Se o `userId` não for enviado.
  - `500 Internal Server Error`: Se houver um problema com a chave do Stripe ou comunicação.

---

## 2. Cancelar Assinatura (Downgrade para Trial)
Reverte o status da assinatura do usuário no Supabase de volta para `trial`.

- **Rota:** `/api/stripe/cancel-subscription`
- **Método HTTP:** `POST`
- **Headers:**
  - `Content-Type: application/json`
- **Parâmetros Necessários (Body / JSON):**
  - `userId` (string, obrigatório): O ID único do usuário no Supabase cuja assinatura será cancelada.
- **Retorno de Sucesso (200 OK):**
  ```json
  {
    "message": "Subscription cancelled successfully",
    "status": "trial"
  }
  ```
- **Erros Comuns:**
  - `400 Bad Request`: Se o `userId` não for enviado.
  - `500 Internal Server Error`: Erro ao tentar atualizar o banco de dados Supabase.

---

## 3. Webhook do Stripe (Automático)
Esta rota **NÃO** deve ser chamada manualmente pelo seu frontend. Ela é chamada automaticamente pelos servidores do Stripe quando um pagamento é concluído com sucesso. Ela atualiza o status do usuário para `premium`.

- **Rota:** `/api/stripe/webhook`
- **Método HTTP:** `POST`
- **Regras:**
  - Requer o header `stripe-signature` gerado pelo próprio Stripe.
  - Atualiza a coluna `subscription_status` para `'premium'` na tabela `users` do Supabase baseado no `userId` enviado na criação da sessão de checkout.
- **Erros Comuns (Visíveis apenas nos logs do backend/Stripe):**
  - `400 Bad Request`: Falha na verificação da assinatura do Webhook.

---

## 4. Gemini AI — Gerar Análise de Revenue Management ⭐ ATUALIZADO

Proxy server-side para a Google Generative AI. O frontend envia apenas a mensagem do usuário e os dados do dataset; o **backend monta o prompt completo** e retorna o texto gerado. A `GEMINI_API_KEY` fica segura no servidor — **não é necessária nenhuma chave de API no frontend**.

- **Rota:** `/api/gemini/generate`
- **Método HTTP:** `POST`
- **Headers:**
  - `Content-Type: application/json`
- **Parâmetros (Body / JSON):**

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `userMsg` | string | ✅ sim | A pergunta/mensagem digitada pelo usuário no chat |
| `datasetContext` | array/object | ❌ não | O dataset de preços (usuário + concorrentes) |
| `model` | string | ❌ não | Modelo Gemini a usar. Default: `gemini-2.5-flash` |

- **Exemplo de Body:**
  ```json
  {
    "userMsg": "Qual a melhor estratégia para o fim de semana?",
    "datasetContext": [
      { "data": "2026-03-14", "meu_preco": 350, "concorrente_a": 320, "concorrente_b": 380 }
    ]
  }
  ```

- **Retorno de Sucesso (200 OK):**
  ```json
  {
    "text": "### Análise de Precificação — Fim de Semana\n---\nO seu preço de **R$ 350**..."
  }
  ```
  > O campo `text` é **Markdown puro**. Passe por `marked.parse(data.text)` antes de exibir no HTML.

- **Como chamar no frontend** (substitui todo o bloco `GoogleGenerativeAI`):
  ```js
  const backendUrl = import.meta.env.VITE_STRIPE_BACKEND_URL || 'http://localhost:3000'

  const response = await fetch(`${backendUrl}/api/gemini/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userMsg,
      datasetContext: props.datasetContext
    })
  })

  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Erro na IA')

  const formattedHtmlText = marked.parse(data.text)
  messages.value.push({ role: 'ai', content: formattedHtmlText })
  ```

- **O que remover do frontend após a migração:**
  - `import { GoogleGenerativeAI } from '@google/generative-ai'`
  - `const apiKey = import.meta.env.VITE_GEMINI_API_KEY` e toda a validação da chave
  - Todo o bloco de montagem do `prompt` e chamada ao SDK
  - A variável `VITE_GEMINI_API_KEY` do `.env` do frontend (não é mais necessária)

- **Erros Comuns:**
  - `400 Bad Request`: O campo `userMsg` não foi enviado.
  - `500 Internal Server Error`: `GEMINI_API_KEY` não configurada no servidor ou falha de rede.

---

## 5. Health Check (Verificação de Status)
Uma rota simples de utilidade para garantir que o servidor backend está rodando e respondendo corretamente.

- **Rota:** `/health`
- **Método HTTP:** `GET`
- **Parâmetros:** Nenhum.
- **Retorno de Sucesso (200 OK):** Retorna o texto simples `"Stripe Backend is running!"`.
