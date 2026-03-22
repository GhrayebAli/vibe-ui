let fillEl = null;
let amountEl = null;
const DAILY_BUDGET = 20;

export function initBudget(fill, amount) {
  fillEl = fill;
  amountEl = amount;
}

export function updateBudget(totalCost) {
  if (totalCost == null || !fillEl || !amountEl) return;
  const pct = Math.min((totalCost / DAILY_BUDGET) * 100, 100);
  fillEl.style.width = pct + '%';
  fillEl.className = 'budget-fill' + (pct >= 100 ? ' crit' : pct >= 80 ? ' warn' : '');
  amountEl.textContent = '$' + totalCost.toFixed(2) + ' / $' + DAILY_BUDGET;

  // Lock input at budget
  if (totalCost >= DAILY_BUDGET) {
    const input = document.getElementById('input');
    if (input) {
      input.disabled = true;
      input.placeholder = 'Daily budget reached — contact engineering to increase';
    }
  }
}
