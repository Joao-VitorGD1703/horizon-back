# Stripe Integration API Documentation

Este documento detalha as rotas disponíveis no backend para integração com os pagamentos do Stripe e Supabase. Todas as rotas (exceto `/health`) devem ser acessadas usando o prefixo da sua URL base (ex: `http://localhost:3000`).

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
  - Atualiza a coluna `subscription_status` para `'premium'` na tabela `users` do seu Supabase baseado no `userId` que foi enviado durante a criação da sessão de checkout.
- **Erros Comuns (Visíveis apenas nos logs do backend/Stripe):**
  - `400 Bad Request`: Falha na verificação da assinatura do Webhook.

---

## 4. Health Check (Verificação de Status)
Uma rota simples de utilidade para garantir que o seu servidor backend está rodando e respondendo corretamente.

- **Rota:** `/health`
- **Método HTTP:** `GET`
- **Parâmetros:** Nenhum.
- **Retorno de Sucesso (200 OK):** Retorna o texto simples `"Stripe Backend is running!"`.
