import { refreshPreview } from './preview.js';

let listEl = null;
let healthState = {};
let pendingActions = {}; // tracks services mid-restart or mid-stop

export function initStatus(el) {
  listEl = el;
}

export async function checkHealth() {
  try {
    const resp = await fetch('/api/service-health');
    const data = await resp.json();

    // Dynamically render health dots in the header
    const dotsContainer = document.getElementById('health-dots');
    if (dotsContainer && data.services) {
      dotsContainer.innerHTML = '';
      data.services.forEach(svc => {
        const ok = svc.status === 'healthy';
        const label = svc.name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        // index-v2 uses <span class="h-dot">, washmen.html uses <div class="health-item"><span class="hd">
        if (dotsContainer.classList.contains('health-dots')) {
          const dot = document.createElement('span');
          dot.className = 'h-dot ' + (ok ? 'ok' : 'err');
          dot.title = label;
          dotsContainer.appendChild(dot);
        } else {
          const item = document.createElement('div');
          item.className = 'health-item';
          item.innerHTML = `<span class="hd ${ok ? 'ok' : 'err'}"></span>${svc.name}`;
          dotsContainer.appendChild(item);
        }
        healthState[svc.name] = svc.status;
      });
    }

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
    const pending = pendingActions[svc.name];
    const restartBtn = div.querySelector('.status-restart');
    if (restartBtn && pending === 'restarting') {
      restartBtn.textContent = 'Restarting...';
      restartBtn.disabled = true;
      restartBtn.classList.add('btn-pending');
    }
    if (restartBtn) {
      restartBtn.onclick = async () => {
        pendingActions[svc.name] = 'restarting';
        restartBtn.textContent = 'Restarting...';
        restartBtn.disabled = true;
        restartBtn.classList.add('btn-pending');
        await fetch('/api/restart-service', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ service: svc.name }),
        });
        for (let i = 0; i < 8; i++) {
          await new Promise(r => setTimeout(r, 2000));
          await checkHealth();
          if (healthState[svc.name] === 'healthy') break;
        }
        delete pendingActions[svc.name];
        await checkHealth();
        refreshPreview();
      };
    }
    const stopBtn = div.querySelector('.status-stop');
    if (stopBtn && pending === 'stopping') {
      stopBtn.textContent = 'Stopping...';
      stopBtn.disabled = true;
      stopBtn.classList.add('btn-pending');
    }
    if (stopBtn) {
      stopBtn.onclick = async () => {
        pendingActions[svc.name] = 'stopping';
        stopBtn.textContent = 'Stopping...';
        stopBtn.disabled = true;
        stopBtn.classList.add('btn-pending');
        await fetch('/api/stop-service', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: svc.port }),
        });
        for (let i = 0; i < 5; i++) {
          await new Promise(r => setTimeout(r, 1000));
          await checkHealth();
          if (healthState[svc.name] !== 'healthy') break;
        }
        delete pendingActions[svc.name];
        await checkHealth();
      };
    }
    listEl.appendChild(div);
  });
}
