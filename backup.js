// ============================================================================
// BACKUP AUTOMÁTICO DO registros.json NO GOOGLE DRIVE
// ----------------------------------------------------------------------------
// Usa OAuth com "refresh token" (autorização feita UMA vez, pelo script
// scripts/autorizar-drive.js) em vez de conta de serviço. Motivo: conta de
// serviço não tem cota de armazenamento própria no Drive — em conta Google
// pessoal (Gmail), o upload falha com "Service Accounts do not have storage
// quota". Com refresh token, o arquivo é gravado na SUA conta, como se você
// mesmo tivesse subido.
//
// Variáveis de ambiente necessárias (Railway):
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN
//   GDRIVE_BACKUP_FOLDER_ID   (ID da pasta no Drive — está na URL da pasta)
//   BACKUP_RETENCAO_DIAS      (opcional, padrão 30)
// ============================================================================

const fs = require('fs');
const { Readable } = require('stream');
const { google } = require('googleapis');

const RETENCAO_DIAS = Number(process.env.BACKUP_RETENCAO_DIAS || 30);
const PREFIXO = 'registros-';
const PREFIXO_CONFIG = 'config-';

function backupConfigurado() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REFRESH_TOKEN &&
      process.env.GDRIVE_BACKUP_FOLDER_ID
  );
}

function criarClienteDrive() {
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth });
}

function nomeDoArquivo(dataISO, prefixo = PREFIXO) {
  return `${prefixo}${dataISO}.json`;
}

// Se já existe um backup com o mesmo nome (rodou 2x no mesmo dia), sobrescreve
// em vez de criar duplicata.
async function acharArquivo(drive, nome, pastaId) {
  const escapado = nome.replace(/'/g, "\\'");
  const { data } = await drive.files.list({
    q: `name = '${escapado}' and '${pastaId}' in parents and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1,
  });
  return data.files?.[0] || null;
}

async function limparBackupsAntigos(drive, pastaId, hoje = new Date(), prefixo = PREFIXO) {
  const corte = new Date(hoje);
  corte.setDate(corte.getDate() - RETENCAO_DIAS);
  const corteISO = corte.toISOString().slice(0, 10);

  const { data } = await drive.files.list({
    q: `'${pastaId}' in parents and name contains '${prefixo}' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1000,
  });

  const antigos = (data.files || []).filter((arquivo) => {
    const dataDoNome = arquivo.name.replace(prefixo, '').replace('.json', '');
    return /^\d{4}-\d{2}-\d{2}$/.test(dataDoNome) && dataDoNome < corteISO;
  });

  for (const arquivo of antigos) {
    try {
      await drive.files.update({ fileId: arquivo.id, requestBody: { trashed: true } });
    } catch (err) {
      console.error(`Backup: não consegui remover "${arquivo.name}":`, err.message);
    }
  }
  return antigos.map((a) => a.name);
}

// Sobe (ou sobrescreve) um arquivo de texto na pasta de backup do Drive e
// remove os mais antigos que a retenção. Usado tanto pelo backup do CRM quanto
// pelo snapshot da configuração editada no painel.
async function enviarParaDrive(nome, conteudo, { hoje = new Date(), prefixo = PREFIXO } = {}) {
  const pastaId = process.env.GDRIVE_BACKUP_FOLDER_ID;
  const drive = criarClienteDrive();
  const media = { mimeType: 'application/json', body: Readable.from([conteudo]) };
  const existente = await acharArquivo(drive, nome, pastaId);

  const arquivo = existente
    ? await drive.files.update({ fileId: existente.id, media, fields: 'id, name' })
    : await drive.files.create({
        requestBody: { name: nome, parents: [pastaId], mimeType: 'application/json' },
        media,
        fields: 'id, name',
      });

  const removidos = await limparBackupsAntigos(drive, pastaId, hoje, prefixo);
  return { arquivo: arquivo.data.name, id: arquivo.data.id, sobrescrito: Boolean(existente), removidos };
}

// Snapshot da configuração editada pelo painel (menu, cabanas, PDFs, formulário)
// — 1 arquivo por dia, mesma retenção do backup do CRM. É o "rollback" que a
// gente perde por não versionar a configuração no Git.
async function fazerBackupConfig(configuracao, { hoje = new Date() } = {}) {
  if (!backupConfigurado()) {
    return { ok: false, motivo: 'backup do Drive não configurado (faltam variáveis de ambiente)' };
  }
  try {
    const conteudo = JSON.stringify({ gerado_em: new Date().toISOString(), configuracao }, null, 2);
    const resultado = await enviarParaDrive(nomeDoArquivo(hoje.toISOString().slice(0, 10), PREFIXO_CONFIG), conteudo, { hoje, prefixo: PREFIXO_CONFIG });
    console.log(`✅ Snapshot da configuração no Drive: ${resultado.arquivo}`);
    return { ok: true, ...resultado };
  } catch (err) {
    const detalhe = err.response?.data?.error?.message || err.message;
    console.error('❌ Snapshot da configuração falhou:', detalhe);
    return { ok: false, motivo: detalhe };
  }
}

async function fazerBackup(caminhoRegistros, { hoje = new Date() } = {}) {
  if (!backupConfigurado()) {
    return { ok: false, motivo: 'backup do Drive não configurado (faltam variáveis de ambiente)' };
  }
  if (!fs.existsSync(caminhoRegistros)) {
    return { ok: false, motivo: 'registros.json ainda não existe — nada pra salvar' };
  }

  const conteudo = fs.readFileSync(caminhoRegistros, 'utf-8');

  // Nunca subir um arquivo corrompido por cima de um backup bom.
  let totalRegistros;
  try {
    const parsed = JSON.parse(conteudo);
    if (!Array.isArray(parsed)) throw new Error('conteúdo não é uma lista');
    totalRegistros = parsed.length;
  } catch (err) {
    return { ok: false, motivo: `registros.json está inválido, backup cancelado: ${err.message}` };
  }

  const nome = nomeDoArquivo(hoje.toISOString().slice(0, 10));

  try {
    const resultado = await enviarParaDrive(nome, conteudo, { hoje });
    console.log(`✅ Backup no Drive: ${nome} (${totalRegistros} registros)`);
    return { ok: true, totalRegistros, ...resultado };
  } catch (err) {
    const detalhe = err.response?.data?.error?.message || err.message;
    console.error('❌ Backup no Drive falhou:', detalhe);
    return { ok: false, motivo: detalhe };
  }
}

module.exports = { fazerBackup, fazerBackupConfig, backupConfigurado };
