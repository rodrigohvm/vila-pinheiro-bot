#!/usr/bin/env node
// Roda UMA vez, no seu computador, pra gerar o GOOGLE_REFRESH_TOKEN.
// Uso:
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/autorizar-drive.js

const http = require('http');
const readline = require('readline');
const { google } = require('googleapis');

const PORTA = 5599;
const REDIRECT_URI = `http://localhost:${PORTA}`;
const ESCOPO = ['https://www.googleapis.com/auth/drive.file'];

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('❌ Defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET antes de rodar.');
  process.exit(1);
}

const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);

const url = auth.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // força devolver refresh_token mesmo se você já autorizou antes
  scope: ESCOPO,
});

console.log('\n1) Abra este link no navegador e autorize:\n');
console.log(url);
console.log(`\n2) Depois de autorizar, você cai numa página em localhost:${PORTA}. Pode fechar.\n`);

async function trocarPorToken(code) {
  const { tokens } = await auth.getToken(code);
  if (!tokens.refresh_token) {
    console.error('\n❌ O Google não devolveu refresh_token. Revogue o acesso em https://myaccount.google.com/permissions e rode de novo.');
    process.exit(1);
  }
  console.log('\n✅ Pronto. Cole isto nas Variables do Railway:\n');
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  process.exit(0);
}

const servidor = http.createServer(async (req, res) => {
  const code = new URL(req.url, REDIRECT_URI).searchParams.get('code');
  if (!code) return res.end('Sem código na URL.');
  res.end('Autorizado. Pode fechar esta aba e voltar pro terminal.');
  servidor.close();
  try {
    await trocarPorToken(code);
  } catch (err) {
    console.error('❌ Falha ao trocar o código pelo token:', err.message);
    process.exit(1);
  }
});

servidor.on('error', () => {
  // Porta ocupada ou ambiente sem navegador: cai no modo manual.
  console.log(`(não consegui abrir a porta ${PORTA} — modo manual)`);
  perguntarCodigoNoTerminal();
});

servidor.listen(PORTA, () => {
  console.log(`Aguardando a autorização em ${REDIRECT_URI} ...`);
});

function perguntarCodigoNoTerminal() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Cole aqui o valor do parâmetro "code" da URL de retorno: ', async (code) => {
    rl.close();
    try {
      await trocarPorToken(code.trim());
    } catch (err) {
      console.error('❌ Falha ao trocar o código pelo token:', err.message);
      process.exit(1);
    }
  });
}
