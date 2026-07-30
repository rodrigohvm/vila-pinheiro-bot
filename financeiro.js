// ============================================================================
// Funções puras — financeiro, dashboard, clientes, ICS
// (sem dependências de rede/fs, pra poder testar isoladamente)
// ============================================================================

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// "R$ 3.500,00" | "3500,00" | "1.200" | "3500.50" | "3500" -> number
// Regra: o separador decimal é o que aparece por último (mais à direita).
// Dot sem vírgula E com 3 dígitos depois (ex: "1.200") é tratado como milhar, não decimal.
function parseValorBR(str) {
  if (typeof str === 'number') return str;
  if (!str) return 0;
  let s = String(str).replace(/[^\d,.-]/g, '');
  if (!s) return 0;

  const ultimaVirgula = s.lastIndexOf(',');
  const ultimoPonto = s.lastIndexOf('.');

  if (ultimaVirgula === -1 && ultimoPonto === -1) {
    // só dígitos
  } else if (ultimaVirgula > ultimoPonto) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (ultimoPonto > ultimaVirgula) {
    const digitosDepois = s.length - ultimoPonto - 1;
    if (digitosDepois === 2) {
      s = s.slice(0, ultimoPonto).replace(/\./g, '') + '.' + s.slice(ultimoPonto + 1);
    } else {
      s = s.replace(/\./g, '');
    }
  }

  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function formatValorBRL(n) {
  return (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Garante que cada parcela tenha um campo "paga" (default false) e um "valor_num".
function normalizeParcelas(parcelas) {
  if (!Array.isArray(parcelas)) return [];
  return parcelas.map((p) => ({
    valor: p.valor ?? '',
    valor_num: parseValorBR(p.valor),
    data: p.data ?? '',
    data_iso: normalizeDateBR(p.data),
    paga: Boolean(p.paga),
  }));
}

// Duplicada aqui só pra teste isolado (no server.js real, reaproveita a existente)
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

// Status derivado a partir das parcelas (não é mais um campo solto e sim calculado)
function computeStatusPagamento(dados, hojeISO) {
  const parcelas = normalizeParcelas(dados?.parcelas);
  if (parcelas.length === 0) return 'pendente';

  const todasPagas = parcelas.every((p) => p.paga);
  if (todasPagas) return 'pago';

  const temAtrasada = parcelas.some((p) => !p.paga && p.data_iso && p.data_iso < hojeISO);
  if (temAtrasada) return 'atrasado';

  const algumaPaga = parcelas.some((p) => p.paga);
  return algumaPaga ? 'parcial' : 'pendente';
}

// Normalização leve pra usar no momento de SALVAR/ATUALIZAR um registro:
// só garante que cada parcela tenha um "paga" (default false), sem tocar em
// mais nada. A normalização "pesada" (valor_num, data_iso) é feita só na
// leitura, em computeStatusPagamento/buildDashboard/etc, pra nunca ficar
// desatualizada em relação ao que está de fato salvo.
function ensureParcelaDefaults(dados) {
  if (!dados || !Array.isArray(dados.parcelas)) return dados;
  dados.parcelas = dados.parcelas.map((p) => ({ ...p, paga: Boolean(p.paga) }));
  return dados;
}

// Enriquece um registro tipo "reserva" com campos calculados pra exibição
// (não deve ser persistido — só usado nas respostas da API).
function enrichRegistro(registro, hojeISO = new Date().toISOString().slice(0, 10)) {
  if (registro.tipo !== 'reserva') return registro;
  const parcelas = normalizeParcelas(registro.dados?.parcelas);
  return {
    ...registro,
    dados: {
      ...registro.dados,
      valor_total_num: parseValorBR(registro.dados?.valor_total),
      parcelas,
      status_pagamento: computeStatusPagamento(registro.dados, hojeISO),
    },
  };
}

// ----------------------------------------------------------------------------
// Dashboard: ocupação atual, próximos eventos, receita
// ----------------------------------------------------------------------------
// Uma "estadia" pode gerar 2 registros (cadastro do hóspede + confirmação da
// equipe). Dedupe por cabana+checkin+checkout pra não contar/listar 2x,
// preferindo o telefone (só o cadastro tem) e o nome mais completo.
function dedupeEstadias(comDatas) {
  const porChave = new Map();
  for (const r of comDatas) {
    const chave = `${normalize(r.dados?.cabana || '')}|${r.checkin_iso}|${r.checkout_iso}`;
    const hospede = r.tipo === 'cadastro' ? r.dados?.hospede1?.nome : r.dados?.hospede;
    const atual = porChave.get(chave);
    if (!atual) {
      porChave.set(chave, {
        cabana: r.dados?.cabana || '(sem cabana)',
        hospede: hospede || '(sem nome)',
        telefone: r.telefone || null,
        checkin_iso: r.checkin_iso,
        checkout_iso: r.checkout_iso,
        checkin: r.dados?.checkin || r.checkin_iso,
        checkout: r.dados?.checkout || r.checkout_iso,
      });
    } else {
      if (!atual.telefone && r.telefone) atual.telefone = r.telefone;
      if (atual.hospede === '(sem nome)' && hospede) atual.hospede = hospede;
    }
  }
  return [...porChave.values()];
}

function buildDashboard(registros, cabanasList, hoje = new Date()) {
  const hojeISO = hoje.toISOString().slice(0, 10);
  const em7dias = new Date(hoje);
  em7dias.setDate(em7dias.getDate() + 7);
  const em7ISO = em7dias.toISOString().slice(0, 10);

  const comDatas = registros.filter((r) => r.checkin_iso && r.checkout_iso);
  const estadias = dedupeEstadias(comDatas);

  // Ocupação atual (hoje está entre checkin e checkout)
  const ocupacaoAtual = estadias
    .filter((e) => e.checkin_iso <= hojeISO && hojeISO < e.checkout_iso)
    .map((e) => ({ cabana: e.cabana, hospede: e.hospede, checkout: e.checkout }));

  // Próximos check-ins/checkouts (7 dias)
  const proximosCheckins = estadias
    .filter((e) => e.checkin_iso >= hojeISO && e.checkin_iso <= em7ISO)
    .map((e) => ({ tipo: 'checkin', data_iso: e.checkin_iso, cabana: e.cabana, hospede: e.hospede, telefone: e.telefone }))
    .sort((a, b) => a.data_iso.localeCompare(b.data_iso));

  const proximosCheckouts = estadias
    .filter((e) => e.checkout_iso >= hojeISO && e.checkout_iso <= em7ISO)
    .map((e) => ({ tipo: 'checkout', data_iso: e.checkout_iso, cabana: e.cabana, hospede: e.hospede, telefone: e.telefone }))
    .sort((a, b) => a.data_iso.localeCompare(b.data_iso));

  // Financeiro (apenas registros tipo "reserva", que têm valores)
  const reservas = registros.filter((r) => r.tipo === 'reserva');
  let totalConfirmado = 0;
  let totalPago = 0;
  let totalAtrasado = 0;

  for (const r of reservas) {
    const parcelas = normalizeParcelas(r.dados?.parcelas);
    const valorTotal = parseValorBR(r.dados?.valor_total);
    totalConfirmado += valorTotal;
    for (const p of parcelas) {
      if (p.paga) totalPago += p.valor_num;
      else if (p.data_iso && p.data_iso < hojeISO) totalAtrasado += p.valor_num;
    }
  }
  const totalPendente = Math.max(0, totalConfirmado - totalPago - totalAtrasado);

  // De onde vieram as reservas (canal de venda) e quanto cada canal gerou.
  const canaisMap = new Map();
  for (const r of reservas) {
    const canal = (r.dados?.canal_venda || '').trim() || 'Não informado';
    const atual = canaisMap.get(canal) || { canal, quantidade: 0, receita: 0 };
    atual.quantidade += 1;
    atual.receita += parseValorBR(r.dados?.valor_total);
    canaisMap.set(canal, atual);
  }
  const canaisVenda = [...canaisMap.values()].sort((a, b) => b.quantidade - a.quantidade);

  // Taxa de ocupação do mês corrente
  const ano = hoje.getFullYear();
  const mes = hoje.getMonth();
  const diasNoMes = new Date(ano, mes + 1, 0).getDate();
  const totalCabanas = Math.max(1, cabanasList.length);
  let diasCabanaOcupados = 0;

  for (let d = 1; d <= diasNoMes; d++) {
    const diaISO = new Date(ano, mes, d).toISOString().slice(0, 10);
    const cabanasOcupadasNoDia = new Set(
      comDatas
        .filter((r) => r.checkin_iso <= diaISO && diaISO < r.checkout_iso)
        .map((r) => normalize(r.dados?.cabana || ''))
    );
    diasCabanaOcupados += cabanasOcupadasNoDia.size;
  }
  const taxaOcupacaoMes = Math.round((diasCabanaOcupados / (diasNoMes * totalCabanas)) * 1000) / 10;

  return {
    hoje: hojeISO,
    ocupacaoAtual,
    proximosCheckins,
    proximosCheckouts,
    financeiro: {
      totalConfirmado,
      totalPago,
      totalPendente,
      totalAtrasado,
    },
    canaisVenda,
    taxaOcupacaoMes,
  };
}

// ----------------------------------------------------------------------------
// Clientes: agrega registros (cadastro + reserva) por hóspede.
// Match primário: telefone normalizado (só cadastro tem telefone).
// Match secundário (pra ligar reservas, que não têm telefone): nome normalizado.
// É um "join" feito em tempo de leitura — não altera os dados salvos.
// ----------------------------------------------------------------------------
function buildClientes(registros) {
  const porTelefone = new Map(); // telefone -> cliente
  const semTelefonePorNome = new Map(); // nome normalizado -> cliente

  function getOuCriaPorTelefone(telefone, base) {
    if (!porTelefone.has(telefone)) {
      porTelefone.set(telefone, { nome: '', telefone, email: '', cpf: '', endereco: '', estadias: [] });
    }
    return porTelefone.get(telefone);
  }

  function getOuCriaPorNome(nomeNormalizado) {
    if (!semTelefonePorNome.has(nomeNormalizado)) {
      semTelefonePorNome.set(nomeNormalizado, {
        nome: '',
        telefone: null,
        email: '',
        cpf: '',
        endereco: '',
        estadias: [],
        semTelefone: true,
      });
    }
    return semTelefonePorNome.get(nomeNormalizado);
  }

  // 1ª passada: cadastros (têm telefone garantido)
  for (const r of registros) {
    if (r.tipo !== 'cadastro') continue;
    const h1 = r.dados?.hospede1;
    if (!r.telefone) continue;
    const cliente = getOuCriaPorTelefone(r.telefone);
    if (h1?.nome) cliente.nome = h1.nome;
    if (h1?.email) cliente.email = h1.email;
    if (h1?.cpf) cliente.cpf = h1.cpf;
    if (h1?.endereco) cliente.endereco = h1.endereco;
    cliente.estadias.push({
      tipo: 'cadastro',
      cabana: r.dados?.cabana || '',
      checkin: r.dados?.checkin || '',
      checkout: r.dados?.checkout || '',
    });
  }

  // 2ª passada: reservas — tenta casar pelo nome com um cliente já conhecido (por telefone);
  // se não achar, agrupa só por nome (fica marcado semTelefone: true).
  for (const r of registros) {
    if (r.tipo !== 'reserva') continue;
    const nomeReserva = normalize(r.dados?.hospede || '');
    if (!nomeReserva) continue;

    let clienteExistente = [...porTelefone.values()].find(
      (c) => c.nome && (normalize(c.nome) === nomeReserva || normalize(c.nome).includes(nomeReserva) || nomeReserva.includes(normalize(c.nome)))
    );

    const cliente = clienteExistente || getOuCriaPorNome(nomeReserva);
    if (!cliente.nome) cliente.nome = r.dados?.hospede;
    cliente.estadias.push({
      tipo: 'reserva',
      cabana: r.dados?.cabana || '',
      checkin: r.dados?.checkin || '',
      checkout: r.dados?.checkout || '',
      valor_total: r.dados?.valor_total || '',
      status_pagamento: computeStatusPagamento(r.dados, new Date().toISOString().slice(0, 10)),
    });
  }

  return [...porTelefone.values(), ...semTelefonePorNome.values()];
}

// ----------------------------------------------------------------------------
// Feed .ics (somente leitura) pra assinar no Google Agenda/Apple Calendar/Outlook
// ----------------------------------------------------------------------------
function buildICSFeed(registros) {
  const linhas = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Vila Pinheiro Cabanas//Ocupacao//PT-BR',
    'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:Vila Pinheiro - Ocupação',
  ];

  const comDatas = registros.filter((r) => r.checkin_iso && r.checkout_iso);
  const estadias = dedupeEstadias(comDatas);

  for (const e of estadias) {
    const dtStart = e.checkin_iso.replace(/-/g, '');
    const dtEnd = e.checkout_iso.replace(/-/g, '');
    const uid = `${normalize(e.cabana)}-${e.checkin_iso}-${e.checkout_iso}@vilapinheiro`;
    linhas.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTART;VALUE=DATE:${dtStart}`,
      `DTEND;VALUE=DATE:${dtEnd}`,
      `SUMMARY:${escapeICS(`${e.cabana} — ${e.hospede}`)}`,
      'END:VEVENT'
    );
  }

  linhas.push('END:VCALENDAR');
  return linhas.join('\r\n');
}

function escapeICS(text) {
  return String(text).replace(/([,;])/g, '\\$1');
}

module.exports = {
  normalize,
  parseValorBR,
  formatValorBRL,
  normalizeDateBR,
  normalizeParcelas,
  ensureParcelaDefaults,
  enrichRegistro,
  computeStatusPagamento,
  buildDashboard,
  buildClientes,
  buildICSFeed,
};
