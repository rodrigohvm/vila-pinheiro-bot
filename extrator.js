// ============================================================================
// EXTRATOR SEM IA
// ----------------------------------------------------------------------------
// Extrai os dados estruturados do cadastro de hóspede e da confirmação de
// reserva usando regras (regex), sem chamar a API da Anthropic.
//
// Como os dois textos são padronizados pela própria pousada (formulário fixo +
// modelo de resumo de reserva), dá pra ler os campos de forma determinística.
// A IA continua existindo como fallback no server.js, só pra quando o texto
// fugir muito do padrão.
// ============================================================================

// Pega o valor que vem depois de um rótulo (ex: "Nome completo: João" -> "João").
// Aceita variações de acento/caixa e ignora marcadores de lista (-, *, •) e
// negrito do WhatsApp (*texto*) antes do rótulo.
function extrairCampo(texto, rotulos) {
  const linhas = texto.split('\n');
  for (const linha of linhas) {
    // Remove marcadores de lista, asteriscos de negrito e espaços do começo
    const limpa = linha.replace(/^[\s\-*•▪️]+/, '').trim();
    for (const rotulo of rotulos) {
      // Monta um regex tolerante: "nome completo", "Nome Completo:", "*Nome completo*:"
      const rotuloRegex = rotulo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
      const match = limpa.match(new RegExp(`^\\*?\\s*${rotuloRegex}\\*?\\s*:\\s*(.*)$`, 'i'));
      if (match) {
        const valor = match[1].replace(/^[_*\s]+|[_*\s]+$/g, '').trim();
        if (valor) return valor;
      }
    }
  }
  return '';
}

// Encontra a primeira data no formato brasileiro dentro de um texto.
function extrairData(texto) {
  const match = texto.match(/\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/);
  return match ? match[1] : '';
}

// Encontra um CPF (com ou sem formatação).
function extrairCPF(texto) {
  const comMascara = texto.match(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/);
  if (comMascara) return comMascara[0];
  const semMascara = texto.match(/\b\d{11}\b/);
  return semMascara ? semMascara[0] : '';
}

function extrairEmail(texto) {
  const match = texto.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
  return match ? match[0] : '';
}

// Divide o texto do formulário em blocos por hóspede, pra não misturar os
// dados do hóspede 1 com os do hóspede 2 (ambos têm "Nome completo:" e "CPF:").
function separarBlocosDeHospede(texto) {
  const normalizado = texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const idxHospede2 = normalizado.search(/hospede\s*0?2/);
  const idxReserva = normalizado.search(/dados\s*da\s*reserva|cabana\s*:/);

  if (idxHospede2 === -1) {
    return { bloco1: idxReserva > -1 ? texto.slice(0, idxReserva) : texto, bloco2: '' };
  }
  const fimBloco2 = idxReserva > idxHospede2 ? idxReserva : texto.length;
  return {
    bloco1: texto.slice(0, idxHospede2),
    bloco2: texto.slice(idxHospede2, fimBloco2),
  };
}

function extrairHospede(bloco) {
  if (!bloco.trim()) return null;
  const nome = extrairCampo(bloco, ['nome completo', 'nome']);
  const cpfCampo = extrairCampo(bloco, ['cpf', 'documento cpf', 'documento']);
  const nascimentoCampo = extrairCampo(bloco, ['data de nascimento', 'nascimento']);

  const hospede = {
    nome,
    email: extrairCampo(bloco, ['e-mail', 'email']) || extrairEmail(bloco),
    cpf: cpfCampo || extrairCPF(bloco),
    nascimento: nascimentoCampo || '',
    endereco: extrairCampo(bloco, ['endereco completo com cep', 'endereço completo com cep', 'endereco completo', 'endereço completo', 'endereco', 'endereço']),
    celular: extrairCampo(bloco, ['celular', 'telefone', 'whatsapp']),
    redes_sociais: extrairCampo(bloco, ['redes sociais', 'instagram', 'rede social']),
  };

  // Só considera que existe hóspede se tiver pelo menos nome ou CPF
  if (!hospede.nome && !hospede.cpf) return null;
  return hospede;
}

// Detecta a opção marcada em "Como você nos conheceu?" — procura por
// "(x) Alguma opção" ou "(X) Alguma opção".
function extrairComoConheceu(texto) {
  const match = texto.match(/\(\s*[xX]\s*\)\s*(.+)/);
  if (!match) return '';
  return match[1].replace(/[_*]/g, '').trim();
}

// ----------------------------------------------------------------------------
// CADASTRO DE HÓSPEDE
// ----------------------------------------------------------------------------
function extrairCadastro(texto) {
  const { bloco1, bloco2 } = separarBlocosDeHospede(texto);

  const hospede1 = extrairHospede(bloco1);
  if (!hospede1) return null; // sem nome nem CPF, não dá pra confiar

  const checkin = extrairCampo(texto, ['data de check-in', 'data de check in', 'check-in', 'check in', 'checkin']);
  const checkout = extrairCampo(texto, ['data de check-out', 'data de check out', 'check-out', 'check out', 'checkout']);

  return {
    hospede1,
    hospede2: extrairHospede(bloco2),
    checkin: extrairData(checkin) || checkin,
    checkout: extrairData(checkout) || checkout,
    cabana: extrairCampo(texto, ['cabana escolhida', 'cabana preferida', 'cabana']),
    numero_hospedes: extrairCampo(texto, ['numero de hospedes na reserva', 'número de hóspedes na reserva', 'numero de hospedes', 'número de hóspedes', 'quantidade de hospedes']),
    data_comemorativa: extrairCampo(texto, ['alguma data comemorativa? qual?', 'alguma data comemorativa', 'data comemorativa']),
    como_conheceu: extrairComoConheceu(texto) || extrairCampo(texto, ['como conheceu a hospedaria', 'como voce nos conheceu', 'como você nos conheceu']),
  };
}

// ----------------------------------------------------------------------------
// CONFIRMAÇÃO DE RESERVA
// ----------------------------------------------------------------------------

// Extrai as parcelas do modelo:
//   ▪️1ª parcela: 10/08/26 - R$ 900,00
//   ▪️2ª parcela: 10/09/26 - R$ 900,00
function extrairParcelas(texto) {
  const parcelas = [];
  const linhas = texto.split('\n');
  for (const linha of linhas) {
    const ehParcela = /\d\s*[ªa]?\s*parcela/i.test(linha);
    if (!ehParcela) continue;
    const valor = linha.match(/R\$\s*[\d.,]+/);
    const data = linha.match(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/);
    parcelas.push({
      valor: valor ? valor[0].trim() : '',
      data: data ? data[0] : '',
      paga: false, // sempre nasce como não paga; a equipe confirma depois no CRM
    });
  }
  return parcelas;
}

function extrairReserva(texto) {
  const hospede = extrairCampo(texto, ['hospede', 'hóspede']);
  const checkinCampo = extrairCampo(texto, ['check in', 'check-in', 'checkin']);
  const checkoutCampo = extrairCampo(texto, ['check out', 'check-out', 'checkout']);

  if (!hospede && !checkinCampo) return null;

  // "Valor" pode vir na mesma linha de outra coisa (ex: "- Quantidade diárias e
  // dia da semana: 2 diárias - Valor: R$ 1.800,00"), então além de procurar
  // pelo rótulo no começo da linha, procuramos o padrão "Valor: R$ ..." em
  // qualquer posição do texto.
  let valorTotal = '';
  const valorInline = texto.match(/valor\s*(?:total)?\s*:\s*(R\$\s*[\d.,]+)/i);
  if (valorInline) {
    valorTotal = valorInline[1].trim();
  } else {
    const valorCampo = extrairCampo(texto, ['valor total', 'valor']);
    const valorMatch = valorCampo.match(/R\$\s*[\d.,]+/);
    valorTotal = valorMatch ? valorMatch[0].trim() : valorCampo;
  }

  // Mesma ideia pra quantidade de diárias: pega só o número de diárias, sem
  // arrastar o resto da linha junto.
  let numeroDiarias = extrairCampo(texto, ['quantidade diarias e dia da semana', 'quantidade diárias e dia da semana', 'quantidade de diarias', 'quantidade de diárias', 'diarias', 'diárias']);
  const diariasMatch = numeroDiarias.match(/(\d+)\s*di[áa]ria/i);
  if (diariasMatch) numeroDiarias = diariasMatch[1];

  const dataReservaCampo = extrairCampo(texto, ['data da reserva', 'data reserva', 'data do fechamento', 'fechamento']);

  return {
    data_reserva: extrairData(dataReservaCampo) || dataReservaCampo,
    valor_total: valorTotal,
    forma_pagamento: extrairCampo(texto, ['forma de pagamento', 'pagamento']),
    parcelas: extrairParcelas(texto),
    hospede,
    checkin: extrairData(checkinCampo) || checkinCampo,
    checkout: extrairData(checkoutCampo) || checkoutCampo,
    cabana: extrairCampo(texto, ['cabana']),
    numero_diarias: numeroDiarias,
    canal_venda: extrairCampo(texto, ['canal de venda', 'canal']),
    adicionais: extrairCampo(texto, ['ocasioes/adicionais', 'ocasiões/adicionais', 'ocasioes', 'ocasiões', 'adicionais']),
  };
}

// Ponto de entrada único, espelhando a assinatura da extração via IA.
function extrairSemIA(texto, tipo) {
  try {
    return tipo === 'cadastro' ? extrairCadastro(texto) : extrairReserva(texto);
  } catch (err) {
    console.error('Erro na extração sem IA:', err.message);
    return null;
  }
}

module.exports = { extrairSemIA, extrairCadastro, extrairReserva };
