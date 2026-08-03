// ============================================================================
// Funções puras — financeiro, dashboard, clientes, ICS
// (sem dependências de rede/fs, pra poder testar isoladamente)
// ============================================================================

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
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

// ----------------------------------------------------------------------------
// Sobreposição de datas na MESMA cabana NUNCA é normal — a cabana só comporta
// uma estadia por vez (sair e entrar no mesmo dia é permitido: o checkout é dia
// de saída).
//
// A única exceção é o par de registros da MESMA estadia: o cadastro do hóspede
// + a confirmação da equipe. Pra ser o mesmo par, as datas precisam bater
// EXATAMENTE e o nome precisa ser o mesmo. Qualquer sobreposição fora disso é
// alertada, com dois motivos possíveis:
//   • overbooking  — pessoas diferentes disputando a mesma cabana
//   • divergencia  — mesma pessoa com datas que não batem entre um registro e
//                    outro (erro de digitação / remarcação pela metade)
// ----------------------------------------------------------------------------
function nomeDoRegistro(r) {
  return normalize(r.tipo === 'cadastro' ? r.dados?.hospede1?.nome || '' : r.dados?.hospede || '');
}

function mesmaPessoa(a, b) {
  const nomeA = nomeDoRegistro(a);
  const nomeB = nomeDoRegistro(b);
  if (!nomeA || !nomeB) return false;
  return nomeA === nomeB || nomeA.includes(nomeB) || nomeB.includes(nomeA);
}

function datasIdenticas(a, b) {
  return a.checkin_iso === b.checkin_iso && a.checkout_iso === b.checkout_iso;
}

// Se um dos registros não tem nome, não dá pra afirmar que são pessoas
// diferentes — com datas idênticas na mesma cabana, o cenário provável é o par
// cadastro+confirmação, não overbooking.
function mesmaPessoaOuSemNome(a, b) {
  if (!nomeDoRegistro(a) || !nomeDoRegistro(b)) return true;
  return mesmaPessoa(a, b);
}

// Os dois registros descrevem a MESMA estadia (cadastro + confirmação, ou uma
// duplicata colada 2x). Só isso pode ser fundido numa linha só.
function mesmaEstadia(a, b) {
  return datasIdenticas(a, b) && mesmaPessoaOuSemNome(a, b);
}

function datasSobrepoem(a, b) {
  // Checkout é dia de saída: sair e entrar no mesmo dia NÃO é conflito.
  return a.checkin_iso < b.checkout_iso && b.checkin_iso < a.checkout_iso;
}

function motivoDoAlerta(a, b) {
  return mesmaPessoa(a, b) ? 'divergencia' : 'overbooking';
}

const MOTIVOS = {
  overbooking: 'Duas estadias diferentes na mesma cabana com datas sobrepostas',
  divergencia: 'Mesmo hóspede, mesma cabana, datas que não batem entre os registros — provável erro de digitação',
};

// Devolve um Map: id do registro -> lista de conflitos encontrados.
function detectarConflitos(registros) {
  const validos = registros.filter((r) => r.checkin_iso && r.checkout_iso && r.dados?.cabana);
  const conflitos = new Map();

  function registrar(r, outro, motivo) {
    if (!conflitos.has(r.id)) conflitos.set(r.id, []);
    conflitos.get(r.id).push({
      id: outro.id,
      tipo: outro.tipo,
      motivo,
      motivo_texto: MOTIVOS[motivo],
      hospede: outro.tipo === 'cadastro' ? outro.dados?.hospede1?.nome || '(sem nome)' : outro.dados?.hospede || '(sem nome)',
      cabana: outro.dados?.cabana,
      checkin: outro.dados?.checkin || outro.checkin_iso,
      checkout: outro.dados?.checkout || outro.checkout_iso,
    });
  }

  for (let i = 0; i < validos.length; i++) {
    for (let j = i + 1; j < validos.length; j++) {
      const a = validos[i];
      const b = validos[j];
      if (normalize(a.dados.cabana) !== normalize(b.dados.cabana)) continue;
      if (!datasSobrepoem(a, b)) continue;
      if (mesmaEstadia(a, b)) continue;
      const motivo = motivoDoAlerta(a, b);
      registrar(a, b, motivo);
      registrar(b, a, motivo);
    }
  }

  return conflitos;
}

// Checa se uma estadia NOVA (ainda não salva) bate com alguma já existente.
function conflitosDeUmaEstadia(novo, registros) {
  if (!novo.checkin_iso || !novo.checkout_iso || !novo.dados?.cabana) return [];
  return registros
    .filter((r) => r.id !== novo.id && r.checkin_iso && r.checkout_iso && r.dados?.cabana)
    .filter((r) => normalize(r.dados.cabana) === normalize(novo.dados.cabana))
    .filter((r) => datasSobrepoem(r, novo))
    .filter((r) => !mesmaEstadia(r, novo))
    .map((r) => ({
      id: r.id,
      tipo: r.tipo,
      motivo: motivoDoAlerta(r, novo),
      motivo_texto: MOTIVOS[motivoDoAlerta(r, novo)],
      hospede: r.tipo === 'cadastro' ? r.dados?.hospede1?.nome || '(sem nome)' : r.dados?.hospede || '(sem nome)',
      cabana: r.dados.cabana,
      checkin: r.dados?.checkin || r.checkin_iso,
      checkout: r.dados?.checkout || r.checkout_iso,
    }));
}

// ----------------------------------------------------------------------------
// Parcelas: quais merecem um lembrete HOJE pra equipe.
// Duas situações: "vence em até N dias" e "já venceu". Cada uma dispara uma
// única vez por parcela — o controle de "já avisei" fica no registro
// (campo lembretesParcela), não aqui.
// ----------------------------------------------------------------------------
function somarDiasISO(iso, dias) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function listarParcelasParaLembrar(registros, hojeISO, diasDeAntecedencia = 3) {
  const limite = somarDiasISO(hojeISO, diasDeAntecedencia);
  const pendencias = [];

  for (const r of registros) {
    if (r.tipo !== 'reserva') continue;
    const parcelas = normalizeParcelas(r.dados?.parcelas);
    const jaAvisado = r.lembretesParcela || {};

    parcelas.forEach((p, indice) => {
      if (p.paga || !p.data_iso) return;

      const situacao = p.data_iso < hojeISO ? 'atrasada' : p.data_iso <= limite ? 'a_vencer' : null;
      if (!situacao) return;

      const chave = `${indice}:${situacao}`;
      if (jaAvisado[chave]) return;

      pendencias.push({
        registroId: r.id,
        chave,
        situacao,
        indice,
        numero: indice + 1,
        total: parcelas.length,
        valor: p.valor,
        valor_num: p.valor_num,
        vencimento: p.data || p.data_iso,
        vencimento_iso: p.data_iso,
        hospede: r.dados?.hospede || '(sem nome)',
        cabana: r.dados?.cabana || '(sem cabana)',
      });
    });
  }

  return pendencias.sort((a, b) => a.vencimento_iso.localeCompare(b.vencimento_iso));
}

function montarMensagemCobranca(pendencias) {
  const atrasadas = pendencias.filter((p) => p.situacao === 'atrasada');
  const aVencer = pendencias.filter((p) => p.situacao === 'a_vencer');
  const linhas = ['💰 *Parcelas pra acompanhar hoje*'];

  function bloco(titulo, lista) {
    if (!lista.length) return;
    linhas.push('', titulo);
    for (const p of lista) {
      linhas.push(`• ${p.hospede} — ${p.cabana}\n  Parcela ${p.numero}/${p.total} · ${p.valor || formatValorBRL(p.valor_num)} · vence ${p.vencimento}`);
    }
  }

  bloco('🔴 *Em atraso:*', atrasadas);
  bloco('🟡 *Vencendo nos próximos dias:*', aVencer);
  linhas.push('', 'Marque como paga no CRM depois de confirmar o recebimento.');
  return linhas.join('\n');
}

// ----------------------------------------------------------------------------
// ESTADIA = visão fundida (cadastro do hóspede + confirmação da equipe) de uma
// mesma hospedagem. A fusão acontece SÓ NA LEITURA — os registros crus continuam
// separados no registros.json, e cada um segue alimentando sua automação
// (lembrete de véspera vem do cadastro; cobrança de parcela vem da reserva).
//
// A regra de agrupamento é o espelho exato da regra de conflito: mesma cabana +
// datas sobrepostas + (datas idênticas OU mesmo hóspede). Assim, o que NÃO é
// conflito é a mesma estadia, e vice-versa — os dois nunca se contradizem.
// ----------------------------------------------------------------------------
const ESTAGIOS = {
  aguardando: { label: 'Aguardando confirmação', emoji: '🟡' },
  confirmada: { label: 'Confirmada', emoji: '🔵' },
  paga: { label: 'Paga', emoji: '🟢' },
};

function mesmaCabana(a, b) {
  return normalize(a.dados?.cabana || '') === normalize(b.dados?.cabana || '');
}

function agrupavel(a, b) {
  if (!a.checkin_iso || !a.checkout_iso || !b.checkin_iso || !b.checkout_iso) return false;
  if (!a.dados?.cabana || !b.dados?.cabana) return false;
  // Datas iguais + mesma pessoa + mesma cabana. Sobreposição PARCIAL nunca
  // funde: vira alerta, porque a cabana não pode receber duas estadias ao
  // mesmo tempo e ninguém deve descobrir isso só na chegada do hóspede.
  return mesmaCabana(a, b) && mesmaEstadia(a, b);
}

function agruparPorEstadia(registros) {
  const grupos = [];
  for (const r of registros) {
    const grupo = grupos.find((g) => g.some((x) => agrupavel(x, r)));
    if (grupo) grupo.push(r);
    else grupos.push([r]);
  }
  return grupos;
}

// Estágio ≠ status de pagamento: são eixos diferentes. Uma reserva com uma
// parcela paga e outra em atraso é 🟢 Paga no estágio e "atrasado" no badge de
// pagamento — por isso olhamos as parcelas, não o status derivado.
function calcularEstagio(temReserva, parcelas) {
  if (!temReserva) return 'aguardando';
  return (parcelas || []).some((p) => p.paga) ? 'paga' : 'confirmada';
}

function maisRecente(lista) {
  if (!lista.length) return null;
  return [...lista].sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')))[lista.length - 1];
}

// Entre registros duplicados do mesmo tipo, o "principal" é o mais recente que
// realmente tem o dado que importa (telefone no cadastro, parcelas na reserva).
// Sem isso, uma confirmação colada 2x poderia eleger a cópia sem parcelas e o
// CRM mostraria "sem cobrança" enquanto o cron cobra pela outra.
function escolherPrincipal(lista, temDado) {
  return maisRecente(lista.filter(temDado)) || maisRecente(lista);
}

// Padroniza o nome da cabana pelo cadastrado em cabanas.json ("ipe" -> "Ipê"),
// sem alterar o dado salvo. Se não reconhecer, devolve o que veio.
function canonizarCabana(nome, cabanasList) {
  if (!nome) return '';
  const alvo = normalize(nome);
  const achada = (cabanasList || []).find((c) => normalize(c.nome) === alvo || alvo.includes(normalize(c.nome)));
  return achada ? achada.nome : nome;
}

function buildEstadias(registros, hojeISO = new Date().toISOString().slice(0, 10), { mapaConflitos = null, cabanasList = [] } = {}) {
  const conflitosPorId = mapaConflitos || detectarConflitos(registros);

  return agruparPorEstadia(registros)
    .map((grupo) => {
      const cadastros = grupo.filter((r) => r.tipo === 'cadastro');
      const reservas = grupo.filter((r) => r.tipo === 'reserva');
      const cadastro = escolherPrincipal(cadastros, (r) => r.telefone);
      const reservaCrua = escolherPrincipal(reservas, (r) => r.dados?.parcelas?.length);
      const reserva = reservaCrua ? enrichRegistro(reservaCrua, hojeISO) : null;
      const principal = cadastro || reservaCrua || grupo[0];

      const statusPagamento = reserva?.dados?.status_pagamento || null;
      const estagio = calcularEstagio(Boolean(reservaCrua), reserva?.dados?.parcelas);

      // Conflitos de qualquer membro do grupo, sem repetir e sem apontar pro
      // próprio grupo (cadastro+reserva da mesma estadia nunca é conflito).
      const idsDoGrupo = new Set(grupo.map((r) => r.id));
      const vistos = new Set();
      const alertas = [];
      for (const r of grupo) {
        for (const c of conflitosPorId.get(r.id) || []) {
          if (idsDoGrupo.has(c.id) || vistos.has(c.id)) continue;
          vistos.add(c.id);
          alertas.push(c);
        }
      }
      const conflitos = alertas.filter((c) => c.motivo === 'overbooking');
      const divergencias = alertas.filter((c) => c.motivo === 'divergencia');

      const duplicados = [...cadastros, ...reservas]
        .filter((r) => r.id !== cadastro?.id && r.id !== reservaCrua?.id)
        .map((r) => ({ id: r.id, tipo: r.tipo, timestamp: r.timestamp }));

      return {
        id: principal.id,
        estagio,
        estagio_label: ESTAGIOS[estagio].label,
        estagio_emoji: ESTAGIOS[estagio].emoji,
        hospede: cadastro?.dados?.hospede1?.nome || reservaCrua?.dados?.hospede || '(sem nome)',
        telefone: cadastro?.telefone || null,
        cabana: canonizarCabana(reservaCrua?.dados?.cabana || cadastro?.dados?.cabana || '', cabanasList),
        cabana_bruta: reservaCrua?.dados?.cabana || cadastro?.dados?.cabana || '',
        // A exibição segue o cadastro (é ele que dispara o lembrete de véspera);
        // se a reserva discordar, isso aparece em "divergencias".
        checkin: principal.dados?.checkin || principal.checkin_iso || '',
        checkout: principal.dados?.checkout || principal.checkout_iso || '',
        checkin_iso: principal.checkin_iso || null,
        checkout_iso: principal.checkout_iso || null,
        valor_total: reservaCrua?.dados?.valor_total || '',
        valor_total_num: parseValorBR(reservaCrua?.dados?.valor_total),
        status_pagamento: statusPagamento,
        parcelas: reserva?.dados?.parcelas || [],
        canal_venda: reservaCrua?.dados?.canal_venda || '',
        adicionais: reservaCrua?.dados?.adicionais || '',
        cadastroId: cadastro?.id || null,
        reservaId: reservaCrua?.id || null,
        duplicados,
        // Qual registro cru alimenta qual automação — some a dúvida de "editei
        // a linha errada e o lembrete não mudou".
        automacoes: {
          lembreteVespera: cadastro
            ? {
                registroId: cadastro.id,
                apto: Boolean(cadastro.telefone && cadastro.checkin_iso),
                enviado: Boolean(cadastro.lembreteEnviado),
              }
            : null,
          cobrancaParcela: reserva?.dados?.parcelas?.length ? { registroId: reservaCrua.id } : null,
        },
        conflitos,
        divergencias,
        alertas,
        registros: grupo.map((r) => enrichRegistro(r, hojeISO)),
      };
    })
    .sort((a, b) => String(b.checkin_iso || '').localeCompare(String(a.checkin_iso || '')));
}

module.exports = {
  normalize,
  buildEstadias,
  ESTAGIOS,
  MOTIVOS,
  detectarConflitos,
  conflitosDeUmaEstadia,
  listarParcelasParaLembrar,
  montarMensagemCobranca,
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
