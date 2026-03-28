// Easter Egg — Click Whaly 5 times for a surprise greeting
const CLICKS_NEEDED = 5;
const CLICK_WINDOW = 2000;
const BUBBLE_DURATION = 8000;

let clickTimestamps = [];
let eggActive = false;

// Delegate click on Whaly image (it's dynamically created)
document.addEventListener('click', (e) => {
  const img = e.target.closest('.whaly-placeholder img');
  if (!img || eggActive) return;

  const now = Date.now();
  clickTimestamps.push(now);
  clickTimestamps = clickTimestamps.filter(t => now - t < CLICK_WINDOW);

  if (clickTimestamps.length >= CLICKS_NEEDED) {
    clickTimestamps = [];
    activateEgg(img);
  }
});

function activateEgg(img) {
  eggActive = true;
  const placeholder = img.closest('.whaly-placeholder');

  // Whaly wiggle
  img.classList.add('whaly-wiggle');
  img.addEventListener('animationend', () => img.classList.remove('whaly-wiggle'), { once: true });

  // Chat bubble
  const bubble = document.createElement('div');
  bubble.className = 'whaly-bubble';
  bubble.innerHTML = '🐋 <strong>Whaly</strong>: Oi! Stop poking me! I was napping between deploys. Yes, I live here. No, I don\'t know why your build failed. Have you tried turning Claude off and on again? ...just kidding, please don\'t. I\'m not paid enough for that. 💤';
  placeholder.appendChild(bubble);

  // Remove after duration
  setTimeout(() => {
    bubble.classList.add('whaly-bubble-out');
    bubble.addEventListener('animationend', () => {
      bubble.remove();
      eggActive = false;
    }, { once: true });
  }, BUBBLE_DURATION);
}
