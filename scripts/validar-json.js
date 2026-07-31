#!/usr/bin/env node
// Valida os .json do projeto antes de subir. Roda com: npm run validar
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const ARQUIVOS = ['menu.json', 'pdfs.json', 'cabanas.json', 'package.json'];

const erros = [];
const avisos = [];

function lerJSON(nome) {
  const caminho = path.join(RAIZ, nome);
  if (!fs.existsSync(caminho)) {
    erros.push(`${nome}: arquivo não encontrado`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(caminho, 'utf-8'));
  } catch (err) {
    erros.push(`${nome}: JSON inválido — ${err.message}`);
    return null;
  }
}

const dados = Object.fromEntries(ARQUIVOS.map((nome) => [nome, lerJSON(nome)]));
if (erros.length) finalizar();

const menu = dados['menu.json'];
const pdfs = dados['pdfs.json'];
const cabanas = dados['cabanas.json'];

// --- menu.json ---
if (!Array.isArray(menu?.items) || menu.items.length === 0) {
  erros.push('menu.json: "items" precisa ser uma lista não vazia');
} else {
  const ids = new Set();
  for (const item of menu.items) {
    if (!item.id) erros.push(`menu.json: item sem "id" (título: ${item.title || '?'})`);
    else if (ids.has(item.id)) erros.push(`menu.json: id duplicado "${item.id}"`);
    else ids.add(item.id);

    if (!item.title) erros.push(`menu.json: item "${item.id}" sem "title"`);
    // Limite duro do WhatsApp para título de item de lista interativa
    else if ([...item.title].length > 24) {
      erros.push(`menu.json: título "${item.title}" tem ${[...item.title].length} caracteres (máx. 24 no WhatsApp)`);
    }

    if (!item.response) erros.push(`menu.json: item "${item.id}" sem "response"`);
    if (!Array.isArray(item.aliases)) erros.push(`menu.json: item "${item.id}" com "aliases" que não é lista`);
    if (item.pdf && !pdfs?.[item.pdf]) erros.push(`menu.json: item "${item.id}" aponta pro PDF "${item.pdf}", que não existe em pdfs.json`);
  }
}

for (const apelido of menu?.pdfs_boas_vindas || []) {
  if (!pdfs?.[apelido]) erros.push(`menu.json: pdfs_boas_vindas referencia "${apelido}", que não existe em pdfs.json`);
}

// --- pdfs.json ---
for (const [apelido, link] of Object.entries(pdfs || {})) {
  if (apelido.startsWith('_')) continue;
  if (typeof link !== 'string' || !link.startsWith('http')) {
    erros.push(`pdfs.json: "${apelido}" não tem um link válido`);
  } else if (link.includes('drive.google.com') && !/\/d\/[a-zA-Z0-9_-]+/.test(link)) {
    erros.push(`pdfs.json: "${apelido}" tem link do Drive fora do formato /file/d/ID/view`);
  }
}

// --- cabanas.json ---
const CAMPOS_CABANA = ['codigo_acesso', 'senha_wifi', 'recomendacoes'];
if (!Array.isArray(cabanas?.cabanas) || cabanas.cabanas.length === 0) {
  erros.push('cabanas.json: "cabanas" precisa ser uma lista não vazia');
} else {
  for (const cabana of cabanas.cabanas) {
    if (!cabana.nome) { erros.push('cabanas.json: cabana sem "nome"'); continue; }
    if (!/^#[0-9a-fA-F]{6}$/.test(cabana.cor || '')) {
      erros.push(`cabanas.json: cabana "${cabana.nome}" com "cor" inválida (esperado hex, ex: #C97C55)`);
    }
    for (const campo of CAMPOS_CABANA) {
      const valor = cabana[campo];
      if (!valor) avisos.push(`cabanas.json: "${cabana.nome}" está sem "${campo}"`);
      else if (/^\s*\[EDITE/i.test(valor)) {
        avisos.push(`cabanas.json: "${cabana.nome}" ainda tem placeholder em "${campo}" — o lembrete de véspera enviaria esse texto pro hóspede`);
      }
    }
  }
}

finalizar();

function finalizar() {
  for (const aviso of avisos) console.warn(`⚠️  ${aviso}`);
  if (erros.length) {
    for (const erro of erros) console.error(`❌ ${erro}`);
    console.error(`\n${erros.length} erro(s) — corrija antes de subir.`);
    process.exit(1);
  }
  console.log(`✅ JSONs válidos${avisos.length ? ` (${avisos.length} aviso(s) acima)` : ''}`);
  process.exit(0);
}
