// options.js

const DEFAULT_CONFIG = {
  alertaMinutosParado: 10,
  somNovoPedido: true,
  somPedidoAtrasado: true,
  somMudancaStatus: false,
  notificacaoDesktop: true,
  pollingIntervalSeg: 15,
  statusMonitorados: [1, 2, 3, 4, 5, 7],
  overlayVisivel: true,
  overlayPosicao: { x: 20, y: 80 },
};

async function carregarConfig() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ tipo: 'GET_CONFIG' }, (cfg) => {
      resolve(cfg || DEFAULT_CONFIG);
    });
  });
}

function preencherFormulario(config) {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = val;
    else el.value = val;
  };

  set('alertaMinutosParado', config.alertaMinutosParado);
  set('notificacaoDesktop', config.notificacaoDesktop);
  set('somNovoPedido', config.somNovoPedido);
  set('somPedidoAtrasado', config.somPedidoAtrasado);
  set('somMudancaStatus', config.somMudancaStatus);
  set('pollingIntervalSeg', config.pollingIntervalSeg);
  set('overlayVisivel', config.overlayVisivel);
  set('overlayX', config.overlayPosicao?.x ?? 20);
  set('overlayY', config.overlayPosicao?.y ?? 80);

  // Checkboxes de status
  const checks = document.querySelectorAll('#status-checks input[type="checkbox"]');
  checks.forEach(ck => {
    ck.checked = (config.statusMonitorados || []).includes(parseInt(ck.value, 10));
  });
}

function lerFormulario() {
  const get = (id) => document.getElementById(id);
  const statusMonitorados = [];
  document.querySelectorAll('#status-checks input[type="checkbox"]:checked').forEach(ck => {
    statusMonitorados.push(parseInt(ck.value, 10));
  });

  return {
    alertaMinutosParado: parseInt(get('alertaMinutosParado').value, 10) || 10,
    notificacaoDesktop: get('notificacaoDesktop').checked,
    somNovoPedido: get('somNovoPedido').checked,
    somPedidoAtrasado: get('somPedidoAtrasado').checked,
    somMudancaStatus: get('somMudancaStatus').checked,
    pollingIntervalSeg: parseInt(get('pollingIntervalSeg').value, 10) || 15,
    statusMonitorados,
    overlayVisivel: get('overlayVisivel').checked,
    overlayPosicao: {
      x: parseInt(get('overlayX').value, 10) || 20,
      y: parseInt(get('overlayY').value, 10) || 80,
    },
  };
}

function mostrarToast(msg, tipo = 'ok') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.style.background = tipo === 'ok' ? '#10b981' : '#e74c3c';
  toast.classList.add('visivel');
  setTimeout(() => toast.classList.remove('visivel'), 2500);
}

async function salvar() {
  const config = lerFormulario();
  await new Promise((resolve) => {
    chrome.runtime.sendMessage({ tipo: 'SET_CONFIG', config }, resolve);
  });

  // Notifica content scripts ativos
  chrome.tabs.query({ url: '*://painel.maisdeliveryempresas.com.br/painel/pedidos.php*' }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { tipo: 'CONFIG_ATUALIZADA', config }).catch(() => {});
    }
  });

  mostrarToast('Configurações salvas!');
}

// Init
(async () => {
  const config = await carregarConfig();
  preencherFormulario(config);

  document.getElementById('btn-salvar').addEventListener('click', salvar);

  document.getElementById('btn-restaurar').addEventListener('click', async () => {
    preencherFormulario(DEFAULT_CONFIG);
    await new Promise(r => chrome.runtime.sendMessage({ tipo: 'SET_CONFIG', config: DEFAULT_CONFIG }, r));
    mostrarToast('Padrões restaurados.');
  });
})();
