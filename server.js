// ============================================================================
// Assistente de IA - Vila Pinheiro Cabanas
// Recebe mensagens de WhatsApp e Instagram, responde usando a API da Claude,
// e avisa quando um cliente quer fechar reserva (para o humano assumir).
// ============================================================================

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'system-prompt.txt'), 'utf-8');
const PDFS = JSON.parse(fs.readFileSync(path.join(__dirname, 'pdfs.json'), 'utf-8'));
const MENU = JSON.parse(fs.readFileSync(path.join(__dirname, 'menu.json'), 'utf-8'));

// ----------------------------------------------------------------------------
// Tenta encontrar um item do menu que combine com o texto do cliente,
// comparando com a lista de "aliases" (palavras-chave) de cada item.
// Isso permite responder SEM gastar com a API da Claude.
// ----------------------------------------------------------------------------
function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // remove acentos
}

function matchMenuItem(text) {
  const normalized = normalize(text);
  return MENU.items.find((item) =>
    item.aliases.some((alias) => normalized.includes(normalize(alias)))
  );
}

function findMenuItemById(id) {
  return MENU.items.find((item) => item.id === id);
}

// ----------------------------------------------------------------------------
// Converte um link de compartilhamento do Google Drive
// (ex: https://drive.google.com/file/d/ABC123/view?usp=sharing)
// em um link de download direto, que o WhatsApp/Instagram conseguem baixar.
// Se o link já não for do formato "view", devolve ele sem alteração.
// ----------------------------------------------------------------------------
function toDirectDriveLink(driveUrl) {
  const match = driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) return driveUrl; // já deve ser um link direto ou de outro serviço
  const fileId = match[1];
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

// Extrai as tags [ENVIAR_PDF:apelido] do texto, removendo-as da mensagem
// e devolvendo a lista de apelidos encontrados.
function extractPdfTags(text) {
  const apelidos = [];
  const cleaned = text.replace(/\[ENVIAR_PDF:([a-zA-Z0-9_-]+)\]/g, (_, apelido) => {
    apelidos.push(apelido);
    return '';
  }).trim();
  return { cleaned, apelidos };
}

// ----------------------------------------------------------------------------
// "Memória" das conversas (simples, em memória do servidor).
// Cada cliente (identificado pelo número de telefone ou ID do Instagram) tem
// um histórico curto de mensagens, para a Claude lembrar o contexto da conversa.
// OBS: essa memória se perde se o servidor reiniciar. Para um negócio pequeno
// isso costuma ser suficiente; se crescer, dá pra trocar por um banco de dados.
// ----------------------------------------------------------------------------
const conversations = new Map(); // chave: "whatsapp:5527..." ou "instagram:123..."
const MAX_HISTORY_MESSAGES = 16;
const CONVERSATION_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas de inatividade = esquece

function getHistory(key) {
  const convo = conversations.get(key);
  if (!convo) return [];
  if (Date.now() - convo.lastActive > CONVERSATION_TTL_MS) {
    conversations.delete(key);
    return [];
  }
  return convo.messages;
}

function pushHistory(key, role, content) {
  const messages = getHistory(key);
  messages.push({ role, content });
  while (messages.length > MAX_HISTORY_MESSAGES) messages.shift();
  conversations.set(key, { messages, lastActive: Date.now() });
}

// Lista simples de avisos de "cliente quer reservar" para você conferir depois.
const escalations = [];

// ----------------------------------------------------------------------------
// Chamada para a API da Claude
// ----------------------------------------------------------------------------
async function askClaude(key, userText) {
  pushHistory(key, 'user', userText);
  const history = getHistory(key);

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: history,
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    }
  );

  let reply = response.data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  let escalate = false;
  if (reply.includes('[ESCALAR]')) {
    escalate = true;
    reply = reply.replace('[ESCALAR]', '').trim();
  }

  const { cleaned, apelidos } = extractPdfTags(reply);
  reply = cleaned;

  pushHistory(key, 'assistant', reply);
  return { reply, escalate, pdfApelidos: apelidos };
}

function logEscalation(channel, from, message) {
  const entry = { channel, from, message, timestamp: new Date().toISOString() };
  escalations.push(entry);
  console.log('🔔 ESCALONAMENTO (cliente quer reservar/fechar):', entry);
}

// Enquanto ANTHROPIC_API_KEY não estiver configurada, o bot funciona só com o
// menu fixo. Perguntas fora do roteiro recebem essa resposta padrão em vez de
// travar — útil pra testar a parte de WhatsApp/Instagram antes de ligar a IA.
const IA_ATIVA = Boolean(process.env.ANTHROPIC_API_KEY);
const RESPOSTA_SEM_IA =
  'Recebi sua mensagem! No momento nosso assistente automático só responde as opções do menu — em breve nosso time te retorna com essa resposta. 🙂';

// ============================================================================
// WHATSAPP
// ============================================================================

// Verificação do webhook (a Meta chama isso uma vez, ao configurar)
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  console.log('🔍 Verificação de webhook recebida:', { mode, token });

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Recebimento de mensagens novas do WhatsApp
app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200); // responde rápido pra Meta não reenviar o mesmo evento
  console.log('📩 Webhook do WhatsApp recebido:', JSON.stringify(req.body));

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    if (!message) return;

    const from = message.from; // número do cliente
    const key = `whatsapp:${from}`;

    // Cliente clicou numa opção do menu (lista interativa) — resposta pronta, sem IA.
    if (message.type === 'interactive' && message.interactive?.list_reply) {
      const item = findMenuItemById(message.interactive.list_reply.id);
      if (item) await handleWhatsAppMenuItem(from, item);
      return;
    }

    if (message.type !== 'text') return;
    const text = message.text.body;

    // 1) Tenta responder por palavra-chave (grátis, sem chamar a Claude)
    const matched = matchMenuItem(text);
    if (matched) {
      await handleWhatsAppMenuItem(from, matched);
      return;
    }

    // 2) Primeiro contato desse cliente: manda o menu de opções em vez de já chamar a IA
    if (getHistory(key).length === 0) {
      await sendWhatsAppMessage(from, MENU.welcome_text);
      await sendWhatsAppInteractiveList(from);
      return;
    }

    // 3) Fora do roteiro fixo: só agora chama a Claude (é o único caso que gera custo de IA)
    if (!IA_ATIVA) {
      await sendWhatsAppMessage(from, RESPOSTA_SEM_IA);
      logEscalation('whatsapp', from, `[sem IA configurada] ${text}`);
      return;
    }
    const { reply, escalate, pdfApelidos } = await askClaude(key, text);
    await sendWhatsAppMessage(from, reply);
    for (const apelido of pdfApelidos) {
      await sendWhatsAppDocument(from, apelido);
    }
    if (escalate) logEscalation('whatsapp', from, text);
  } catch (err) {
    console.error('Erro processando mensagem do WhatsApp:', err.response?.data || err.message);
  }
});

// Envia a resposta pronta de um item do menu (texto + PDF, se houver) e
// registra escalonamento se for o caso — tudo sem gastar com a API da Claude.
async function handleWhatsAppMenuItem(to, item) {
  await sendWhatsAppMessage(to, item.response);
  if (item.pdf) await sendWhatsAppDocument(to, item.pdf);
  if (item.escalate) logEscalation('whatsapp', to, `[menu] ${item.title}`);
}

// Manda o menu como uma lista interativa (botão "Ver opções" que abre a lista)
async function sendWhatsAppInteractiveList(to) {
  await axios.post(
    `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: 'Escolha uma opção:' },
        action: {
          button: 'Ver opções',
          sections: [
            {
              title: 'Vila Pinheiro Cabanas',
              rows: MENU.items.map((item) => ({ id: item.id, title: item.title.slice(0, 24) })),
            },
          ],
        },
      },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'content-type': 'application/json',
      },
    }
  );
}

async function sendWhatsAppMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'content-type': 'application/json',
      },
    }
  );
}

async function sendWhatsAppDocument(to, apelido) {
  const driveLink = PDFS[apelido];
  if (!driveLink) {
    console.warn(`Aviso: apelido de PDF "${apelido}" não encontrado em pdfs.json`);
    return;
  }
  const directLink = toDirectDriveLink(driveLink);
  await axios.post(
    `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'document',
      document: {
        link: directLink,
        filename: `${apelido}.pdf`,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'content-type': 'application/json',
      },
    }
  );
}

// ============================================================================
// INSTAGRAM (mensagens diretas)
// ============================================================================

app.get('/webhook/instagram', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post('/webhook/instagram', async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const messaging = entry?.messaging?.[0];
    const text = messaging?.message?.text;
    const senderId = messaging?.sender?.id;
    if (!text || !senderId) return;

    const key = `instagram:${senderId}`;

    // 1) Tenta responder por palavra-chave (grátis, sem chamar a Claude)
    const matched = matchMenuItem(text);
    if (matched) {
      await handleInstagramMenuItem(senderId, matched);
      return;
    }

    // 2) Primeiro contato: manda o menu como texto numerado em vez de chamar a IA direto
    if (getHistory(key).length === 0) {
      await sendInstagramMessage(senderId, buildTextMenu());
      return;
    }

    // 3) Fora do roteiro fixo: só agora chama a Claude
    if (!IA_ATIVA) {
      await sendInstagramMessage(senderId, RESPOSTA_SEM_IA);
      logEscalation('instagram', senderId, `[sem IA configurada] ${text}`);
      return;
    }
    const { reply, escalate, pdfApelidos } = await askClaude(key, text);
    await sendInstagramMessage(senderId, reply);
    for (const apelido of pdfApelidos) {
      await sendInstagramDocument(senderId, apelido);
    }
    if (escalate) logEscalation('instagram', senderId, text);
  } catch (err) {
    console.error('Erro processando mensagem do Instagram:', err.response?.data || err.message);
  }
});

async function sendInstagramMessage(recipientId, text) {
  await axios.post(
    `https://graph.facebook.com/v20.0/me/messages`,
    {
      recipient: { id: recipientId },
      message: { text },
    },
    {
      params: { access_token: process.env.INSTAGRAM_PAGE_TOKEN },
      headers: { 'content-type': 'application/json' },
    }
  );
}

// Monta o menu como texto simples (o Instagram Direct não tem uma lista
// interativa tão simples quanto o WhatsApp, então usamos texto numerado).
function buildTextMenu() {
  const linhas = MENU.items.map((item, i) => `${i + 1}. ${item.title}`);
  return `${MENU.welcome_text}\n\n${linhas.join('\n')}\n\nÉ só digitar o assunto que você quer saber.`;
}

async function handleInstagramMenuItem(recipientId, item) {
  await sendInstagramMessage(recipientId, item.response);
  if (item.pdf) await sendInstagramDocument(recipientId, item.pdf);
  if (item.escalate) logEscalation('instagram', recipientId, `[menu] ${item.title}`);
}

async function sendInstagramDocument(recipientId, apelido) {
  const driveLink = PDFS[apelido];
  if (!driveLink) {
    console.warn(`Aviso: apelido de PDF "${apelido}" não encontrado em pdfs.json`);
    return;
  }
  const directLink = toDirectDriveLink(driveLink);
  await axios.post(
    `https://graph.facebook.com/v20.0/me/messages`,
    {
      recipient: { id: recipientId },
      message: {
        attachment: {
          type: 'file',
          payload: { url: directLink, is_reusable: true },
        },
      },
    },
    {
      params: { access_token: process.env.INSTAGRAM_PAGE_TOKEN },
      headers: { 'content-type': 'application/json' },
    }
  );
}

// ============================================================================
// PAINEL SIMPLES: ver os avisos de "cliente quer reservar"
// Acesse: https://seu-servidor.up.railway.app/admin/escalations?key=SUA_ADMIN_KEY
// ============================================================================
app.get('/admin/escalations', (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) return res.sendStatus(403);
  res.json(escalations.slice().reverse());
});

// Checagem simples de que o servidor está de pé
app.get('/', (req, res) => {
  res.send('Assistente Vila Pinheiro está rodando ✅');
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
