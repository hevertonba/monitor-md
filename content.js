// ============================================================
// content.js — Injetado em pedidos.php
// ============================================================

(function () {
  'use strict';

  if (window.__mdmInjected) return;
  window.__mdmInjected = true;

  let config = null;
  let overlayMontado = false;
  let pollingTimer = null;
  let audioCtx = null;
  let primeiraLeitura = true; // flag: true na primeira leitura da sessão

  // ──────────────────────────────────────────────
  // 1. INIT
  // ──────────────────────────────────────────────
  async function init() {
    config = await getConfig();

    // Reseta snapshot ao carregar a página (nova sessão)
    await new Promise(r => chrome.runtime.sendMessage({ tipo: 'RESET_SNAPSHOT' }, r));

    interceptarAjax();
    observarMudancasDOM();
    await tick();
    montarOverlay();
    iniciarPolling();
    console.log('[MDMonitor] Iniciado.');
  }

  function getConfig() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ tipo: 'GET_CONFIG' }, (cfg) => {
        resolve(cfg || {});
      });
    });
  }

  // ──────────────────────────────────────────────
  // 2. INTERCEPTAÇÃO AJAX
  // O sistema usa XHR para tudo (buscar pedidos, atualizar status, polling de novos pedidos)
  // Quando detectamos uma resposta relevante, reagendamos um tick após o DOM atualizar
  // ──────────────────────────────────────────────
  function interceptarAjax() {
    const OriginalXHR = window.XMLHttpRequest;

    function XHRInterceptado() {
      const xhr = new OriginalXHR();
      let requestUrl = '';
      let requestBody = '';

      const origOpen = xhr.open.bind(xhr);
      const origSend = xhr.send.bind(xhr);

      xhr.open = function (method, url, ...rest) {
        requestUrl = String(url || '');
        return origOpen(method, url, ...rest);
      };

      xhr.send = function (body) {
        requestBody = String(body || '');
        xhr.addEventListener('load', function () {
          if (!requestUrl.includes('ajax_operacao.php')) return;
          try {
            const data = JSON.parse(xhr.responseText);
            onAjaxResponse(data, requestBody);
          } catch (e) {}
        });
        return origSend(body);
      };

      return xhr;
    }

    XHRInterceptado.prototype = OriginalXHR.prototype;
    window.XMLHttpRequest = XHRInterceptado;
  }

  let tickAgendado = false;
  function onAjaxResponse(data, body) {
    // Qualquer resposta do ajax_operacao dispara releitura do DOM
    // (pode ter atualizado status, ou retornado novos pedidos)
    if (tickAgendado) return;
    tickAgendado = true;
    setTimeout(() => {
      tickAgendado = false;
      tick();
    }, 600);
  }

  // ──────────────────────────────────────────────
  // 3. OBSERVER DE DOM
  // O DataTables re-renderiza as linhas ao trocar de página (10/25/100/Todos)
  // O MutationObserver detecta isso e aciona releitura
  // ──────────────────────────────────────────────
  function observarMudancasDOM() {
    const observer = new MutationObserver((mutations) => {
      // Só reage se linhas de pedido foram adicionadas ou removidas da tabela
      const relevante = mutations.some(m =>
        m.target.closest?.('#tablePedidos') ||
        m.addedNodes.length > 0 && [...m.addedNodes].some(n =>
          n.nodeType === 1 && (n.matches?.('tr[idpedido]') || n.querySelector?.('tr[idpedido]'))
        )
      );
      if (!relevante) return;
      if (tickAgendado) return;
      tickAgendado = true;
      setTimeout(() => {
        tickAgendado = false;
        tick();
      }, 400);
    });

    // Observa o tbody da tabela de pedidos (e o wrapper do DataTables)
    const alvo = document.querySelector('#tablePedidos_wrapper') || document.body;
    observer.observe(alvo, { childList: true, subtree: true });
  }

  // ──────────────────────────────────────────────
  // 4. LEITURA DO DOM
  // ──────────────────────────────────────────────
  function lerPedidosDoDOM() {
    const pedidos = [];
    // Lê APENAS as linhas visíveis no DOM (DataTables oculta as outras páginas com display:none
    // ou remove do DOM — o acumulado no background compensa isso)
    const linhas = document.querySelectorAll('#tablePedidos tbody tr[idpedido]');

    for (const tr of linhas) {
      // DataTables esconde linhas de outras páginas com display:none
      // Ainda assim as lemos, pois queremos o acumulado completo
      const idPedido = parseInt(tr.getAttribute('idpedido'), 10);
      if (!idPedido || isNaN(idPedido)) continue;

      // Status: preferência ao <select>, fallback à classe CSS
      let status = extrairStatusDaClasse(tr);
      const selectStatus = tr.querySelector('select[id^="idSituacao"]');
      if (selectStatus) {
        const v = parseInt(selectStatus.value, 10);
        if (!isNaN(v)) status = v;
      }

      const tds = tr.querySelectorAll('td');

      // Col 0: estabelecimento
      const divs0 = tds[0]?.querySelectorAll('div') || [];
      const estabelecimento = divs0[0]?.textContent?.trim() || '';

      // Col 1: cliente
      const cliente = tds[1]?.textContent?.trim() || '';

      // Col 2: entregador (pode ser texto direto ou dentro do <select>)
      let entregador = '';
      const selectEnt = tr.querySelector('select[id^="idEntregador"]');
      if (selectEnt) {
        entregador = selectEnt.options[selectEnt.selectedIndex]?.text?.trim() || 'Sem Entregador';
      } else {
        entregador = tds[2]?.textContent?.trim() || '';
      }

      // Col 3: detalhes do pedido
      const tdPed = tds[3];
      const valor = extrairTextoApos(tdPed, 'Valor Total:');
      const pagamento = tdPed?.querySelector('label[style*="background-color"]')?.textContent?.trim() || '';

      // Tempo parado: último span de "última atualização"
      const minutosParado = extrairMinutosParado(tdPed);

      pedidos.push({
        id: idPedido,
        status,
        statusNome: nomeStatus(status),
        estabelecimento,
        cliente,
        entregador,
        valor,
        pagamento,
        minutosParado,
        _leituraTimestamp: Date.now(),
      });
    }

    return pedidos;
  }

  function extrairStatusDaClasse(tr) {
    for (const cls of tr.classList) {
      const m = cls.match(/^pedido_(-?\d+)$/);
      if (m) return parseInt(m[1], 10);
    }
    return 0;
  }

  function extrairTextoApos(el, rotulo) {
    if (!el) return '';
    for (const div of el.querySelectorAll('div')) {
      const txt = div.textContent;
      if (txt.includes(rotulo)) {
        return txt.replace(rotulo, '').trim();
      }
    }
    return '';
  }

  function extrairMinutosParado(tdPedido) {
    if (!tdPedido) return 0;
    // Pega o segundo span colorido (o primeiro é a data do pedido, o segundo é "Última atualização")
    const spans = tdPedido.querySelectorAll('span[style*="#911813"]');
    // Procura o span que contém "Há" ou "há" (última atualização)
    let texto = '';
    for (const s of spans) {
      const t = s.textContent.trim();
      if (/há|Há|minuto|hora|segundo/i.test(t)) {
        texto = t;
        break;
      }
    }
    return parsearMinutos(texto);
  }

  function parsearMinutos(texto) {
    if (!texto) return 0;
    const t = texto.toLowerCase();
    let min = 0;
    const h = t.match(/(\d+)\s*hora/);
    const m = t.match(/(\d+)\s*minuto/);
    if (h) min += parseInt(h[1]) * 60;
    if (m) min += parseInt(m[1]);
    return min;
  }

  function nomeStatus(s) {
    const map = {
      '-2': 'Pagamento não realizado',
      '-1': 'Aguardando pagamento',
      '0': 'Desconhecido',
      '1': 'Verificando',
      '2': 'Na fila de preparo',
      '3': 'Em andamento',
      '4': 'Pronto pra entrega',
      '5': 'Saiu para entrega',
      '6': 'Entrega realizada',
      '7': 'Na porta',
      '9': 'Cancelado',
    };
    return map[String(s)] || `Status ${s}`;
  }

  // ──────────────────────────────────────────────
  // 5. TICK — ciclo principal
  // ──────────────────────────────────────────────
  async function tick() {
    const pedidos = lerPedidosDoDOM();

    const resposta = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { tipo: 'PEDIDOS_ATUALIZADOS', dados: pedidos, primeiraLeitura },
        resolve
      );
    });

    // Após a primeira leitura bem-sucedida, não é mais "primeira"
    if (primeiraLeitura) primeiraLeitura = false;

    if (resposta && resposta.eventos) {
      tocarSons(resposta.eventos);
    }
    if (resposta && resposta.resumo) {
      atualizarOverlay(resposta.resumo);
    }
  }

  function iniciarPolling() {
    const intervalo = ((config?.pollingIntervalSeg) || 15) * 1000;
    if (pollingTimer) clearInterval(pollingTimer);
    pollingTimer = setInterval(tick, intervalo);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.tipo === 'CONFIG_ATUALIZADA') {
      config = msg.config;
      iniciarPolling();
    }
  });

  // ──────────────────────────────────────────────
  // 6. SONS (Web Audio API — sem arquivos externos)
  // ──────────────────────────────────────────────
  function getAudioCtx() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    }
    return audioCtx;
  }

  function tocarSons(eventos) {
    if (!config) return;
    for (const ev of eventos) {
      if (ev.tipo === 'NOVO_PEDIDO' && config.somNovoPedido) {
        beep(880, 0.25, 'sine');
        setTimeout(() => beep(1100, 0.2, 'sine'), 180);
        setTimeout(() => beep(1320, 0.22, 'sine'), 360);
      } else if (ev.tipo === 'PEDIDO_ATRASADO' && config.somPedidoAtrasado) {
        beep(440, 0.35, 'square');
        setTimeout(() => beep(440, 0.35, 'square'), 380);
        setTimeout(() => beep(330, 0.45, 'square'), 760);
      } else if (ev.tipo === 'MUDANCA_STATUS' && config.somMudancaStatus) {
        beep(660, 0.12, 'sine');
      }
    }
  }

  function beep(freq, dur, tipo) {
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = tipo;
      gain.gain.setValueAtTime(0.28, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + dur);
    } catch (e) {}
  }

  // ──────────────────────────────────────────────
  // 7. OVERLAY FLUTUANTE
  // ──────────────────────────────────────────────
  function montarOverlay() {
    if (overlayMontado) return;
    if (config?.overlayVisivel === false) return;

    const pos = config?.overlayPosicao || { x: 20, y: 80 };
    const el = document.createElement('div');
    el.id = 'mdm-overlay';
    el.innerHTML = `
      <div id="mdm-header">
        <span id="mdm-titulo">📦 Monitor</span>
        <div id="mdm-header-btns">
          <button id="mdm-btn-minimizar" title="Minimizar">—</button>
          <button id="mdm-btn-fechar" title="Fechar">✕</button>
        </div>
      </div>
      <div id="mdm-corpo">
        <div id="mdm-resumo-topo">
          <div class="mdm-stat">
            <span class="mdm-stat-num" id="mdm-num-ativos">—</span>
            <span class="mdm-stat-label">ativos</span>
          </div>
          <div class="mdm-stat mdm-stat-alert" id="mdm-stat-atrasados">
            <span class="mdm-stat-num" id="mdm-num-atrasados">—</span>
            <span class="mdm-stat-label">atrasados</span>
          </div>
          <div class="mdm-stat mdm-stat-warn">
            <span class="mdm-stat-num" id="mdm-num-semEntregador">—</span>
            <span class="mdm-stat-label">sem motoboy</span>
          </div>
        </div>
        <div id="mdm-status-grid">
          <div class="mdm-sitem mdm-s-verificando">
            <span class="mdm-snum" id="mdm-s-1">0</span>
            <span class="mdm-slabel">Verificando</span>
          </div>
          <div class="mdm-sitem mdm-s-fila">
            <span class="mdm-snum" id="mdm-s-2">0</span>
            <span class="mdm-slabel">Na fila</span>
          </div>
          <div class="mdm-sitem mdm-s-andamento">
            <span class="mdm-snum" id="mdm-s-3">0</span>
            <span class="mdm-slabel">Andamento</span>
          </div>
          <div class="mdm-sitem mdm-s-pronto">
            <span class="mdm-snum" id="mdm-s-4">0</span>
            <span class="mdm-slabel">Pronto</span>
          </div>
          <div class="mdm-sitem mdm-s-saiu">
            <span class="mdm-snum" id="mdm-s-5">0</span>
            <span class="mdm-slabel">Saiu</span>
          </div>
          <div class="mdm-sitem mdm-s-porta">
            <span class="mdm-snum" id="mdm-s-7">0</span>
            <span class="mdm-slabel">Na porta</span>
          </div>
          <div class="mdm-sitem mdm-s-aguardando">
            <span class="mdm-snum" id="mdm-s--1">0</span>
            <span class="mdm-slabel">Ag. pag.</span>
          </div>
          <div class="mdm-sitem" style="border-color:#6b728044;">
            <span class="mdm-snum" id="mdm-s-6" style="color:#4ade80;">0</span>
            <span class="mdm-slabel">Entregues</span>
          </div>
        </div>
        <div id="mdm-alertas-lista"></div>
        <div id="mdm-rodape">
          <span id="mdm-ultima-atualizacao">Carregando...</span>
          <button id="mdm-btn-config" title="Configurações">⚙</button>
        </div>
      </div>`;

    el.style.left = pos.x + 'px';
    el.style.top = pos.y + 'px';
    document.body.appendChild(el);
    overlayMontado = true;

    ativarArrastar(el);

    el.querySelector('#mdm-btn-fechar').addEventListener('click', () => {
      el.style.display = 'none';
      chrome.runtime.sendMessage({ tipo: 'SET_CONFIG', config: { ...config, overlayVisivel: false } });
    });

    el.querySelector('#mdm-btn-minimizar').addEventListener('click', () => {
      const corpo = el.querySelector('#mdm-corpo');
      const min = corpo.style.display === 'none';
      corpo.style.display = min ? '' : 'none';
      el.querySelector('#mdm-btn-minimizar').textContent = min ? '—' : '□';
    });

    el.querySelector('#mdm-btn-config').addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
  }

  function ativarArrastar(el) {
    let drag = false, sx, sy, sl, st;
    const header = el.querySelector('#mdm-header');

    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      drag = true;
      sx = e.clientX; sy = e.clientY;
      sl = parseInt(el.style.left) || 0;
      st = parseInt(el.style.top) || 0;
      el.style.transition = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      el.style.left = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, sl + e.clientX - sx)) + 'px';
      el.style.top  = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, st + e.clientY - sy)) + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!drag) return;
      drag = false;
      el.style.transition = '';
      chrome.runtime.sendMessage({
        tipo: 'SET_CONFIG',
        config: { ...config, overlayPosicao: { x: parseInt(el.style.left), y: parseInt(el.style.top) } },
      });
    });
  }

  function atualizarOverlay(resumo) {
    if (!resumo) return;
    const el = document.getElementById('mdm-overlay');
    if (!el || el.style.display === 'none') return;

    const ativos = resumo.verificando + resumo.naFila + resumo.emAndamento +
      resumo.prontoEntrega + resumo.saiuEntrega + resumo.naPorta;

    set('mdm-num-ativos', ativos);
    set('mdm-num-atrasados', resumo.atrasados);
    set('mdm-num-semEntregador', resumo.semEntregador);
    set('mdm-s-1', resumo.verificando);
    set('mdm-s-2', resumo.naFila);
    set('mdm-s-3', resumo.emAndamento);
    set('mdm-s-4', resumo.prontoEntrega);
    set('mdm-s-5', resumo.saiuEntrega);
    set('mdm-s-7', resumo.naPorta);
    set('mdm-s--1', resumo.aguardandoPagamento);
    set('mdm-s-6', resumo.entregue);

    const cardAtrasados = document.getElementById('mdm-stat-atrasados');
    if (cardAtrasados) cardAtrasados.classList.toggle('mdm-pulsando', resumo.atrasados > 0);

    renderizarAlertasOverlay();

    const agora = new Date();
    set('mdm-ultima-atualizacao',
      `⟳ ${pad(agora.getHours())}:${pad(agora.getMinutes())}:${pad(agora.getSeconds())}`);
  }

  async function renderizarAlertasOverlay() {
    const { alertas } = await chrome.storage.local.get('alertas');
    const lista = document.getElementById('mdm-alertas-lista');
    if (!lista) return;
    const items = (alertas || []).slice(-5).reverse();
    if (items.length === 0) { lista.innerHTML = ''; return; }

    lista.innerHTML = items.map(a => {
      const cls = a.tipo === 'PEDIDO_ATRASADO' ? 'mdm-alerta-alta'
        : a.tipo === 'NOVO_PEDIDO' ? 'mdm-alerta-media' : 'mdm-alerta-baixa';
      const icone = a.tipo === 'PEDIDO_ATRASADO' ? '⚠' : a.tipo === 'NOVO_PEDIDO' ? '+' : '↕';
      const hora = new Date(a.timestamp);
      return `<div class="mdm-alerta-item ${cls}">
        <span class="mdm-alerta-icone">${icone}</span>
        <span class="mdm-alerta-msg">${a.mensagem}</span>
        <span class="mdm-alerta-hora">${pad(hora.getHours())}:${pad(hora.getMinutes())}</span>
      </div>`;
    }).join('');
  }

  function set(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val ?? '—';
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  // ──────────────────────────────────────────────
  // INICIA
  // ──────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
