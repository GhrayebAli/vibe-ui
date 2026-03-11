// Plugin Loader — auto-discovers and loads tab-sdk plugins from /js/plugins/
//
// How it works:
//   1. Fetches GET /api/plugins → list of {name, js, css} entries
//   2. Injects <link> for each plugin's CSS (if any)
//   3. Dynamically import()s each plugin's JS module
//
// To create a new plugin, just drop files into public/js/plugins/:
//   my-plugin.js   — must call registerTab() from tab-sdk.js
//   my-plugin.css  — optional, auto-injected if present
//
// No changes to main.js, style.css, or any other file required.

export async function loadPlugins() {
  try {
    const res = await fetch("/api/plugins");
    if (!res.ok) {
      console.warn("Plugin discovery failed:", res.status);
      return;
    }

    const plugins = await res.json();
    if (!plugins.length) return;

    const loads = plugins.map(async (plugin) => {
      // Inject CSS
      if (plugin.css) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = `/${plugin.css}`;
        document.head.appendChild(link);
      }

      // Load JS module
      try {
        await import(`/${plugin.js}`);
        console.log(`Plugin loaded: ${plugin.name}`);
      } catch (err) {
        console.error(`Plugin failed: ${plugin.name}`, err);
      }
    });

    await Promise.all(loads);
  } catch (err) {
    console.error("Plugin loader error:", err);
  }
}
