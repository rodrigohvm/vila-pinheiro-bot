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
const FormData = require('form-data');
const { extrairSemIA } = require('./extrator');
const {
  ensureParcelaDefaults,
  enrichRegistro,
  buildDashboard,
  buildEstadias,
  buildClientes,
  buildICSFeed,
  detectarConflitos,
  conflitosDeUmaEstadia,
  listarParcelasParaLembrar,
  montarMensagemCobranca,
} = require('./financeiro');
const { fazerBackup, fazerBackupConfig, backupConfigurado } = require('./backup');
const config = require('./config');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'system-prompt.txt'), 'utf-8');

// Configuração editável pelo painel (/painel). Deixam de ser constantes de boot:
// viram funções, lidas do volume a cada uso (com cache invalidado por mtime),
// pra que uma edição no painel valha na hora, sem redeploy.
const MENU = () => config.menu();
const PDFS = () => config.pdfs();
const CABANAS = () => config.cabanas();
const FORMULARIO_CADASTRO = () => config.formularioCadastro();

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
  return CABANAS().find((c) => normalize(c.nome) === alvo || alvo.includes(normalize(c.nome)));
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
    if (registro.tipo === 'reserva') ensureParcelaDefaults(registro.dados);
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
  if (atual.tipo === 'reserva') ensureParcelaDefaults(dadosAtualizados);

  const novoCheckinIso = normalizeDateBR(dadosAtualizados.checkin) ?? atual.checkin_iso;
  const checkinMudou = novoCheckinIso !== atual.checkin_iso;

  const atualizado = {
    ...atual,
    ...novosCampos,
    dados: dadosAtualizados,
    checkin_iso: novoCheckinIso,
    checkout_iso: normalizeDateBR(dadosAtualizados.checkout) ?? atual.checkout_iso,
    // Se a data de check-in mudou (remarcação), reseta o lembrete de véspera
    // pra ele disparar de novo na data nova — senão quem já tinha recebido o
    // lembrete pra data antiga nunca mais receberia nada pra data remarcada.
    lembreteEnviado: checkinMudou ? false : (novosCampos.lembreteEnviado ?? atual.lembreteEnviado),
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

// Depois de salvar um cadastro/reserva, checa se a cabana já está ocupada
// nesse período por OUTRO hóspede e avisa a equipe no WhatsApp. Nunca bloqueia
// o registro — o dado entra, e um humano decide o que fazer.
async function alertarConflitoDeReserva(novo) {
  try {
    const outros = loadRegistros().filter((r) => r.id !== novo.id);
    const conflitos = conflitosDeUmaEstadia(novo, outros);
    if (!conflitos.length) return [];

    const nomeNovo = novo.tipo === 'cadastro' ? novo.dados?.hospede1?.nome : novo.dados?.hospede;
    const overbooking = conflitos.filter((c) => c.motivo === 'overbooking');
    const divergencias = conflitos.filter((c) => c.motivo === 'divergencia');

    const linhas = [
      overbooking.length ? '🔴 *Overbooking: a cabana já está ocupada nesse período*' : '🟠 *Datas divergentes no mesmo hóspede*',
      '',
      `Acabou de entrar: *${nomeNovo || '(sem nome)'}* — ${novo.dados?.cabana}`,
      `${novo.dados?.checkin} → ${novo.dados?.checkout}`,
    ];

    if (overbooking.length) {
      linhas.push('', 'Já existe nessa cabana, com datas que se sobrepõem:', ...overbooking.map((c) => `• ${c.hospede} — ${c.checkin} → ${c.checkout}`));
    }
    if (divergencias.length) {
      linhas.push(
        '',
        'Mesmo hóspede com datas que não batem (provável erro de digitação):',
        ...divergencias.map((c) => `• ${c.hospede} — ${c.checkin} → ${c.checkout}`)
      );
    }
    linhas.push('', 'Confira no CRM antes de confirmar com o hóspede.');
    await notificarEquipe(linhas.join('\n'));
    return conflitos;
  } catch (err) {
    console.error('Erro checando conflito de reserva:', err.message);
    return [];
  }
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
  return MENU().items.find((item) =>
    item.aliases.some((alias) => normalized.includes(normalize(alias)))
  );
}

function findMenuItemById(id) {
  return MENU().items.find((item) => item.id === id);
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

// Envia, em sequência, todos os PDFs listados em menu.json > pdfs_boas_vindas.
// `enviarDocumento` é a função de envio específica do canal (WhatsApp ou
// Instagram), assim essa lógica não se repete em cada canal.
async function enviarPdfsBoasVindas(to, enviarDocumento) {
  // Em paralelo (não um de cada vez) — cada PDF agora envolve baixar do Drive
  // e reenviar pro WhatsApp, então em sequência isso ficava lento demais.
  // A ordem entre os PDFs deixa de ser garantida, só a posição deles em
  // relação ao menu (que continua vindo por último, com o delay).
  await Promise.all((MENU().pdfs_boas_vindas || []).map((apelido) => enviarDocumento(to, apelido)));
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
const conversations = new Map(); // chave: "whatsapp:5527..." ou "instagram:123..." — histórico só p/ chat da IA
const MAX_HISTORY_MESSAGES = 16;
const CONVERSATION_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas de inatividade = esquece

// Rastreia quem já recebeu a mensagem de boas-vindas + PDFs, INDEPENDENTE da IA.
// Antes isso usava o tamanho do histórico de chat (getHistory), mas esse
// histórico só é preenchido dentro de askClaude() — ou seja, com o chat da IA
// desligado (IA_CHAT_ATIVA=false), ele nunca é preenchido, e TODA mensagem de
// qualquer contato (mesmo o 2º, 3º, 10º contato) era tratada como "primeiro
// contato", reenviando boas-vindas + 6 PDFs em vez de seguir o fluxo certo.
const contatosBoasVindasEnviadas = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

// Registra o escalonamento E manda uma notificação de verdade pro WhatsApp da
// proprietária (OWNER_WHATSAPP_NUMBER). Usado tanto quando o cliente manda algo
// fora do roteiro quanto quando clica em "Falar com a equipe".
async function encaminharParaEquipe(channel, from, motivo) {
  logEscalation(channel, from, motivo);
  await notificarResponsavel(
    `📣 Um cliente precisa de atendimento humano!\nCanal: ${channel}\nContato: ${from}\nMotivo: ${motivo}`
  );
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

  // Sinal 1: hóspede reenviou o modelo do formulário com os rótulos (como antes).
  const temRotulos = t.includes('nome completo') && (t.includes('cpf') || t.includes('check'));

  // Sinal 2: hóspede só respondeu com os dados soltos, sem repetir os rótulos
  // do formulário — bem mais comum na prática. Em vez de procurar a palavra
  // "nome completo", procuramos o FORMATO dos dados: um CPF (11 dígitos,
  // formatado ou não) junto com pelo menos uma data (dd/mm ou dd/mm/aa).
  // Essa combinação é um indício forte de cadastro mesmo sem rótulo nenhum.
  const temCPF = /\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/.test(text) || /\b\d{11}\b/.test(text.replace(/[^\d]/g, ' '));
  const temData = /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/.test(text);
  const pareceDadosSoltos = temCPF && temData;

  // Limite de tamanho bem mais baixo que antes (era 80) — o sinal 2 já é
  // específico o suficiente (CPF + data juntos são raros em conversa comum),
  // então não precisamos de um texto longo pra confiar nele.
  return (temRotulos || pareceDadosSoltos) && t.length > 30;
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
  // 1ª tentativa: extração por regras (sem IA). Como o formulário e o modelo de
  // confirmação são padronizados pela pousada, isso resolve a grande maioria
  // dos casos de graça e na hora, sem depender de crédito na Anthropic.
  const porRegras = extrairSemIA(texto, tipo);
  if (porRegras) {
    console.log(`✅ Extração por regras (sem IA) bem-sucedida [${tipo}]`);
    return porRegras;
  }

  // 2ª tentativa: se as regras não deram conta (texto muito fora do padrão) e
  // a IA estiver configurada, usa a Claude como reforço.
  if (!IA_ATIVA) {
    console.warn(`⚠️ Não consegui extrair por regras [${tipo}] e a IA não está configurada.`);
    return null;
  }
  console.log(`↪️ Regras não deram conta [${tipo}], tentando com a IA...`);

  const instrucoes =
    tipo === 'cadastro'
      ? `Extraia os dados do formulário de cadastro de hóspede abaixo e devolva SOMENTE um JSON (sem markdown, sem texto extra) no formato:
{"hospede1": {"nome": "", "email": "", "cpf": "", "nascimento": "", "endereco": "", "celular": "", "redes_sociais": ""}, "hospede2": null ou o mesmo formato do hospede1, "checkin": "", "checkout": "", "cabana": "", "numero_hospedes": "", "data_comemorativa": "", "como_conheceu": ""}
Se um campo não estiver preenchido, use uma string vazia "".`
      : `Extraia os dados da confirmação de reserva abaixo e devolva SOMENTE um JSON (sem markdown, sem texto extra) no formato:
{"data_reserva": "", "valor_total": "", "forma_pagamento": "", "parcelas": [{"valor": "", "data": "", "paga": false}], "hospede": "", "checkin": "", "checkout": "", "cabana": "", "numero_diarias": "", "canal_venda": "", "adicionais": ""}
"canal_venda" é de onde veio a venda (ex: Instagram, Airbnb, indicação, Google). "adicionais" são ocasiões especiais ou extras contratados (ex: aniversário, lua de mel, decoração).
Se um campo não existir na mensagem, use uma string vazia "" ou lista vazia []. Toda parcela extraída da mensagem começa com "paga": false — o pagamento é confirmado depois, manualmente, pela equipe.`;

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

// Manda o mesmo aviso pra todos os números da equipe (STAFF_NUMBERS) e pra
// proprietária, sem repetir se o número aparecer nos dois lugares.
async function notificarEquipe(texto) {
  const destinatarios = [...new Set([...STAFF_NUMBERS, OWNER_WHATSAPP_NUMBER].filter(Boolean))];
  if (!destinatarios.length) {
    console.warn('Nenhum número de equipe configurado — aviso só registrado no log.');
    console.log(texto);
    return;
  }
  await Promise.all(
    destinatarios.map((numero) =>
      sendWhatsAppMessage(numero, texto).catch((err) =>
        console.error(`Não consegui avisar ${numero}:`, err.response?.data || err.message)
      )
    )
  );
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

// IA_ATIVA controla a EXTRAÇÃO estruturada (cadastro de hóspede, confirmação
// de reserva) — isso é o que alimenta o CRM e o lembrete de véspera. Fica
// ligada sempre que ANTHROPIC_API_KEY existir, independente do chat.
const IA_ATIVA = Boolean(process.env.ANTHROPIC_API_KEY);

// IA_CHAT_ATIVA controla se a Claude PODE conversar livremente com o cliente
// (perguntas fora do menu fixo). É uma flag separada e opt-in: só liga se
// ANTHROPIC_API_KEY existir E a variável IA_RESPONDE_CLIENTES estiver "true".
// Assim dá pra manter a IA ligada só pra extração (CRM/lembretes) sem que ela
// converse com hóspede nenhum — troque IA_RESPONDE_CLIENTES=true quando
// quiser habilitar o chat.
const IA_CHAT_ATIVA = IA_ATIVA && String(process.env.IA_RESPONDE_CLIENTES).toLowerCase() === 'true';

const MENSAGEM_ENCAMINHAMENTO =
  'Para te ajudar com essa questão, vou te direcionar para a equipe da Vila Pinheiro. Em breve alguém do nosso time responde por aqui! 😊';

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
      const dados = await extrairDadosEstruturados(text, 'reserva');
      if (dados) {
        const salvo = saveRegistro({ tipo: 'reserva', dados, textoOriginal: text });
        await sendWhatsAppMessage(from, `✅ Reserva registrada no sistema!\nHóspede: ${dados.hospede}\nCabana: ${dados.cabana}\nCheck-in: ${dados.checkin} → Check-out: ${dados.checkout}`);
        if (salvo) await alertarConflitoDeReserva(salvo);
      } else {
        await sendWhatsAppMessage(from, '⚠️ Recebi a mensagem, mas não consegui extrair os dados automaticamente. Registre manualmente pelo CRM.');
      }
      return;
    }

    // 0b) Hóspede respondendo o formulário de cadastro
    if (pareceFormularioDeHospede(text)) {
      const dados = await extrairDadosEstruturados(text, 'cadastro');
      if (dados) {
        const salvo = saveRegistro({ tipo: 'cadastro', dados, textoOriginal: text, telefone: from });
        if (salvo) await alertarConflitoDeReserva(salvo);
        await encaminharParaEquipe(
          'whatsapp',
          from,
          `[cadastro extraído] Hóspede 1: ${dados.hospede1?.nome || '(não informado)'} | Check-in: ${dados.checkin} → Check-out: ${dados.checkout} | Cabana: ${dados.cabana}`
        );
      } else {
        // Nem as regras nem a IA deram conta — avisa a equipe com o texto
        // original, pra ninguém ficar sem resposta.
        await encaminharParaEquipe('whatsapp', from, `[cadastro recebido - não consegui extrair automaticamente, revisar manualmente]\n${text}`);
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

    // 2) Primeiro contato desse cliente: manda boas-vindas + PDFs de apresentação
    // + menu de opções, em vez de já chamar a IA
    if (!contatosBoasVindasEnviadas.has(key)) {
      contatosBoasVindasEnviadas.add(key);
      await sendWhatsAppMessage(from, MENU().welcome_text);
      await enviarPdfsBoasVindas(from, sendWhatsAppDocument);
      await sleep(3000); // dá tempo do WhatsApp processar os documentos antes do menu chegar
      await sendWhatsAppInteractiveList(from);
      return;
    }

    // 3) Fora do roteiro fixo: só chama a Claude pra conversar se o chat estiver
    // explicitamente habilitado (IA_CHAT_ATIVA) — extração pro CRM continua
    // funcionando mesmo com o chat desligado.
    if (!IA_CHAT_ATIVA) {
      await sendWhatsAppMessage(from, MENSAGEM_ENCAMINHAMENTO);
      await encaminharParaEquipe('whatsapp', from, text);
      return;
    }
    const { reply, escalate, pdfApelidos } = await askClaude(key, text);
    await sendWhatsAppMessage(from, reply);
    for (const apelido of pdfApelidos) {
      await sendWhatsAppDocument(from, apelido);
    }
    if (escalate) await encaminharParaEquipe('whatsapp', from, text);
  } catch (err) {
    console.error('Erro processando mensagem do WhatsApp:', err.response?.data || err.message);
  }
});

// Envia a resposta pronta de um item do menu (texto + PDF, se houver) e
// registra escalonamento (com notificação de verdade pra proprietária) se for o caso.
async function handleWhatsAppMenuItem(to, item) {
  await sendWhatsAppMessage(to, item.response);
  if (item.pdf) await sendWhatsAppDocument(to, item.pdf);
  if (item.followUp) await sendWhatsAppMessage(to, item.followUp);
  if (item.sendForm) await sendWhatsAppMessage(to, FORMULARIO_CADASTRO());
  if (item.escalate) await encaminharParaEquipe('whatsapp', to, `[menu] ${item.title}`);
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
        body: { text: MENU().menu_prompt_text || 'Escolha uma opção:' },
        action: {
          button: 'Ver opções',
          sections: [
            {
              title: 'Vila Pinheiro Cabanas',
              rows: MENU().items.map((item) => ({ id: item.id, title: item.title.slice(0, 24) })),
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

// Baixa o PDF do Google Drive e sobe como mídia do WhatsApp, com o tipo MIME
// explícito (application/pdf). Faz isso porque o link direto do Drive às vezes
// devolve o Content-Type errado (application/octet-stream), e o WhatsApp então
// entrega o arquivo como .bin em vez de .pdf pro hóspede.
async function uploadWhatsAppMedia(apelido) {
  const driveLink = PDFS()[apelido];
  if (!driveLink) return null;
  const directLink = toDirectDriveLink(driveLink);

  const arquivo = await axios.get(directLink, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(arquivo.data);

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'application/pdf');
  form.append('file', buffer, { filename: `${apelido}.pdf`, contentType: 'application/pdf' });

  const upload = await axios.post(
    `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/media`,
    form,
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, ...form.getHeaders() } }
  );
  return upload.data.id;
}

async function sendWhatsAppDocument(to, apelido) {
  if (!PDFS()[apelido]) {
    console.warn(`Aviso: apelido de PDF "${apelido}" não encontrado em pdfs.json`);
    return;
  }
  const mediaId = await uploadWhatsAppMedia(apelido);
  if (!mediaId) return;
  await axios.post(
    `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'document',
      document: { id: mediaId, filename: `${apelido}.pdf` },
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

    // 2) Primeiro contato: manda boas-vindas + PDFs de apresentação + menu como
    // texto numerado (Instagram não tem lista interativa como o WhatsApp)
    if (!contatosBoasVindasEnviadas.has(key)) {
      contatosBoasVindasEnviadas.add(key);
      await sendInstagramMessage(senderId, MENU().welcome_text);
      await enviarPdfsBoasVindas(senderId, sendInstagramDocument);
      await sleep(3000);
      await sendInstagramMessage(senderId, buildTextMenu());
      return;
    }

    // 3) Fora do roteiro fixo: só chama a Claude pra conversar se o chat estiver
    // explicitamente habilitado (IA_CHAT_ATIVA) — extração pro CRM continua
    // funcionando mesmo com o chat desligado.
    if (!IA_CHAT_ATIVA) {
      await sendInstagramMessage(senderId, MENSAGEM_ENCAMINHAMENTO);
      await encaminharParaEquipe('instagram', senderId, text);
      return;
    }
    const { reply, escalate, pdfApelidos } = await askClaude(key, text);
    await sendInstagramMessage(senderId, reply);
    for (const apelido of pdfApelidos) {
      await sendInstagramDocument(senderId, apelido);
    }
    if (escalate) await encaminharParaEquipe('instagram', senderId, text);
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
// O welcome_text já foi enviado antes disso — aqui só o convite pra escolher.
function buildTextMenu() {
  const linhas = MENU().items.map((item, i) => `${i + 1}. ${item.title}`);
  return `${MENU().menu_prompt_text || 'Como podemos ajudar?'}\n\n${linhas.join('\n')}\n\nÉ só digitar o assunto que você quer saber.`;
}

async function handleInstagramMenuItem(recipientId, item) {
  await sendInstagramMessage(recipientId, item.response);
  if (item.pdf) await sendInstagramDocument(recipientId, item.pdf);
  if (item.followUp) await sendInstagramMessage(recipientId, item.followUp);
  if (item.escalate) await encaminharParaEquipe('instagram', recipientId, `[menu] ${item.title}`);
}

// Mesmo princípio do WhatsApp: baixa o PDF e sobe como anexo reutilizável com
// Content-Type explícito, em vez de mandar um link direto (evita o mesmo
// problema de o arquivo chegar como .bin). OBS: esse fluxo ainda não foi
// testado de verdade em uma conversa real do Instagram — só o WhatsApp foi
// testado até agora.
async function uploadInstagramMedia(apelido) {
  const driveLink = PDFS()[apelido];
  if (!driveLink) return null;
  const directLink = toDirectDriveLink(driveLink);

  const arquivo = await axios.get(directLink, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(arquivo.data);

  const form = new FormData();
  form.append('message', JSON.stringify({ attachment: { type: 'file', payload: { is_reusable: true } } }));
  form.append('filedata', buffer, { filename: `${apelido}.pdf`, contentType: 'application/pdf' });

  const upload = await axios.post('https://graph.facebook.com/v20.0/me/message_attachments', form, {
    params: { access_token: process.env.INSTAGRAM_PAGE_TOKEN },
    headers: form.getHeaders(),
  });
  return upload.data.attachment_id;
}

async function sendInstagramDocument(recipientId, apelido) {
  if (!PDFS()[apelido]) {
    console.warn(`Aviso: apelido de PDF "${apelido}" não encontrado em pdfs.json`);
    return;
  }
  const attachmentId = await uploadInstagramMedia(apelido);
  if (!attachmentId) return;
  await axios.post(
    `https://graph.facebook.com/v20.0/me/messages`,
    {
      recipient: { id: recipientId },
      message: {
        attachment: {
          type: 'file',
          payload: { attachment_id: attachmentId },
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

// Reseta o "já recebeu boas-vindas" de um número, útil pra retestar o fluxo de
// primeiro contato sem precisar reiniciar o servidor inteiro.
// Acesse: https://seu-servidor.up.railway.app/admin/reset-contato?key=SUA_ADMIN_KEY&telefone=5527...&canal=whatsapp
// Diagnóstico rápido: mostra o que está configurado de verdade, sem expor
// nenhuma chave/token. Útil pra descobrir se uma variável de ambiente não
// está sendo lida (nome errado, redeploy não aconteceu, etc.).
// Acesse: https://seu-servidor.up.railway.app/admin/status?key=SUA_ADMIN_KEY
app.get('/admin/status', requireAdminKey, (req, res) => {
  res.json({
    IA_ATIVA_extracao_cadastro_reserva: IA_ATIVA,
    IA_CHAT_ATIVA_conversa_livre_com_cliente: IA_CHAT_ATIVA,
    ANTHROPIC_API_KEY_configurada: Boolean(process.env.ANTHROPIC_API_KEY),
    WHATSAPP_TOKEN_configurado: Boolean(process.env.WHATSAPP_TOKEN),
    WHATSAPP_PHONE_NUMBER_ID_configurado: Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID),
    OWNER_WHATSAPP_NUMBER_configurado: Boolean(process.env.OWNER_WHATSAPP_NUMBER),
    STAFF_NUMBERS_lista: STAFF_NUMBERS,
    DATA_DIR: process.env.DATA_DIR || '(não definido, usando padrão)',
    CONFIG_editada_pelo_painel: config.listar().filter((c) => c.origem === 'painel').map((c) => c.nome),
    BACKUP_DRIVE_configurado: backupConfigurado(),
    total_registros_salvos: loadRegistros().length,
    total_conflitos_de_reserva: detectarConflitos(loadRegistros()).size,
  });
});

app.get('/admin/reset-contato', requireAdminKey, (req, res) => {
  const { telefone, canal = 'whatsapp' } = req.query;
  if (!telefone) return res.status(400).json({ erro: 'Informe ?telefone=5527...' });
  const key = `${canal}:${telefone}`;
  const havia = contatosBoasVindasEnviadas.delete(key);
  conversations.delete(key);
  res.json({ key, resetado: havia });
});

app.get('/admin/escalations', requireAdminKey, (req, res) => {
  res.json(escalations.slice().reverse());
});

// Painel com os cadastros de hóspede e confirmações de reserva já extraídos.
// Acesse: https://seu-servidor.up.railway.app/admin/registros?key=SUA_ADMIN_KEY
app.get('/admin/registros', requireAdminKey, (req, res) => {
  res.json(loadRegistros().slice().reverse());
});

// Dispara o lembrete de véspera na hora, sem esperar o cron das 10h — útil pra
// testar antes de ir ao ar. Use ?dryRun=true pra só ver quem receberia a
// mensagem e o texto exato, sem enviar de verdade nem marcar como enviado.
// Acesse: https://seu-servidor.up.railway.app/admin/testar-lembretes?key=SUA_ADMIN_KEY&dryRun=true
app.get('/admin/testar-lembretes', requireAdminKey, async (req, res) => {
  const dryRun = req.query.dryRun === 'true';
  try {
    const resultado = await enviarLembretesDeVespera({ dryRun });
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ erro: 'Falha ao testar lembretes', detalhe: err.message });
  }
});

// ============================================================================
// API DO CRM (usada pelo painel web em /crm)
// ============================================================================

// Lista registros, com filtros opcionais:
// ?tipo=cadastro|reserva&cabana=Jasmim&busca=texto&status_pagamento=pago|parcial|pendente|atrasado
app.get('/api/registros', requireAdminKey, (req, res) => {
  const todos = loadRegistros();
  // Conflitos são calculados sobre a base INTEIRA, não sobre a lista filtrada —
  // senão um filtro por cabana esconderia justamente a reserva conflitante.
  const mapaConflitos = detectarConflitos(todos);

  let registros = todos;
  const { tipo, cabana, busca, status_pagamento } = req.query;

  if (tipo) registros = registros.filter((r) => r.tipo === tipo);
  if (cabana) registros = registros.filter((r) => normalize(r.dados?.cabana || '').includes(normalize(cabana)));
  if (busca) {
    const b = normalize(busca);
    registros = registros.filter((r) => normalize(JSON.stringify(r.dados || {})).includes(b));
  }

  const enriquecidos = registros.map((r) => ({ ...enrichRegistro(r), conflitos: mapaConflitos.get(r.id) || [] }));
  const filtrados = status_pagamento
    ? enriquecidos.filter((r) => r.dados?.status_pagamento === status_pagamento)
    : enriquecidos;

  res.json(filtrados.slice().reverse());
});

// Estadias = mesma coisa que /api/registros, mas com o cadastro do hóspede e a
// confirmação da equipe FUNDIDOS numa linha só (a fusão é só de exibição — os
// registros crus continuam intactos e vão junto, em "registros").
// Filtros: ?estagio=aguardando|confirmada|paga&cabana=&busca=&status_pagamento=
app.get('/api/estadias', requireAdminKey, (req, res) => {
  const todos = loadRegistros();
  const mapaConflitos = detectarConflitos(todos);
  const hojeISO = new Date().toISOString().slice(0, 10);

  let estadias = buildEstadias(todos, hojeISO, { mapaConflitos, cabanasList: CABANAS() });
  const { cabana, busca, status_pagamento, estagio } = req.query;

  if (estagio) estadias = estadias.filter((e) => e.estagio === estagio);
  if (cabana) estadias = estadias.filter((e) => normalize(e.cabana || '').includes(normalize(cabana)));
  if (status_pagamento) estadias = estadias.filter((e) => e.status_pagamento === status_pagamento);
  if (busca) {
    const b = normalize(busca);
    estadias = estadias.filter((e) => normalize(JSON.stringify(e.registros.map((r) => ({ ...r.dados, telefone: r.telefone })))).includes(b));
  }

  res.json(estadias);
});

// Resumo geral pro dashboard: ocupação atual, próximos check-ins/checkouts, financeiro.
app.get('/api/dashboard', requireAdminKey, (req, res) => {
  const registros = loadRegistros();
  const mapaConflitos = detectarConflitos(registros);
  // Conta ESTADIAS em conflito, não registros crus — senão uma mesma estadia
  // com cadastro + reserva contaria 2, e o número não bate com a aba Reservas.
  const estadias = buildEstadias(registros, undefined, { mapaConflitos, cabanasList: CABANAS() });
  res.json({
    ...buildDashboard(registros, CABANAS()),
    totalConflitos: estadias.filter((e) => e.conflitos.length).length,
    totalDivergencias: estadias.filter((e) => e.divergencias.length).length,
  });
});

// Clientes agregados (cadastro + reserva casada por telefone/nome). ?busca=texto
app.get('/api/clientes', requireAdminKey, (req, res) => {
  let clientes = buildClientes(loadRegistros());
  const { busca } = req.query;
  if (busca) {
    const b = normalize(busca);
    clientes = clientes.filter((c) => normalize(JSON.stringify(c)).includes(b));
  }
  res.json(clientes);
});

// Feed .ics somente leitura (assinatura no Google Agenda/Apple Calendar/Outlook).
// Autenticado por query param (?key=) porque apps de calendário não enviam headers customizados.
app.get('/api/calendario.ics', requireAdminKey, (req, res) => {
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.send(buildICSFeed(loadRegistros()));
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

// Lista as cabanas configuradas (usado pro filtro, legenda e cores do calendário)
app.get('/api/cabanas', requireAdminKey, (req, res) => {
  res.json(CABANAS().map((c) => ({ nome: c.nome, cor: c.cor || '#6E7F5C' })));
});

// ============================================================================
// API DE CONFIGURAÇÃO (usada pelo painel do bot em /painel)
// Toda escrita passa pela validação do config.js — configuração inválida é
// rejeitada antes de virar arquivo, nunca depois, na cara do hóspede.
// ============================================================================

// Snapshot no Drive depois de salvar. Nunca bloqueia a resposta do painel: se o
// Drive estiver fora do ar, a edição continua valendo e o cron das 3h tenta de novo.
function snapshotConfigEmSegundoPlano(motivo) {
  if (!backupConfigurado()) return;
  fazerBackupConfig(configuracaoCompleta())
    .then((r) => { if (!r.ok) console.warn(`Snapshot da config (${motivo}) não foi:`, r.motivo); })
    .catch((err) => console.error('Snapshot da config falhou:', err.message));
}

function configuracaoCompleta() {
  return Object.fromEntries(config.listar().map(({ nome }) => [nome, config.lerSeguro(nome, null)]));
}

app.get('/api/config', requireAdminKey, (req, res) => {
  res.json(config.listar());
});

app.get('/api/config/:nome', requireAdminKey, (req, res) => {
  const { nome } = req.params;
  if (!config.ehEditavel(nome)) return res.status(404).json({ erro: 'Arquivo de configuração desconhecido' });
  const conteudo = config.lerSeguro(nome, null);
  if (conteudo === null) return res.status(500).json({ erro: 'Não consegui ler esse arquivo de configuração' });
  res.json({ nome, origem: config.origemDe(nome), conteudo });
});

// Confere sem salvar — o painel usa pra mostrar o erro enquanto a pessoa digita.
app.post('/api/config/:nome/validar', requireAdminKey, (req, res) => {
  const { nome } = req.params;
  if (!config.ehEditavel(nome)) return res.status(404).json({ erro: 'Arquivo de configuração desconhecido' });
  const { erros, avisos } = config.validar(nome, req.body?.conteudo);
  res.json({ ok: erros.length === 0, erros, avisos });
});

app.put('/api/config/:nome', requireAdminKey, (req, res) => {
  const { nome } = req.params;
  if (!config.ehEditavel(nome)) return res.status(404).json({ erro: 'Arquivo de configuração desconhecido' });
  if (req.body?.conteudo === undefined) return res.status(400).json({ erro: 'Faltou o campo "conteudo"' });

  try {
    const resultado = config.salvar(nome, req.body.conteudo);
    if (!resultado.ok) return res.status(400).json({ ok: false, erros: resultado.erros, avisos: resultado.avisos });
    console.log(`⚙️ Configuração "${nome}" atualizada pelo painel`);
    snapshotConfigEmSegundoPlano(`edição de ${nome}`);
    res.json({ ok: true, avisos: resultado.avisos, origem: 'painel' });
  } catch (err) {
    console.error(`Erro salvando configuração "${nome}":`, err.message);
    res.status(500).json({ erro: 'Não consegui salvar', detalhe: err.message });
  }
});

// Desfaz as edições do painel e volta pro arquivo que veio no repositório.
app.post('/api/config/:nome/restaurar', requireAdminKey, (req, res) => {
  const { nome } = req.params;
  try {
    const resultado = config.restaurarPadrao(nome);
    if (!resultado.ok) return res.status(400).json(resultado);
    snapshotConfigEmSegundoPlano(`restauração de ${nome}`);
    res.json({ ok: true, conteudo: resultado.conteudo, origem: 'repositorio' });
  } catch (err) {
    res.status(500).json({ erro: 'Não consegui restaurar', detalhe: err.message });
  }
});

// Mapa do bot: cada nó do fluxograma aponta pro arquivo/campo que o alimenta,
// pra que clicar num balão abra exatamente o texto certo pra editar.
app.get('/api/fluxo', requireAdminKey, (req, res) => {
  const menu = MENU();
  const cabanas = CABANAS();
  const itens = menu.items || [];

  res.json({
    ia_chat_ativa: IA_CHAT_ATIVA,
    nos: [
      {
        id: 'boas-vindas',
        titulo: 'Boas-vindas',
        descricao: 'Primeira mensagem de quem nunca escreveu antes.',
        editavel: true,
        arquivo: 'menu.json',
        campo: 'welcome_text',
        preview: menu.welcome_text || '',
      },
      {
        id: 'pdfs-boas-vindas',
        titulo: 'PDFs de apresentação',
        descricao: `${(menu.pdfs_boas_vindas || []).length} arquivo(s) enviados logo depois das boas-vindas.`,
        editavel: false,
        arquivo: 'menu.json',
        campo: 'pdfs_boas_vindas',
        preview: (menu.pdfs_boas_vindas || []).join('\n'),
      },
      {
        id: 'menu',
        titulo: 'Menu de opções',
        descricao: `${itens.length} opção(ões). Responde de graça, sem usar a IA.`,
        editavel: false,
        arquivo: 'menu.json',
        campo: 'items',
        preview: itens.map((i) => `• ${i.title}`).join('\n'),
      },
      {
        id: 'menu-prompt',
        titulo: 'Convite pra escolher',
        descricao: 'Texto que aparece junto da lista de opções.',
        editavel: false,
        arquivo: 'menu.json',
        campo: 'menu_prompt_text',
        preview: menu.menu_prompt_text || '',
      },
      {
        id: 'reserva-crm',
        titulo: 'Reserva vai pro CRM',
        descricao: `Só vale para os ${STAFF_NUMBERS.length} número(s) da equipe. Lê hóspede, cabana, datas, valor e parcelas.`,
        editavel: false,
        arquivo: null,
        campo: null,
        preview: '',
      },
      {
        id: 'cadastro-crm',
        titulo: 'Cadastro vai pro CRM',
        descricao: 'O hóspede recebe uma confirmação e a equipe é avisada na hora.',
        editavel: false,
        arquivo: null,
        campo: null,
        preview: 'Recebemos seu cadastro! 🙌 Nosso time já foi avisado e vai confirmar sua reserva em breve.',
      },
      {
        id: 'formulario',
        titulo: 'Formulário de cadastro',
        descricao: 'A equipe envia à mão no fechamento da venda. A resposta do hóspede vira registro no CRM.',
        editavel: false,
        arquivo: 'formulario-cadastro.txt',
        campo: null,
        preview: FORMULARIO_CADASTRO(),
      },
      {
        id: 'equipe',
        titulo: 'Encaminha pra equipe',
        descricao: 'Qualquer coisa fora do roteiro: o hóspede recebe um aviso e a equipe é notificada.',
        editavel: false,
        arquivo: null,
        campo: null,
        preview: MENSAGEM_ENCAMINHAMENTO,
      },
      {
        id: 'ia-chat',
        titulo: 'Chat da IA',
        descricao: IA_CHAT_ATIVA
          ? 'Ligado: a IA responde perguntas fora do menu.'
          : 'Desligado. Nada é respondido pela IA — tudo fora do roteiro vai pra equipe.',
        editavel: false,
        arquivo: null,
        campo: null,
        preview: '',
      },
      {
        id: 'lembrete-vespera',
        titulo: 'Lembrete da véspera',
        descricao: 'Todo dia às 10h, quem faz check-in amanhã recebe código de acesso e wifi.',
        editavel: false,
        arquivo: null,
        campo: null,
        preview: '',
      },
      {
        id: 'cabanas',
        titulo: 'Cabanas',
        descricao: `${cabanas.length} cabana(s). Código de acesso, wifi e recomendações usados no lembrete.`,
        editavel: true,
        arquivo: 'cabanas.json',
        campo: 'cabanas',
        preview: cabanas.map((c) => `• ${c.nome}`).join('\n'),
      },
      {
        id: 'cobranca-parcela',
        titulo: 'Cobrança de parcelas',
        descricao: `Todo dia às 9h, a equipe recebe as parcelas atrasadas e as que vencem em ${DIAS_ANTECEDENCIA_PARCELA} dias. Nunca vai pro hóspede.`,
        editavel: false,
        arquivo: null,
        campo: null,
        preview: '',
      },
      {
        id: 'backup',
        titulo: 'Backup no Drive',
        descricao: backupConfigurado()
          ? 'Todo dia às 3h, uma cópia do CRM e da configuração vai pro Google Drive.'
          : 'Ainda não configurado — faltam as variáveis do Google Drive.',
        editavel: false,
        arquivo: null,
        campo: null,
        preview: '',
      },
    ],
  });
});

// Serve o painel de configuração do bot (arquivo estático em /public/painel.html)
app.get('/painel', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'painel.html'));
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

// Um campo "não preenchido" é o que está vazio OU ainda com o placeholder
// "[EDITE: ...]" que vem no cabanas.json de exemplo. Enviar isso pro hóspede
// na véspera do check-in seria pior do que não enviar nada.
function campoPendente(valor) {
  return !valor || /^\s*\[EDITE/i.test(String(valor));
}

function camposPendentesDaCabana(cabana) {
  if (!cabana) return [];
  return ['codigo_acesso', 'senha_wifi', 'recomendacoes'].filter((campo) => campoPendente(cabana[campo]));
}

// Monta o texto do lembrete. Se a cabana não foi encontrada em cabanas.json ou
// tem campo pendente, cai numa versão genérica (sem dado quebrado) e devolve o
// motivo, pra equipe ser avisada e completar manualmente.
function montarMensagemLembrete(cabana, nomeHospede) {
  const pendentes = camposPendentesDaCabana(cabana);

  if (!cabana || pendentes.length) {
    return {
      mensagem: `Olá, ${nomeHospede}! 🌿 Estamos ansiosos pra te receber amanhã na Vila Pinheiro. Qualquer dúvida antes da chegada, é só chamar por aqui!`,
      completa: false,
      motivo: cabana
        ? `cabana "${cabana.nome}" com campo(s) não preenchido(s) em cabanas.json: ${pendentes.join(', ')}`
        : 'cabana não encontrada em cabanas.json',
    };
  }

  return {
    mensagem: `Olá, ${nomeHospede}! 🌿 Estamos ansiosos pra te receber amanhã na Vila Pinheiro, na cabana ${cabana.nome}.\n\n🔑 Código de acesso: ${cabana.codigo_acesso}\n📶 Wifi: ${cabana.senha_wifi}\n\n${cabana.recomendacoes}\n\nQualquer coisa, é só chamar por aqui!`,
    completa: true,
    motivo: null,
  };
}

async function enviarLembretesDeVespera({ dryRun = false } = {}) {
  const amanha = amanhaISO();
  const registros = loadRegistros();

  const candidatos = registros.filter(
    (r) => r.tipo === 'cadastro' && r.checkin_iso === amanha && !r.lembreteEnviado && r.telefone
  );

  const resultado = [];

  for (const registro of candidatos) {
    const cabana = findCabana(registro.dados?.cabana);
    const nomeHospede = registro.dados?.hospede1?.nome?.split(' ')[0] || 'tudo bem';
    const { mensagem, completa, motivo } = montarMensagemLembrete(cabana, nomeHospede);

    if (dryRun) {
      resultado.push({ telefone: registro.telefone, hospede: nomeHospede, cabanaEncontrada: Boolean(cabana), completa, motivo, mensagem });
      continue;
    }

    if (!completa) {
      console.warn(`⚠️ Lembrete genérico pra ${registro.telefone}: ${motivo}`);
      await notificarResponsavel(
        `⚠️ Lembrete de véspera enviado SEM os dados da cabana.\nHóspede: ${registro.dados?.hospede1?.nome || nomeHospede} (${registro.telefone})\nCabana informada: ${registro.dados?.cabana || '(não informada)'}\nMotivo: ${motivo}\n\nMande o código de acesso e o wifi manualmente pra esse hóspede e complete o cabanas.json.`
      );
    }

    try {
      await sendWhatsAppMessage(registro.telefone, mensagem);
      updateRegistro(registro.id, { lembreteEnviado: true });
      console.log(`✅ Lembrete de véspera enviado pra ${registro.telefone}`);
      resultado.push({ telefone: registro.telefone, hospede: nomeHospede, enviado: true });
    } catch (err) {
      console.error(`Erro enviando lembrete pra ${registro.telefone}:`, err.response?.data || err.message);
      resultado.push({ telefone: registro.telefone, hospede: nomeHospede, enviado: false, erro: err.message });
    }
  }

  return { amanha, totalCandidatos: candidatos.length, dryRun, resultado };
}


// ============================================================================
// LEMBRETE DE PARCELA (para a EQUIPE, nunca direto pro hóspede)
// Junta todas as parcelas atrasadas ou vencendo nos próximos dias numa única
// mensagem por dia, e marca cada parcela como "já avisada" pra não repetir.
// ============================================================================
const DIAS_ANTECEDENCIA_PARCELA = Number(process.env.DIAS_ANTECEDENCIA_PARCELA || 3);

async function enviarLembretesDeParcela({ dryRun = false } = {}) {
  const hojeISO = new Date().toISOString().slice(0, 10);
  const pendencias = listarParcelasParaLembrar(loadRegistros(), hojeISO, DIAS_ANTECEDENCIA_PARCELA);

  if (!pendencias.length) return { hoje: hojeISO, total: 0, dryRun, mensagem: null };

  const mensagem = montarMensagemCobranca(pendencias);
  if (dryRun) return { hoje: hojeISO, total: pendencias.length, dryRun, pendencias, mensagem };

  await notificarEquipe(mensagem);

  // Só marca como avisado DEPOIS do envio dar certo — se o WhatsApp falhar,
  // o lembrete volta amanhã em vez de sumir.
  const porRegistro = new Map();
  for (const p of pendencias) {
    if (!porRegistro.has(p.registroId)) porRegistro.set(p.registroId, {});
    porRegistro.get(p.registroId)[p.chave] = true;
  }
  for (const [registroId, chaves] of porRegistro) {
    const atual = loadRegistros().find((r) => r.id === registroId);
    if (atual) updateRegistro(registroId, { lembretesParcela: { ...(atual.lembretesParcela || {}), ...chaves } });
  }

  console.log(`✅ Lembrete de ${pendencias.length} parcela(s) enviado pra equipe`);
  return { hoje: hojeISO, total: pendencias.length, dryRun, mensagem };
}

// ============================================================================
// BACKUP DIÁRIO DO registros.json NO GOOGLE DRIVE
// ============================================================================
async function rodarBackup() {
  const resultado = await fazerBackup(REGISTROS_PATH);
  if (!resultado.ok && backupConfigurado()) {
    await notificarResponsavel(`⚠️ O backup automático do CRM falhou hoje.\nMotivo: ${resultado.motivo}`);
  }
  return resultado;
}

app.get('/admin/testar-parcelas', requireAdminKey, async (req, res) => {
  try {
    res.json(await enviarLembretesDeParcela({ dryRun: req.query.dryRun === 'true' }));
  } catch (err) {
    res.status(500).json({ erro: 'Falha ao testar lembrete de parcelas', detalhe: err.message });
  }
});

app.get('/admin/testar-backup', requireAdminKey, async (req, res) => {
  try {
    res.json(await rodarBackup());
  } catch (err) {
    res.status(500).json({ erro: 'Falha ao testar backup', detalhe: err.message });
  }
});

// Lembrete de véspera: todo dia às 10h (horário de Brasília)
cron.schedule('0 10 * * *', enviarLembretesDeVespera, { timezone: 'America/Sao_Paulo' });

// Cobrança de parcelas: todo dia às 9h, antes do expediente
cron.schedule('0 9 * * *', enviarLembretesDeParcela, { timezone: 'America/Sao_Paulo' });

// Backup no Drive: todo dia às 3h da manhã (registros + configuração do painel)
cron.schedule('0 3 * * *', rodarBackup, { timezone: 'America/Sao_Paulo' });
cron.schedule('5 3 * * *', () => snapshotConfigEmSegundoPlano('rotina diária'), { timezone: 'America/Sao_Paulo' });

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
