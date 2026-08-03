// ============================================================================
// CONFIGURAÇÃO EDITÁVEL PELO PAINEL
// ----------------------------------------------------------------------------
// Os arquivos de configuração (menu.json, cabanas.json, pdfs.json, formulário)
// deixam de ser lidos só no boot. Agora existem em dois lugares:
//
//   1. VOLUME  — $DATA_DIR/config/<arquivo>  → o que o painel edita, vale sempre
//   2. REPO    — <raiz>/<arquivo>            → semente, usada enquanto ninguém
//                                              editou nada pelo painel
//
// A leitura sempre confere o mtime do arquivo antes de usar o cache, então uma
// edição vale na hora, sem redeploy e sem reiniciar o servidor.
//
// Nada é salvo sem passar pela validação — a mesma que roda no CI. Um menu com
// título de 30 caracteres ou um PDF inexistente é rejeitado ANTES de virar
// arquivo, e não na hora de responder um hóspede.
// ============================================================================

const fs = require('fs');
const path = require('path');

const RAIZ = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(RAIZ, 'data');
const CONFIG_DIR = path.join(DATA_DIR, 'config');

// ----------------------------------------------------------------------------
// Validações (funções puras: recebem o conteúdo, devolvem erros e avisos)
// ----------------------------------------------------------------------------
function validarMenu(menu, { pdfs } = {}) {
  const erros = [];
  const avisos = [];

  if (!menu || typeof menu !== 'object') return { erros: ['menu.json precisa ser um objeto'], avisos };
  if (!Array.isArray(menu.items) || menu.items.length === 0) erros.push('"items" precisa ser uma lista com pelo menos um item');
  if (!menu.welcome_text) avisos.push('sem "welcome_text" — o primeiro contato ficaria sem mensagem de boas-vindas');

  const ids = new Set();
  for (const item of menu.items || []) {
    if (!item.id) erros.push(`item sem "id" (título: ${item.title || '?'})`);
    else if (ids.has(item.id)) erros.push(`id duplicado "${item.id}"`);
    else ids.add(item.id);

    if (!item.title) erros.push(`item "${item.id}" sem título`);
    else if ([...item.title].length > 24) erros.push(`o título "${item.title}" tem ${[...item.title].length} caracteres — o WhatsApp aceita no máximo 24`);

    if (!item.response) erros.push(`item "${item.id}" sem resposta`);
    if (item.aliases !== undefined && !Array.isArray(item.aliases)) erros.push(`item "${item.id}": "aliases" precisa ser uma lista`);
    else if (!item.aliases?.length) avisos.push(`item "${item.id}" sem palavras-chave — só será alcançado pelo menu, não digitando`);

    if (item.pdf && pdfs && !pdfs[item.pdf]) erros.push(`item "${item.id}" aponta pro PDF "${item.pdf}", que não existe na lista de PDFs`);
  }

  for (const apelido of menu.pdfs_boas_vindas || []) {
    if (pdfs && !pdfs[apelido]) erros.push(`"pdfs_boas_vindas" referencia "${apelido}", que não existe na lista de PDFs`);
  }

  return { erros, avisos };
}

function validarPdfs(pdfs) {
  const erros = [];
  if (!pdfs || typeof pdfs !== 'object' || Array.isArray(pdfs)) return { erros: ['pdfs.json precisa ser um objeto'], avisos: [] };
  for (const [apelido, link] of Object.entries(pdfs)) {
    if (apelido.startsWith('_')) continue;
    if (typeof link !== 'string' || !link.startsWith('http')) erros.push(`"${apelido}" não tem um link válido`);
    else if (link.includes('drive.google.com') && !/\/d\/[a-zA-Z0-9_-]+/.test(link)) {
      erros.push(`"${apelido}" tem link do Drive fora do formato /file/d/ID/view`);
    }
  }
  return { erros, avisos: [] };
}

const CAMPOS_CABANA = [
  ['codigo_acesso', 'código de acesso'],
  ['senha_wifi', 'senha do wifi'],
  ['recomendacoes', 'recomendações'],
];

function validarCabanas(dados) {
  const erros = [];
  const avisos = [];
  if (!dados || !Array.isArray(dados.cabanas) || dados.cabanas.length === 0) {
    return { erros: ['"cabanas" precisa ser uma lista com pelo menos uma cabana'], avisos };
  }

  const nomes = new Set();
  for (const cabana of dados.cabanas) {
    if (!cabana.nome) { erros.push('cabana sem nome'); continue; }
    if (nomes.has(cabana.nome)) erros.push(`cabana "${cabana.nome}" aparece duas vezes`);
    nomes.add(cabana.nome);

    if (!/^#[0-9a-fA-F]{6}$/.test(cabana.cor || '')) erros.push(`cabana "${cabana.nome}": cor inválida (esperado hex, ex: #C97C55)`);

    for (const [campo, rotulo] of CAMPOS_CABANA) {
      const valor = cabana[campo];
      if (!valor) avisos.push(`"${cabana.nome}" está sem ${rotulo} — o lembrete de véspera vai sair genérico`);
      else if (/^\s*\[EDITE/i.test(String(valor))) avisos.push(`"${cabana.nome}" ainda tem o texto de exemplo em ${rotulo}`);
    }
  }
  return { erros, avisos };
}

function validarTexto(texto, nome) {
  const conteudo = String(texto ?? '');
  const erros = [];
  const avisos = [];
  if (!conteudo.trim()) erros.push(`${nome} não pode ficar vazio`);
  if (conteudo.length > 4000) erros.push(`${nome} tem ${conteudo.length} caracteres — o WhatsApp corta acima de 4096`);
  else if (conteudo.length > 3000) avisos.push(`${nome} está longo (${conteudo.length} caracteres) — perto do limite do WhatsApp`);
  return { erros, avisos };
}

// ----------------------------------------------------------------------------
// Catálogo dos arquivos editáveis
// ----------------------------------------------------------------------------
const ARQUIVOS = {
  'menu.json': { formato: 'json', rotulo: 'Menu e respostas', validar: (v, ctx) => validarMenu(v, ctx) },
  'pdfs.json': { formato: 'json', rotulo: 'PDFs', validar: (v) => validarPdfs(v) },
  'cabanas.json': { formato: 'json', rotulo: 'Cabanas', validar: (v) => validarCabanas(v) },
  'formulario-cadastro.txt': { formato: 'texto', rotulo: 'Formulário de cadastro', validar: (v) => validarTexto(v, 'O formulário') },
};

function ehEditavel(nome) {
  return Object.prototype.hasOwnProperty.call(ARQUIVOS, nome);
}

// ----------------------------------------------------------------------------
// Leitura com cache invalidado por mtime
// ----------------------------------------------------------------------------
const cache = new Map(); // nome -> { conteudo, origem, chave }

function caminhoVolume(nome) {
  return path.join(CONFIG_DIR, nome);
}

function caminhoAtual(nome) {
  const noVolume = caminhoVolume(nome);
  return fs.existsSync(noVolume) ? { caminho: noVolume, origem: 'painel' } : { caminho: path.join(RAIZ, nome), origem: 'repositorio' };
}

function parse(nome, bruto) {
  return ARQUIVOS[nome].formato === 'json' ? JSON.parse(bruto) : bruto;
}

function serializar(nome, conteudo) {
  return ARQUIVOS[nome].formato === 'json' ? `${JSON.stringify(conteudo, null, 2)}\n` : String(conteudo);
}

function ler(nome) {
  if (!ehEditavel(nome)) throw new Error(`Arquivo de configuração desconhecido: ${nome}`);
  const { caminho, origem } = caminhoAtual(nome);
  const stat = fs.statSync(caminho);
  const chave = `${caminho}:${stat.mtimeMs}:${stat.size}`;

  const emCache = cache.get(nome);
  if (emCache && emCache.chave === chave) return emCache.conteudo;

  const conteudo = parse(nome, fs.readFileSync(caminho, 'utf-8'));
  cache.set(nome, { conteudo, origem, chave });
  return conteudo;
}

// Leitura tolerante: se o arquivo do painel estiver quebrado (edição manual no
// volume, disco cheio no meio da escrita), volta pro do repositório em vez de
// derrubar o bot inteiro.
function lerSeguro(nome, padrao) {
  try {
    return ler(nome);
  } catch (err) {
    console.error(`Config: falha lendo "${nome}" (${err.message}) — tentando a versão do repositório`);
    try {
      return parse(nome, fs.readFileSync(path.join(RAIZ, nome), 'utf-8'));
    } catch (err2) {
      console.error(`Config: a versão do repositório de "${nome}" também falhou (${err2.message})`);
      return padrao;
    }
  }
}

function origemDe(nome) {
  return caminhoAtual(nome).origem;
}

function validar(nome, conteudo) {
  if (!ehEditavel(nome)) return { erros: [`Arquivo de configuração desconhecido: ${nome}`], avisos: [] };
  const contexto = { pdfs: nome === 'pdfs.json' ? conteudo : lerSeguro('pdfs.json', {}) };
  const { erros = [], avisos = [] } = ARQUIVOS[nome].validar(conteudo, contexto) || {};
  return { erros, avisos };
}

// Escrita atômica: grava num temporário e renomeia. Assim nunca existe um
// arquivo de configuração pela metade, mesmo se o processo morrer no meio.
function salvar(nome, conteudo) {
  const { erros, avisos } = validar(nome, conteudo);
  if (erros.length) return { ok: false, erros, avisos };

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const destino = caminhoVolume(nome);
  const temporario = `${destino}.tmp`;
  fs.writeFileSync(temporario, serializar(nome, conteudo));
  fs.renameSync(temporario, destino);
  cache.delete(nome);

  return { ok: true, erros: [], avisos, caminho: destino };
}

// Volta o arquivo pro que está no repositório (desfaz as edições do painel).
function restaurarPadrao(nome) {
  if (!ehEditavel(nome)) return { ok: false, erros: [`Arquivo desconhecido: ${nome}`] };
  const destino = caminhoVolume(nome);
  if (fs.existsSync(destino)) fs.unlinkSync(destino);
  cache.delete(nome);
  return { ok: true, conteudo: lerSeguro(nome, null) };
}

function listar() {
  return Object.entries(ARQUIVOS).map(([nome, meta]) => {
    const editado = fs.existsSync(caminhoVolume(nome));
    return {
      nome,
      rotulo: meta.rotulo,
      formato: meta.formato,
      origem: editado ? 'painel' : 'repositorio',
      editadoEm: editado ? fs.statSync(caminhoVolume(nome)).mtime.toISOString() : null,
    };
  });
}

// Atalhos usados pelo server.js no lugar das antigas constantes de boot.
const menu = () => lerSeguro('menu.json', { items: [], welcome_text: '', pdfs_boas_vindas: [] });
const pdfs = () => lerSeguro('pdfs.json', {});
const cabanas = () => lerSeguro('cabanas.json', { cabanas: [] }).cabanas || [];
const formularioCadastro = () => lerSeguro('formulario-cadastro.txt', '');

module.exports = {
  CONFIG_DIR,
  ARQUIVOS,
  ehEditavel,
  ler,
  lerSeguro,
  origemDe,
  validar,
  salvar,
  restaurarPadrao,
  listar,
  menu,
  pdfs,
  cabanas,
  formularioCadastro,
  caminhoVolume,
};
