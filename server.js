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
const crypto = require('crypto');
const cron = require('node-cron');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'system-prompt.txt'), 'utf-8');
const PDFS = JSON.parse(fs.readFileSync(path.join(__dirname, 'pdfs.json'), 'utf-8'));
const MENU = JSON.parse(fs.readFileSync(path.join(__dirname, 'menu.json'), 'utf-8'));
const FORMULARIO_CADASTRO = fs.readFileSync(path.join(__dirname, 'formulario-cadastro.txt'), 'utf-8');
const CABANAS = JSON.parse(fs.readFileSync(path.join(__dirname, 'cabanas.json'), 'utf-8')).cabanas;

// ----------------------------------------------------------------------------
// Converte datas em formato brasileiro (ex: "28/07/26", "28/07/2026") para
// o formato ISO "YYYY-MM-DD", usado internamente pro calendário e pro
// lembrete automático de véspera. Se não conseguir interpretar, devolve null.
// ----------------------------------------------------------------------------
function normalizeDateBR(str) {
  if (!str || typeof str !== 'string') return null;
  const match = str.trim().match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (!match) return null;
  let [, dia, mes, ano] = match;
  if (ano.length === 2) ano = `20${ano}`;
  dia = dia.padStart(2, '0');
  mes = mes.padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

function findCabana(nome) {
  if (!nome) return null;
  const alvo = normalize(nome);
  return CABANAS.find((c) => normalize(c.nome) === alvo || alvo.includes(normalize(c.nome)));
}

// Número (com código do país, ex: 5527999999999) da pessoa responsável por
// fechar as reservas — recebe um aviso automático por WhatsApp quando um
// cadastro de hóspede é concluído.
const OWNER_WHATSAPP_NUMBER = process.env.OWNER_WHATSAPP_NUMBER || '';

// Números da equipe autorizados a mandar a mensagem de confirmação de reserva
// (aquela com Pix, parcelas, cabana etc.) para o bot registrar no CRM.
const STAFF_NUMBERS = (process.env.STAFF_NUMBERS || '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

// Pasta onde os registros (cadastros de hóspede + confirmações de reserva)
// ficam salvos. Em Railway, crie um "Volume" apontando pra essa pasta pra não
// perder os dados a cada reinício — veja o README.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const REGISTROS_PATH = path.join(DATA_DIR, 'registros.json');

function loadRegistros() {
  try {
    if (!fs.existsSync(REGISTROS_PATH)) return [];
    return JSON.parse(fs.readFileSync(REGISTROS_PATH, 'utf-8'));
  } catch (err) {
    console.error('Erro lendo registros.json:', err.message);
    return [];
  }
}

function saveRegistro(registro) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const registros = loadRegistros();
    const checkin_iso = normalizeDateBR(registro.dados?.checkin);
    const checkout_iso = normalizeDateBR(registro.dados?.checkout);
    const novo = {
      id: crypto.randomUUID(),
      ...registro,
      checkin_iso,
      checkout_iso,
      lembreteEnviado: false,
      timestamp: new Date().toISOString(),
    };
    registros.push(novo);
    fs.writeFileSync(REGISTROS_PATH, JSON.stringify(registros, null, 2));
    return novo;
  } catch (err) {
    console.error('Erro salvando registro (dados não persistidos):', err.message);
    return null;
  }
}

function updateRegistro(id, novosCampos) {
  const registros = loadRegistros();
  const index = registros.findIndex((r) => r.id === id);
  if (index === -1) return null;

  const atual = registros[index];
  const dadosAtualizados = { ...atual.dados, ...(novosCampos.dados || {}) };
  const atualizado = {
    ...atual,
    ...novosCampos,
    dados: dadosAtualizados,
    checkin_iso: normalizeDateBR(dadosAtualizados.checkin) ?? atual.checkin_iso,
    checkout_iso: normalizeDateBR(dadosAtualizados.checkout) ?? atual.checkout_iso,
  };
  registros[index] = atualizado;
  fs.writeFileSync(REGISTROS_PATH, JSON.stringify(registros, null, 2));
  return atualizado;
}

function deleteRegistro(id) {
  const registros = loadRegistros();
  const restantes = registros.filter((r) => r.id !== id);
  fs.writeFileSync(REGISTROS_PATH, JSON.stringify(restantes, null, 2));
  return restantes.length !== registros.length;
}

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

// ----------------------------------------------------------------------------
// Detecção (por palavra-chave, sem custo de IA) de dois tipos de mensagem:
// 1) O hóspede respondendo o formulário de cadastro.
// 2) A equipe colando a confirmação interna de reserva (Pix, parcelas, cabana).
// Só chamamos a Claude pra extrair os dados quando um desses padrões bate,
// evitando gastar com mensagens comuns.
// ----------------------------------------------------------------------------
function pareceFormularioDeHospede(text) {
  const t = normalize(text);
  return t.includes('nome completo') && (t.includes('cpf') || t.includes('check')) && t.length > 80;
}

function pareceConfirmacaoDeReserva(text) {
  const t = normalize(text);
  const temCabecalho = t.includes('hospedaria vila pinheiro') || t.includes('vila pinheiro cabanas');
  const temDadosFinanceiros = t.includes('pix') || t.includes('forma de pagamento');
  const temCheckin = t.includes('check in') || t.includes('checkin');
  return (temCabecalho || temDadosFinanceiros) && temCheckin;
}

// Chamada única (sem histórico de conversa) pra Claude extrair dados
// estruturados de um texto, devolvendo APENAS JSON.
async function extrairDadosEstruturados(texto, tipo) {
  const instrucoes =
    tipo === 'cadastro'
      ? `Extraia os dados do formulário de cadastro de hóspede abaixo e devolva SOMENTE um JSON (sem markdown, sem texto extra) no formato:
{"hospede1": {"nome": "", "email": "", "cpf": "", "nascimento": "", "endereco": "", "celular": "", "redes_sociais": ""}, "hospede2": null ou o mesmo formato do hospede1, "checkin": "", "checkout": "", "cabana": "", "numero_hospedes": "", "data_comemorativa": "", "como_conheceu": ""}
Se um campo não estiver preenchido, use uma string vazia "".`
      : `Extraia os dados da confirmação de reserva abaixo e devolva SOMENTE um JSON (sem markdown, sem texto extra) no formato:
{"data_reserva": "", "valor_total": "", "forma_pagamento": "", "parcelas": [{"valor": "", "data": ""}], "hospede": "", "checkin": "", "checkout": "", "cabana": ""}
Se um campo não existir na mensagem, use uma string vazia "" ou lista vazia [].`;

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: 'Você é um extrator de dados. Responda APENAS com JSON válido, nada mais.',
      messages: [{ role: 'user', content: `${instrucoes}\n\nTexto:\n${texto}` }],
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    }
  );

  const bruto = response.data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  try {
    const semMarkdown = bruto.replace(/```json|```/g, '').trim();
    return JSON.parse(semMarkdown);
  } catch (err) {
    console.error('Não consegui interpretar o JSON devolvido pela Claude:', bruto);
    return null;
  }
}

// Manda um aviso por WhatsApp pro responsável pelas reservas. Se der erro
// (ex: fora da janela de 24h de conversa), só registra no log, sem travar o bot.
async function notificarResponsavel(texto) {
  if (!OWNER_WHATSAPP_NUMBER) {
    console.warn('OWNER_WHATSAPP_NUMBER não configurado — aviso não enviado, só registrado.');
    return;
  }
  try {
    await sendWhatsAppMessage(OWNER_WHATSAPP_NUMBER, texto);
  } catch (err) {
    console.error('Não consegui notificar o responsável por WhatsApp:', err.response?.data || err.message);
  }
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

    // 0a) Equipe colando a confirmação interna de reserva (Pix, parcelas, cabana)
    if (STAFF_NUMBERS.includes(from) && pareceConfirmacaoDeReserva(text)) {
      if (!IA_ATIVA) {
        await sendWhatsAppMessage(from, 'IA ainda não configurada — não consigo extrair os dados agora.');
        return;
      }
      const dados = await extrairDadosEstruturados(text, 'reserva');
      if (dados) {
        saveRegistro({ tipo: 'reserva', dados, textoOriginal: text });
        await sendWhatsAppMessage(from, `✅ Reserva registrada no sistema!\nHóspede: ${dados.hospede}\nCabana: ${dados.cabana}\nCheck-in: ${dados.checkin} → Check-out: ${dados.checkout}`);
      } else {
        await sendWhatsAppMessage(from, '⚠️ Recebi a mensagem, mas não consegui extrair os dados automaticamente. Registre manualmente.');
      }
      return;
    }

    // 0b) Hóspede respondendo o formulário de cadastro
    if (pareceFormularioDeHospede(text)) {
      if (IA_ATIVA) {
        const dados = await extrairDadosEstruturados(text, 'cadastro');
        if (dados) {
          saveRegistro({ tipo: 'cadastro', dados, textoOriginal: text, telefone: from });
          await notificarResponsavel(
            `📋 Novo cadastro de hóspede recebido!\nHóspede 1: ${dados.hospede1?.nome || '(não informado)'}\nCheck-in: ${dados.checkin} → Check-out: ${dados.checkout}\nCabana: ${dados.cabana}\nTelefone do hóspede: ${from}`
          );
        }
      }
      await sendWhatsAppMessage(from, 'Recebemos seu cadastro! 🙌 Nosso time já foi avisado e vai confirmar sua reserva em breve.');
      return;
    }

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
  if (item.sendForm) await sendWhatsAppMessage(to, FORMULARIO_CADASTRO);
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
function requireAdminKey(req, res, next) {
  const key = req.query.key || req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_KEY) return res.status(403).json({ erro: 'Chave inválida' });
  next();
}

app.get('/admin/escalations', requireAdminKey, (req, res) => {
  res.json(escalations.slice().reverse());
});

// Painel com os cadastros de hóspede e confirmações de reserva já extraídos.
// Acesse: https://seu-servidor.up.railway.app/admin/registros?key=SUA_ADMIN_KEY
app.get('/admin/registros', requireAdminKey, (req, res) => {
  res.json(loadRegistros().slice().reverse());
});

// ============================================================================
// API DO CRM (usada pelo painel web em /crm)
// ============================================================================

// Lista registros, com filtros opcionais: ?tipo=cadastro|reserva&cabana=Jasmim&busca=texto
app.get('/api/registros', requireAdminKey, (req, res) => {
  let registros = loadRegistros();
  const { tipo, cabana, busca } = req.query;

  if (tipo) registros = registros.filter((r) => r.tipo === tipo);
  if (cabana) registros = registros.filter((r) => normalize(r.dados?.cabana || '').includes(normalize(cabana)));
  if (busca) {
    const b = normalize(busca);
    registros = registros.filter((r) => normalize(JSON.stringify(r.dados || {})).includes(b));
  }

  res.json(registros.slice().reverse());
});

// Edita campos de um registro (ex: corrigir uma data ou nome)
app.patch('/api/registros/:id', requireAdminKey, (req, res) => {
  const atualizado = updateRegistro(req.params.id, req.body || {});
  if (!atualizado) return res.status(404).json({ erro: 'Registro não encontrado' });
  res.json(atualizado);
});

// Remove um registro
app.delete('/api/registros/:id', requireAdminKey, (req, res) => {
  const ok = deleteRegistro(req.params.id);
  if (!ok) return res.status(404).json({ erro: 'Registro não encontrado' });
  res.json({ removido: true });
});

// Lista as cabanas configuradas (usado pro filtro e pra agenda de ocupação)
app.get('/api/cabanas', requireAdminKey, (req, res) => {
  res.json(CABANAS.map((c) => c.nome));
});

// Serve o painel web do CRM (arquivo estático em /public/crm.html)
app.get('/crm', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'crm.html'));
});

// Checagem simples de que o servidor está de pé
app.get('/', (req, res) => {
  res.send('Assistente Vila Pinheiro está rodando ✅');
});

// ============================================================================
// LEMBRETE AUTOMÁTICO DE VÉSPERA
// Todo dia, checa quem faz check-in amanhã e manda uma mensagem personalizada
// com recomendações e o código de acesso da cabana.
// ============================================================================
function amanhaISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function enviarLembretesDeVespera() {
  const amanha = amanhaISO();
  const registros = loadRegistros();

  const candidatos = registros.filter(
    (r) => r.tipo === 'cadastro' && r.checkin_iso === amanha && !r.lembreteEnviado && r.telefone
  );

  for (const registro of candidatos) {
    const cabana = findCabana(registro.dados?.cabana);
    const nomeHospede = registro.dados?.hospede1?.nome?.split(' ')[0] || 'tudo bem';

    const mensagem = cabana
      ? `Olá, ${nomeHospede}! 🌿 Estamos ansiosos pra te receber amanhã na Vila Pinheiro, na cabana ${cabana.nome}.\n\n🔑 Código de acesso: ${cabana.codigo_acesso}\n📶 Wifi: ${cabana.senha_wifi}\n\n${cabana.recomendacoes}\n\nQualquer coisa, é só chamar por aqui!`
      : `Olá, ${nomeHospede}! 🌿 Estamos ansiosos pra te receber amanhã na Vila Pinheiro. Qualquer dúvida antes da chegada, é só chamar por aqui!`;

    try {
      await sendWhatsAppMessage(registro.telefone, mensagem);
      updateRegistro(registro.id, { lembreteEnviado: true });
      console.log(`✅ Lembrete de véspera enviado pra ${registro.telefone}`);
    } catch (err) {
      console.error(`Erro enviando lembrete pra ${registro.telefone}:`, err.response?.data || err.message);
    }
  }
}

// Roda todo dia às 10h (horário de Brasília)
cron.schedule('0 10 * * *', enviarLembretesDeVespera, { timezone: 'America/Sao_Paulo' });

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
