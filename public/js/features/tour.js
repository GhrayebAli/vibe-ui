// Guided tour — uses Driver.js to walk users through Washmen Ops v2 features
const TOUR_KEY = 'claudeck-tour-completed';

function buildSteps() {
  const all = [
  // ── Top Bar ─────────────────────────────────────
  {
    element: '#mode-toggle',
    popover: {
      title: 'Build Mode',
      description: 'Switch between <strong>Plan</strong> (design first) and <strong>Build</strong> (full edit) modes.',
      side: 'bottom',
      align: 'start',
    },
  },
  {
    element: '#model-picker',
    popover: {
      title: 'AI Model',
      description: 'Pick <strong>Haiku</strong> for speed, <strong>Sonnet</strong> for balance, or <strong>Opus</strong> for complex tasks.',
      side: 'bottom',
      align: 'end',
    },
  },

  // ── Landing ─────────────────────────────────────
  {
    element: '#landing-discover',
    popover: {
      title: 'Discover Mode',
      description: 'Explore the codebase in read-only mode. Ask questions, understand the architecture.',
      side: 'bottom',
      align: 'center',
    },
  },
  {
    element: '#landing-resume',
    popover: {
      title: 'Resume a Branch',
      description: 'Continue working on a feature branch. Shows commit history, cost, and last activity.',
      side: 'bottom',
      align: 'center',
    },
  },
  {
    element: '#landing-build',
    popover: {
      title: 'Build a Feature',
      description: 'Start a new feature — give it a name and the AI creates a branch and gets to work.',
      side: 'top',
      align: 'center',
    },
  },

  // ── Input Dock ──────────────────────────────────
  {
    element: '#input-dock',
    popover: {
      title: 'Chat Input',
      description: 'Describe what you want to build. Attach files for context. Press <strong>Enter</strong> to send.',
      side: 'top',
      align: 'center',
    },
  },

  // ── Right Panel ─────────────────────────────────
  {
    element: '.panel-tabs',
    popover: {
      title: 'Right Panel',
      description: 'Switch between <strong>Preview</strong> (live app), <strong>Code</strong> (file changes), and <strong>Console</strong> (logs).',
      side: 'left',
      align: 'start',
    },
  },
  {
    element: '#preview-wrap',
    popover: {
      title: 'Live Preview',
      description: 'See your app running in real time as the AI makes changes.',
      side: 'left',
      align: 'center',
    },
  },

  // ── Budget ──────────────────────────────────────
  {
    element: '.budget-track',
    popover: {
      title: 'Budget Tracker',
      description: 'Your daily AI spend. The bar fills as you use more of your allowance.',
      side: 'top',
      align: 'center',
    },
  },
  ];

  // Only include steps whose elements are visible in the DOM
  return all.filter(step => {
    const el = document.querySelector(step.element);
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

/**
 * Start the guided tour.
 */
export function startTour() {
  if (typeof window.driver === 'undefined') {
    console.warn('Driver.js not loaded');
    return;
  }

  const steps = buildSteps();
  if (steps.length === 0) return;

  const driverObj = window.driver.js.driver({
    showProgress: true,
    animate: true,
    overlayColor: 'rgba(0, 0, 0, 0.55)',
    stagePadding: 8,
    stageRadius: 10,
    smoothScroll: true,
    popoverClass: 'washmen-tour',
    allowClose: true,
    doneBtnText: 'Done',
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    showButtons: ['next', 'previous', 'close'],
    steps,
    onDestroyed: () => {
      localStorage.setItem(TOUR_KEY, '1');
    },
  });

  driverObj.drive();
}
