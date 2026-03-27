// popup.js

async function carregarEstado() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ tipo: 'GET_ESTADO' }, resolve);
  });
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val ?? '—';
}

function renderizarAlertas(alertas) {
  const lista = document.getElementById('alertas-lista');
  if (!lista) return;

  if (!alertas || alertas.length === 0) {
    lista.innerHTML = '<div class="sem-alertas">Nenhum alerta ainda</div>';
    return;
  }

  const recentes = [...alertas].reverse().slice(0, 10);
  lista.innerHTML = recentes.map(a => {
    const cls = a.tipo === 'PEDIDO_ATRASADO' ? 'alerta-alta' :
      a.tipo === 'NOVO_PEDIDO' ? 'alerta-media' : 'alerta-baixa';
    const icone = a.tipo === 'PEDIDO_ATRASADO' ? '⚠' :
      a.tipo === 'NOVO_PEDIDO' ? '🆕' : '↕';
    const hora = new Date(a.timestamp);
    const horaStr = `${hora.getHours().toString().padStart(2,'0')}:${hora.getMinutes().toString().padStart(2,'0')}`;
    return `
      <div class="alerta-item ${cls}">
        <span class="alerta-icone">${icone}</span>
        <span class="alerta-texto">${a.mensagem}</span>
        <span class="alerta-hora">${horaStr}</span>
      </div>`;
  }).join('');
}

async function init() {
  const estado = await carregarEstado();
  const { resumo, alertas, ultimaAtualizacao } = estado || {};

  if (resumo && (ultimaAtualizacao || estado?.pedidosAcumulados)) {
    // Mostra conteúdo online
    document.getElementById('conteudo-online').style.display = '';
    document.getElementById('conteudo-offline').style.display = 'none';

    const ativos = (resumo.aguardandoPagamento || 0) + (resumo.verificando || 0) +
      (resumo.naFila || 0) + (resumo.emAndamento || 0) +
      (resumo.prontoEntrega || 0) + (resumo.saiuEntrega || 0) + (resumo.naPorta || 0);

    setText('num-ativos', ativos);
    setText('num-atrasados', resumo.atrasados || 0);
    setText('num-sem-entregador', resumo.semEntregador || 0);

    setText('sq--1', resumo.aguardandoPagamento || 0);
    setText('sq-1', resumo.verificando || 0);
    setText('sq-2', resumo.naFila || 0);
    setText('sq-3', resumo.emAndamento || 0);
    setText('sq-4', resumo.prontoEntrega || 0);
    setText('sq-5', resumo.saiuEntrega || 0);
    setText('sq-7', resumo.naPorta || 0);
    setText('sq-6', resumo.entregue || 0);

    const badge = document.getElementById('badge-status');
    if (badge) {
      if (resumo.atrasados > 0) {
        badge.textContent = `${resumo.atrasados} atrasado${resumo.atrasados > 1 ? 's' : ''}`;
        badge.style.background = 'rgba(231,76,60,0.4)';
      } else {
        badge.textContent = `${ativos} ativo${ativos !== 1 ? 's' : ''}`;
        badge.style.background = '';
      }
    }

    // Última atualização
    if (ultimaAtualizacao) {
      const dt = new Date(ultimaAtualizacao);
      setText('ultima-atualizacao',
        `Atualizado às ${dt.getHours().toString().padStart(2,'0')}:${dt.getMinutes().toString().padStart(2,'0')}:${dt.getSeconds().toString().padStart(2,'0')}`
      );
    }

    renderizarAlertas(alertas);
  } else {
    document.getElementById('conteudo-online').style.display = 'none';
    document.getElementById('conteudo-offline').style.display = '';
    document.getElementById('badge-status').textContent = 'offline';
  }
}

// Botões
document.getElementById('btn-abrir-painel').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://painel.maisdeliveryempresas.com.br/painel/pedidos.php' });
  window.close();
});

document.getElementById('btn-limpar-alertas').addEventListener('click', async () => {
  await new Promise(r => chrome.runtime.sendMessage({ tipo: 'LIMPAR_ALERTAS' }, r));
  init();
});

document.getElementById('btn-config').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

init();

// Auto-atualiza a cada 5s enquanto popup aberto
setInterval(init, 5000);
