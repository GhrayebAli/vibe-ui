let fillEl = null;
let amountEl = null;
let dailyBudget = 30; // default, overridden by server

export function initBudget(fill, amount) {
  fillEl = fill;
  amountEl = amount;
}

export function updateBudget(totalCost, budget) {
  if (budget != null) dailyBudget = budget;
  if (totalCost == null || !fillEl || !amountEl) return;
  const pct = Math.min((totalCost / dailyBudget) * 100, 100);
  fillEl.style.width = pct + '%';
  fillEl.className = 'budget-fill' + (pct >= 100 ? ' crit' : pct >= 80 ? ' warn' : '');
  amountEl.textContent = '$' + totalCost.toFixed(2) + ' / $' + dailyBudget;

  // Lock input at budget
  if (totalCost >= dailyBudget) {
    const input = document.getElementById('input');
    if (input) {
      input.disabled = true;
      input.placeholder = 'Daily budget reached — contact engineering to increase';
    }
  }
}
