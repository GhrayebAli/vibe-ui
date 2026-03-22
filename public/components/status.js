let listEl = null;

const services = [
  { name: 'Frontend', id: 'frontend', port: 3000 },
  { name: 'API Gateway', id: 'api-gateway', port: 1337 },
  { name: 'Core Service', id: 'core-service', port: 2339 },
];

let healthState = {};

export function initStatus(el) {
  listEl = el;
}

export async function checkHealth() {
  try {
    const resp = await fetch('/api/service-health');
    const data = await resp.json();

    for (const svc of data.services) {
      healthState[svc.name] = svc.status;
      // Update header dots
      const dotId = svc.name === 'api-gateway' ? 'h-gw' : svc.name === 'core-service' ? 'h-core' : 'h-fe';
      const dot = document.getElementById(dotId);
      if (dot) dot.className = 'h-dot ' + (svc.status === 'healthy' ? 'ok' : 'err');
    }

    // Update overlay if open
    if (listEl) renderStatus(data.services);
  } catch {}
}

function renderStatus(svcs) {
  listEl.innerHTML = '';
  svcs.forEach(svc => {
    const healthy = svc.status === 'healthy';
    const div = document.createElement('div');
    div.className = 'status-svc';
    div.innerHTML = `
      <div class="status-svc-info">
        <span class="h-dot ${healthy ? 'ok' : 'err'}"></span>
        <span class="status-svc-name">${svc.name}</span>
        <span class="status-svc-port">:${svc.port}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="status-svc-badge ${healthy ? 'running' : 'down'}">${healthy ? 'Running' : 'Down'}</span>
        ${!healthy ? '<button class="status-restart" data-svc="' + svc.name + '">Restart</button>' : ''}
      </div>
    `;
    const restartBtn = div.querySelector('.status-restart');
    if (restartBtn) {
      restartBtn.onclick = () => {
        fetch('/api/restart-service', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ service: svc.name }),
        });
        restartBtn.textContent = 'Restarting...';
        restartBtn.disabled = true;
        setTimeout(() => checkHealth(), 5000);
      };
    }
    listEl.appendChild(div);
  });
}
