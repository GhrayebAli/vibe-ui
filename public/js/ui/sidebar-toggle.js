// Sidebar hamburger toggle for mobile/tablet viewports
import { $ } from '../core/dom.js';

const btn = document.getElementById('sidebar-toggle-btn');
const backdrop = document.getElementById('sidebar-backdrop');
const mq = window.matchMedia('(max-width: 1024px)');

function openSidebar()  { document.body.classList.add('sidebar-open'); }
function closeSidebar() { document.body.classList.remove('sidebar-open'); }

if (btn) btn.addEventListener('click', () => {
  document.body.classList.toggle('sidebar-open');
});

if (backdrop) backdrop.addEventListener('click', closeSidebar);

// Close sidebar when a session is selected on mobile
if ($.sessionList) {
  $.sessionList.addEventListener('click', (e) => {
    if (mq.matches && e.target.closest('li')) {
      closeSidebar();
    }
  });
}

// Close sidebar if viewport grows past tablet breakpoint
mq.addEventListener('change', (e) => {
  if (!e.matches) closeSidebar();
});
