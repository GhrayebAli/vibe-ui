// Guided tour — uses Driver.js to walk users through Washmen Ops v2 features
const TOUR_KEY = 'claudeck-tour-completed';

function buildSteps() {
  const steps = [
  // ── Navigation ──────────────────────────────────
  {
    element: '#home-btn',
    popover: {
      title: 'Home',
      description: 'Return to the landing screen to switch branches or start a new feature.',
      side: 'right',
      align: 'center',
    },
  },
  {
    element: '#mode-toggle',
    popover: {
      title: 'Build Mode',
      description: 'Choose between Discover (read-only), Plan (design first), and Build (full edit) modes.',
      side: 'right',
      align: 'center',
    },
  },
  {
    element: '#model-picker',
    popover: {
      title: 'AI Model',
      description: 'Select which AI model to use for your session.',
      side: 'right',
      align: 'center',
    },
  },

  // ── Landing ─────────────────────────────────────
  {
    element: '#landing',
    popover: {
      title: 'Landing Screen',
      description: 'Your starting point — discover the codebase, resume a branch, or build a new feature.',
      side: 'right',
      align: 'start',
    },
  },

  // ── Chat Input ──────────────────────────────────
  {
    element: '#attach-btn',
    popover: {
      title: 'Attach Files',
      description: 'Attach images or files as context for the AI.',
      side: 'top',
      align: 'center',
    },
  },
  {
    element: '#input',
    popover: {
      title: 'Chat Input',
      description: 'Describe what you want to build. <kbd>Shift+Enter</kbd> for new lines, <kbd>Enter</kbd> to send.',
      side: 'top',
      align: 'center',
    },
  },
  {
    element: '#send-btn',
    popover: {
      title: 'Send Message',
      description: 'Send your message to the AI, or press <kbd>Enter</kbd>.',
      side: 'top',
      align: 'center',
    },
  },

  // ── Right Panel ─────────────────────────────────
  {
    element: '#tab-preview',
    popover: {
      title: 'Live Preview',
      description: 'See your changes in real time as the AI edits code.',
      side: 'left',
      align: 'start',
    },
  },
  {
    element: '#tab-code',
    popover: {
      title: 'Code View',
      description: 'Browse and inspect the files the AI has modified.',
      side: 'left',
      align: 'start',
    },
  },
  {
    element: '#tab-console',
    popover: {
      title: 'Console',
      description: 'View server logs and browser console output for debugging.',
      side: 'left',
      align: 'start',
    },
  },

  // ── Budget ──────────────────────────────────────
  {
    element: '.budget-track',
    popover: {
      title: 'Budget Tracker',
      description: 'Monitor your daily AI usage. The bar fills as you use more of your budget.',
      side: 'top',
      align: 'center',
    },
  },
  ];

  return steps;
}

/**
 * Start the guided tour.
 */
export function startTour() {
  if (typeof window.driver === 'undefined') {
    console.warn('Driver.js not loaded');
    return;
  }

  const driverObj = window.driver.js.driver({
    showProgress: true,
    animate: true,
    overlayColor: 'rgba(0, 0, 0, 0.35)',
    stagePadding: 6,
    stageRadius: 8,
    smoothScroll: true,
    popoverClass: 'claudeck-tour',
    allowClose: true,
    doneBtnText: 'Finish',
    nextBtnText: 'Next →',
    prevBtnText: '← Back',
    showButtons: ['next', 'previous', 'close'],
    steps: buildSteps(),
    onDestroyed: () => {
      localStorage.setItem(TOUR_KEY, '1');
    },
  });

  driverObj.drive();
}
