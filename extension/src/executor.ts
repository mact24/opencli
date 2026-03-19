/**
 * Stealth JS executor via chrome.scripting API.
 *
 * Architecture:
 * 1. Inject code as a <script> tag in MAIN world (bypasses CSP where eval is blocked)
 * 2. Script stores result in a hidden DOM element
 * 3. ISOLATED world script polls and reads the result
 *
 * This avoids both:
 * - CSP `unsafe-eval` restrictions (no eval() used)
 * - chrome.scripting MAIN world async return value limitations
 */

// Monotonic counter for unique result IDs
let _evalCounter = 0;

/**
 * Normalize JS code for evaluation:
 * - Already an IIFE → as-is
 * - Arrow/function literal → wrap as IIFE
 * - Everything else → bare expression
 */
function wrapForEval(js: string): string {
  const code = js.trim();
  if (!code) return 'undefined';
  if (/^\([\s\S]*\)\s*\(.*\)\s*$/.test(code)) return code;
  if (/^(async\s+)?(\([^)]*\)|[A-Za-z_]\w*)\s*=>/.test(code)) return `(${code})()`;
  if (/^(async\s+)?function[\s(]/.test(code)) return `(${code})()`;
  return code;
}

/**
 * Evaluate JS in the target tab's MAIN world via script tag injection.
 * Safe against CSP restrictions that block eval().
 */
export async function evaluate(tabId: number, expression: string): Promise<unknown> {
  const code = wrapForEval(expression.trim());
  const resultId = `__opencli_r${++_evalCounter}_${Date.now()}`;

  // Step 1: Create result holder + inject script tag in MAIN world
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (userCode: string, rid: string) => {
        // Create hidden element to store result
        const holder = document.createElement('div');
        holder.id = rid;
        holder.style.display = 'none';
        document.documentElement.appendChild(holder);

        // Create and inject a script tag with the user code wrapped in async handler
        const script = document.createElement('script');
        script.textContent = `
          (async () => {
            const __holder = document.getElementById(${JSON.stringify(rid)});
            try {
              const __result = await (async () => { return ${userCode}; })();
              __holder.dataset.result = JSON.stringify({ ok: true, data: __result });
            } catch (__err) {
              __holder.dataset.result = JSON.stringify({ ok: false, error: __err?.message || String(__err) });
            }
          })();
        `;
        document.documentElement.appendChild(script);
        // Clean up the script tag immediately (it's already executed)
        script.remove();
      },
      args: [code, resultId],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`executeScript failed: ${msg}`);
  }

  // Step 2: Poll from ISOLATED world to read the result
  const maxWait = 120000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      // ISOLATED world can still read DOM elements & dataset
      func: (rid: string) => {
        const el = document.getElementById(rid);
        if (!el) return null;
        const result = el.dataset.result;
        if (!result) return null;
        el.remove();
        return result;
      },
      args: [resultId],
    });

    const resultText = results?.[0]?.result as string | null;
    if (resultText) {
      try {
        const parsed = JSON.parse(resultText);
        if (!parsed.ok) throw new Error(parsed.error);
        return parsed.data;
      } catch (err) {
        if (err instanceof SyntaxError) return resultText;
        throw err;
      }
    }

    await new Promise(r => setTimeout(r, 100));
  }

  // Cleanup on timeout
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (rid: string) => document.getElementById(rid)?.remove(),
      args: [resultId],
    });
  } catch { /* ignore */ }

  throw new Error('Evaluate timeout (120s)');
}

export const evaluateAsync = evaluate;

/**
 * Capture a screenshot via chrome.tabs.captureVisibleTab().
 */
export async function screenshot(
  tabId: number,
  options: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean } = {},
): Promise<string> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
    await new Promise(r => setTimeout(r, 100));
  }

  const format = options.format ?? 'png';
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, {
    format,
    quality: format === 'jpeg' ? (options.quality ?? 80) : undefined,
  });

  return dataUrl.replace(/^data:image\/\w+;base64,/, '');
}

/** No-op in scripting mode */
export function detach(_tabId: number): void {}

/** No-op in scripting mode */
export function registerListeners(): void {}
