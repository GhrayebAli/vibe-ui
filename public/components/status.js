let listEl = null;
let healthState = {};

export function initStatus(el) {
  listEl = el;
}

export async function checkHealth() {
  try {
    const resp = await fetch('/api/service-health');
    const data = await resp.json();

    // Update header dots dynamically
    const dotIds = ['h-fe', 'h-gw', 'h-core', 'h-svc3', 'h-svc4', 'h-svc5'];
    data.services.forEach((svc, i) => {
      healthState[svc.name] = svc.status;
      const dot = document.getElementById(dotIds[i]);
      if (dot) dot.className = 'h-dot ' + (svc.status === 'healthy' ? 'ok' : 'err');
    });

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
        ${healthy
          ? '<button class="status-stop" data-svc="' + svc.name + '" data-port="' + svc.port + '">Stop</button>'
          : '<button class="status-restart" data-svc="' + svc.name + '">Restart</button>'
        }
      </div>
    `;
    const restartBtn = div.querySelector('.status-restart');
    if (restartBtn) {
      restartBtn.onclick = async () => {
        restartBtn.textContent = 'Restarting...';
        restartBtn.disabled = true;
        await fetch('/api/restart-service', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ service: svc.name }),
        });
        // Poll until service is back up
        for (let i = 0; i < 8; i++) {
          await new Promise(r => setTimeout(r, 2000));
          await checkHealth();
          if (healthState[svc.name] === 'healthy') break;
        }
      };
    }
    const stopBtn = div.querySelector('.status-stop');
    if (stopBtn) {
      stopBtn.onclick = async () => {
        stopBtn.textContent = 'Stopping...';
        stopBtn.disabled = true;
        await fetch('/api/stop-service', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: svc.port }),
        });
        // Poll until service is actually down
        for (let i = 0; i < 5; i++) {
          await new Promise(r => setTimeout(r, 1000));
          await checkHealth();
          if (healthState[svc.name] !== 'healthy') break;
        }
      };
    }
    listEl.appendChild(div);
  });
}
