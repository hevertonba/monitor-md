// ============================================================
// background.js — Service Worker da extensão Mais Delivery Monitor
// ============================================================

const DEFAULT_CONFIG = {
  alertaMinutosParado: 10,
  somNovoPedido: true,
  somPedidoAtrasado: true,
  somMudancaStatus: false,
  notificacaoDesktop: true,
  pollingIntervalSeg: 15,
  // Apenas status que chegaram ao estabelecimento contam como "atrasados"
  // -2 (pagamento não realizado) e -1 (aguardando pagamento) excluídos
  statusMonitorados: [1, 2, 3, 4, 5, 7],
  overlayVisivel: true,
  overlayPosicao: { x: 20, y: 80 },
};

chrome.runtime.onInstalled.addListener(async () => {
  const { config } = await chrome.storage.local.get('config');
  if (!config) {
    await chrome.storage.local.set({
      config: DEFAULT_CONFIG,
      pedidosSnapshot: {},
      pedidosAcumulados: {},
      alertas: [],
    });
  }
  atualizarBadge(0, 'normal');
  console.log('[MDMonitor] Extensão instalada.');
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.tipo === 'PEDIDOS_ATUALIZADOS') {
    processarAtualizacao(msg.dados, msg.primeiraLeitura).then(sendResponse);
    return true;
  }
  if (msg.tipo === 'GET_CONFIG') {
    chrome.storage.local.get('config').then(({ config }) => {
      sendResponse(config || DEFAULT_CONFIG);
    });
    return true;
  }
  if (msg.tipo === 'SET_CONFIG') {
    chrome.storage.local.set({ config: msg.config }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.tipo === 'GET_ESTADO') {
    chrome.storage.local.get(['pedidosAcumulados', 'resumo', 'alertas', 'ultimaAtualizacao'])
      .then(sendResponse);
    return true;
  }
  if (msg.tipo === 'LIMPAR_ALERTAS') {
    chrome.storage.local.set({ alertas: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.tipo === 'RESET_SNAPSHOT') {
    chrome.storage.local.set({ pedidosSnapshot: {}, pedidosAcumulados: {} })
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function processarAtualizacao(pedidosNovos, primeiraLeitura) {
  const storage = await chrome.storage.local.get([
    'config', 'pedidosSnapshot', 'pedidosAcumulados', 'alertas'
  ]);
  const cfg = storage.config || DEFAULT_CONFIG;
  const snapAnterior = storage.pedidosSnapshot || {};
  const acumuladoAnterior = storage.pedidosAcumulados || {};
  const alertasAnteriores = storage.alertas || [];

  // Mescla pedidos novos no acumulado (preserva pedidos de outras páginas do DataTables)
  const acumuladoNovo = { ...acumuladoAnterior };
  for (const p of pedidosNovos) {
    // Preserva _ultimoAlertaAtrasado se já existia
    if (acumuladoAnterior[p.id]?._ultimoAlertaAtrasado) {
      p._ultimoAlertaAtrasado = acumuladoAnterior[p.id]._ultimoAlertaAtrasado;
    }
    acumuladoNovo[p.id] = p;
  }

  // Na primeira leitura da sessão: popula snapshot silenciosamente
  // sem disparar falsos alertas de "novo pedido"
  if (primeiraLeitura) {
    const resumo = calcularResumo(Object.values(acumuladoNovo), cfg);
    atualizarBadgeComResumo(resumo, cfg);
    await chrome.storage.local.set({
      pedidosSnapshot: { ...acumuladoNovo },
      pedidosAcumulados: acumuladoNovo,
      resumo,
      ultimaAtualizacao: Date.now(),
    });
    return { eventos: [], resumo };
  }

  // Detecta eventos comparando com snapshot
  const eventos = detectarEventos(pedidosNovos, snapAnterior, acumuladoAnterior, cfg);

  // Resumo usa todos os acumulados (inclusive pedidos em outras páginas do DataTables)
  const resumo = calcularResumo(Object.values(acumuladoNovo), cfg);

  const novosAlertas = [];
  for (const ev of eventos) {
    const alerta = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      timestamp: Date.now(),
      ...ev,
    };
    novosAlertas.push(alerta);
    if (cfg.notificacaoDesktop) dispararNotificacao(alerta);
  }

  atualizarBadgeComResumo(resumo, cfg);

  const novoSnapshot = { ...snapAnterior };
  for (const p of pedidosNovos) novoSnapshot[p.id] = p;

  await chrome.storage.local.set({
    pedidosSnapshot: novoSnapshot,
    pedidosAcumulados: acumuladoNovo,
    resumo,
    alertas: [...alertasAnteriores, ...novosAlertas].slice(-100),
    ultimaAtualizacao: Date.now(),
  });

  return { eventos, resumo };
}

function detectarEventos(pedidosNovos, snapAnterior, acumuladoAnterior, cfg) {
  const eventos = [];
  const agora = Date.now();

  for (const pedido of pedidosNovos) {
    const noSnap = !snapAnterior[pedido.id];
    const noAcum = !acumuladoAnterior[pedido.id];

    // Pedido genuinamente novo: não estava em lugar nenhum
    if (noSnap && noAcum) {
      // Ignora status finais ou de pagamento pendente como "novos"
      if (![6, 9, -2, -1].includes(pedido.status)) {
        eventos.push({
          tipo: 'NOVO_PEDIDO',
          idPedido: pedido.id,
          estabelecimento: pedido.estabelecimento,
          cliente: pedido.cliente,
          valor: pedido.valor,
          status: pedido.status,
          statusNome: pedido.statusNome,
          mensagem: `Novo pedido #${pedido.id} — ${pedido.estabelecimento}`,
          prioridade: 'media',
        });
      }
      continue;
    }

    // Referência anterior (prefere snapshot, cai no acumulado se não estava na página atual)
    const ref = snapAnterior[pedido.id] || acumuladoAnterior[pedido.id];

    // Mudança de status
    if (ref && ref.status !== pedido.status) {
      eventos.push({
        tipo: 'MUDANCA_STATUS',
        idPedido: pedido.id,
        estabelecimento: pedido.estabelecimento,
        statusAnterior: ref.status,
        statusAnteriorNome: ref.statusNome,
        statusNovo: pedido.status,
        statusNovoNome: pedido.statusNome,
        mensagem: `#${pedido.id} ${pedido.estabelecimento}: ${ref.statusNome} → ${pedido.statusNome}`,
        prioridade: pedido.status === 9 ? 'baixa' : 'media',
      });
    }

    // Pedido atrasado — exclui -2 e -1 via cfg.statusMonitorados
    if (cfg.statusMonitorados.includes(pedido.status) && pedido.minutosParado >= cfg.alertaMinutosParado) {
      const ultimoAlerta = (acumuladoAnterior[pedido.id] || {})._ultimoAlertaAtrasado || 0;
      if (agora - ultimoAlerta > 10 * 60 * 1000) {
        pedido._ultimoAlertaAtrasado = agora;
        eventos.push({
          tipo: 'PEDIDO_ATRASADO',
          idPedido: pedido.id,
          estabelecimento: pedido.estabelecimento,
          minutosParado: pedido.minutosParado,
          status: pedido.status,
          statusNome: pedido.statusNome,
          mensagem: `#${pedido.id} parado há ${pedido.minutosParado}min — ${pedido.statusNome} (${pedido.estabelecimento})`,
          prioridade: 'alta',
        });
      }
    }
  }

  return eventos;
}

function calcularResumo(pedidos, cfg) {
  const c = {
    total: pedidos.length,
    aguardandoPagamento: 0,
    pagamentoNaoRealizado: 0,
    verificando: 0,
    naFila: 0,
    emAndamento: 0,
    prontoEntrega: 0,
    saiuEntrega: 0,
    naPorta: 0,
    entregue: 0,
    cancelado: 0,
    atrasados: 0,
    semEntregador: 0,
  };

  const statusMap = {
    '-2': 'pagamentoNaoRealizado',
    '-1': 'aguardandoPagamento',
    '1': 'verificando',
    '2': 'naFila',
    '3': 'emAndamento',
    '4': 'prontoEntrega',
    '5': 'saiuEntrega',
    '7': 'naPorta',
    '6': 'entregue',
    '9': 'cancelado',
  };

  for (const p of pedidos) {
    const chave = statusMap[String(p.status)];
    if (chave) c[chave]++;

    // Atrasado só conta para status que chegaram ao estabelecimento
    if (cfg.statusMonitorados.includes(p.status) && p.minutosParado >= cfg.alertaMinutosParado) {
      c.atrasados++;
    }

    // Sem entregador: só quando está pronto ou saiu
    if ([4, 5].includes(p.status)) {
      const sem = !p.entregador
        || p.entregador.trim() === ''
        || p.entregador === 'Sem Entregador'
        || p.entregador === '0';
      if (sem) c.semEntregador++;
    }
  }

  return { ...c, timestamp: Date.now() };
}

function atualizarBadgeComResumo(resumo, cfg) {
  const ativos = resumo.verificando + resumo.naFila + resumo.emAndamento +
    resumo.prontoEntrega + resumo.saiuEntrega + resumo.naPorta;
  if (resumo.atrasados > 0) {
    atualizarBadge(resumo.atrasados, 'alerta');
  } else if (ativos > 0) {
    atualizarBadge(ativos, 'normal');
  } else {
    atualizarBadge(0, 'normal');
  }
}

function atualizarBadge(qtd, tipo) {
  const texto = qtd > 0 ? String(qtd > 99 ? '99+' : qtd) : '';
  const cor = tipo === 'alerta' ? '#e74c3c' : '#2c7be5';
  chrome.action.setBadgeText({ text: texto });
  chrome.action.setBadgeBackgroundColor({ color: cor });
}

function dispararNotificacao(alerta) {
  chrome.notifications.create(`mdm_${alerta.id}`, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: alerta.tipo === 'NOVO_PEDIDO'
      ? 'Novo pedido!'
      : alerta.tipo === 'PEDIDO_ATRASADO'
        ? 'Pedido atrasado!'
        : 'Status atualizado',
    message: alerta.mensagem,
    priority: alerta.prioridade === 'alta' ? 2 : 1,
  });
}
