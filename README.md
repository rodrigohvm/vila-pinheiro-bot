# Assistente de IA — Vila Pinheiro Cabanas

Este é um programinha que responde automaticamente clientes no WhatsApp e no Instagram,
usando a Claude para responder dúvidas (FAQ) e avisando você quando alguém quer fechar reserva.

Ele **não fecha reservas nem cobra pagamento** — só tira dúvidas e sinaliza quando o
humano (você) precisa entrar na conversa.

---

## Testando em 2 etapas (recomendado)

Você pode validar tudo em duas fases, sem precisar da IA logo de cara:

**Etapa A — só o menu fixo (sem custo, sem risco de erro)**
Deixe a linha `ANTHROPIC_API_KEY=` em branco no `.env`/Railway. O bot funciona
normalmente: responde o menu, as palavras-chave, envia PDFs. Se o cliente perguntar
algo fora do roteiro, ele recebe uma mensagem padrão avisando que o time vai
responder, e isso aparece no painel `/admin/escalations` pra você saber.
Ótimo pra testar toda a parte de WhatsApp/Instagram/Railway sem se preocupar com a
Claude ainda.

**Etapa B — ligar a IA**
Quando estiver satisfeito com o menu, é só preencher `ANTHROPIC_API_KEY` com a chave
real (Fase 1 do guia) nas Variables do Railway e reiniciar o serviço (o Railway
reinicia sozinho quando você salva uma variável nova). A partir daí, perguntas fora
do menu passam a ser respondidas pela Claude automaticamente — sem precisar mexer em
mais nada no código.

## Passo 1 — Preencher as informações da pousada

Abra o arquivo `system-prompt.txt` e preencha os campos entre colchetes `[ ]` com as
informações reais da Vila Pinheiro (preços, políticas, comodidades, etc.). Esse texto é
o "cérebro" do assistente — quanto mais completo, melhores as respostas.

## Passo 2 — Criar a chave da API da Claude

1. Acesse https://console.anthropic.com e crie uma conta (se ainda não tiver).
2. Vá em **Settings → API Keys** e crie uma chave nova.
3. Guarde essa chave, você vai colar no arquivo `.env` daqui a pouco.

## Passo 3 — Configurar o WhatsApp Cloud API (Meta)

1. Acesse https://developers.facebook.com e crie um "App" do tipo Business.
2. Dentro do app, adicione o produto **WhatsApp**.
3. Na aba do WhatsApp, você vai encontrar:
   - **Token de acesso temporário** (depois trocamos por um permanente)
   - **Phone Number ID** (ID do número de teste ou do seu número real)
4. Anote os dois valores.

## Passo 4 — Configurar o Instagram (opcional, mesmo app da Meta)

1. No mesmo App da Meta, adicione o produto **Messenger** (o Instagram Direct usa a
   mesma infraestrutura do Messenger).
2. Conecte a Página do Facebook que está vinculada ao seu Instagram profissional.
3. Gere o **Page Access Token** dessa página.

## Passo 5 — Preencher o arquivo `.env`

1. Duplique o arquivo `.env.example` e renomeie a cópia para `.env`.
2. Preencha cada linha com os valores que você anotou nos passos anteriores.
3. Em `WHATSAPP_VERIFY_TOKEN` e `ADMIN_KEY`, invente senhas simples (só você precisa saber).

## Passo 6 — Publicar o servidor (deixá-lo "sempre ligado")

A forma mais simples é usar o **Railway** (tem plano gratuito para começar):

1. Crie uma conta em https://railway.app (dá para entrar com GitHub).
2. Clique em **New Project → Deploy from GitHub repo** (ou "Empty Project" e depois
   "Deploy from local folder" se preferir subir os arquivos direto).
3. Suba esta pasta inteira (`vila-pinheiro-bot`).
4. Em **Variables**, cole todo o conteúdo do seu arquivo `.env` (Railway tem um campo
   para colar várias variáveis de uma vez).
5. O Railway vai te dar uma URL pública, algo como:
   `https://vila-pinheiro-bot-production.up.railway.app`

## Como funciona o fluxo híbrido (menu fixo + IA só quando necessário)

Pra economizar ao máximo, o assistente segue esta ordem a cada mensagem recebida:

1. **Bate com uma palavra-chave do menu?** (ex: cliente digitou "preço", "cancelamento", "wifi") → responde na hora com o texto pronto do `menu.json`. **Não gasta nada com IA.**
2. **É a primeira mensagem desse cliente e não bateu com nada?** → manda o menu de opções (lista de botões no WhatsApp, texto numerado no Instagram). **Não gasta nada com IA.**
3. **Só se a pergunta fugir completamente do roteiro** (ex: "vocês tem cabana com banheira de hidromassagem para 6 pessoas em outubro?") → aí sim a Claude entra, entende a pergunta livre e responde.

Ou seja: a IA só é chamada (e só gera custo) nas perguntas realmente fora do script — a maioria das dúvidas simples é respondida de graça pelo menu.

### Como editar o menu

Abra o arquivo `menu.json`. Cada item tem:
- `"title"`: o texto que aparece no botão do WhatsApp (máx. 24 caracteres).
- `"aliases"`: lista de palavras que, se aparecerem na mensagem do cliente, disparam essa resposta automaticamente.
- `"response"`: o texto que será enviado.
- `"pdf"` (opcional): o apelido de um PDF (do `pdfs.json`) para enviar junto.
- `"escalate"` (opcional, `true`/`false`): se `true`, essa opção também aparece no painel de `/admin/escalations`, avisando que o cliente quer ser atendido por humano.

Você pode adicionar quantos itens quiser, sem precisar mexer no código.

## Passo 7 — Conectar o webhook na Meta

1. Volte no painel do App da Meta, na seção **WhatsApp → Configuration → Webhook**.
2. Cole a URL: `https://SEU-ENDERECO-RAILWAY.up.railway.app/webhook/whatsapp`
3. No campo "Verify Token", cole o mesmo valor que você colocou em `WHATSAPP_VERIFY_TOKEN` no `.env`.
4. Clique em "Verify and Save". Se der certo, aparece um ✅.
5. Marque para receber o campo `messages`.
6. Repita o mesmo processo na seção do **Messenger/Instagram**, usando a URL
   `/webhook/instagram` e o `INSTAGRAM_VERIFY_TOKEN`.

## Passo 7.5 — Configurar envio automático de PDFs (tabela de preços, mapa, etc.)

1. Suba o PDF no seu Google Drive.
2. Clique com o botão direito → **Compartilhar** → mude para **"Qualquer pessoa com o link"** → papel **"Leitor"**. Isso é essencial: se o link não for público, o envio automático não funciona.
3. Copie o link (algo como `https://drive.google.com/file/d/1AbCdEfGhIj/view?usp=sharing`).
4. Abra o arquivo `pdfs.json` e cole o link na chave correspondente, por exemplo:
   ```json
   {
     "tabela-precos": "https://drive.google.com/file/d/1AbCdEfGhIj/view?usp=sharing",
     "mapa-acesso": "https://drive.google.com/file/d/9XyZ...abc/view?usp=sharing"
   }
   ```
5. Se quiser adicionar outros PDFs além desses dois, é só criar uma nova linha em
   `pdfs.json` com um apelido novo (ex: `"cardapio-cafe": "https://..."`) e mencionar
   esse apelido no `system-prompt.txt`, seguindo o mesmo padrão das outras tags
   `[ENVIAR_PDF:apelido]`.
6. O sistema converte automaticamente o link do Google Drive para um formato de
   download direto — você só precisa colar o link normal de compartilhamento.

⚠️ Atenção: como o link é público, qualquer pessoa que tiver a URL consegue ver o
PDF (não precisa ser cliente). Não coloque documentos sigilosos nessa pasta.

## Passo 8 — Testar

Mande uma mensagem de WhatsApp para o número configurado. O assistente deve responder
em poucos segundos, usando as informações que você colocou no `system-prompt.txt`.

## Como ver quando um cliente quer reservar

Acesse no navegador:
`https://SEU-ENDERECO-RAILWAY.up.railway.app/admin/escalations?key=SUA_ADMIN_KEY`

Isso mostra a lista de conversas em que o assistente identificou que o cliente quer
fechar reserva — é o sinal para você entrar pessoalmente na conversa.

---

## Limitações desta primeira versão (para você saber)

- A "memória" das conversas fica só no servidor, e se ele reiniciar, o histórico recente
  se perde (o cliente pode ter que repetir alguma informação).
- O aviso de "cliente quer reservar" fica numa página simples — não manda notificação
  automática pro seu celular ainda. Dá pra evoluir isso depois (ex: te avisar por
  e-mail ou WhatsApp automaticamente).
- Vale testar bastante o `system-prompt.txt` nas primeiras semanas e ajustar conforme
  as perguntas reais dos clientes forem aparecendo.

Se quiser, posso te ajudar a evoluir isso depois: notificações automáticas, integração
com uma agenda de disponibilidade, painel mais bonito, etc.
