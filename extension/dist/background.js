//#region src/protocol.ts
/** Default daemon port */
var DAEMON_PORT = 19825;
var DAEMON_HOST = "localhost";
var DAEMON_WS_URL = `ws://${DAEMON_HOST}:${DAEMON_PORT}/ext`;
`${DAEMON_HOST}${DAEMON_PORT}`;
/** Base reconnect delay for extension WebSocket (ms) */
var WS_RECONNECT_BASE_DELAY = 2e3;
/** Max reconnect delay (ms) */
var WS_RECONNECT_MAX_DELAY = 6e4;
//#endregion
//#region src/cdp.ts
/**
* CDP execution via chrome.debugger API.
*
* chrome.debugger only needs the "debugger" permission — no host_permissions.
* It can attach to any http/https tab. Avoid chrome:// and chrome-extension://
* tabs (resolveTabId in background.ts filters them).
*/
var attached = /* @__PURE__ */ new Set();
async function ensureAttached(tabId) {
	if (attached.has(tabId)) return;
	try {
		await chrome.debugger.attach({ tabId }, "1.3");
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes("Another debugger is already attached")) {
			try {
				await chrome.debugger.detach({ tabId });
			} catch {}
			try {
				await chrome.debugger.attach({ tabId }, "1.3");
			} catch {
				throw new Error(`attach failed: ${msg}`);
			}
		} else throw new Error(`attach failed: ${msg}`);
	}
	attached.add(tabId);
	try {
		await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
	} catch {}
}
async function evaluate(tabId, expression) {
	await ensureAttached(tabId);
	const result = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
		expression,
		returnByValue: true,
		awaitPromise: true
	});
	if (result.exceptionDetails) {
		const errMsg = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Eval error";
		throw new Error(errMsg);
	}
	return result.result?.value;
}
var evaluateAsync = evaluate;
/**
* Capture a screenshot via CDP Page.captureScreenshot.
* Returns base64-encoded image data.
*/
async function screenshot(tabId, options = {}) {
	await ensureAttached(tabId);
	const format = options.format ?? "png";
	if (options.fullPage) {
		const metrics = await chrome.debugger.sendCommand({ tabId }, "Page.getLayoutMetrics");
		const size = metrics.cssContentSize || metrics.contentSize;
		if (size) await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
			mobile: false,
			width: Math.ceil(size.width),
			height: Math.ceil(size.height),
			deviceScaleFactor: 1
		});
	}
	try {
		const params = { format };
		if (format === "jpeg" && options.quality !== void 0) params.quality = Math.max(0, Math.min(100, options.quality));
		return (await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", params)).data;
	} finally {
		if (options.fullPage) await chrome.debugger.sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride").catch(() => {});
	}
}
function detach(tabId) {
	if (!attached.has(tabId)) return;
	attached.delete(tabId);
	try {
		chrome.debugger.detach({ tabId });
	} catch {}
}
function registerListeners() {
	chrome.tabs.onRemoved.addListener((tabId) => {
		attached.delete(tabId);
	});
	chrome.debugger.onDetach.addListener((source) => {
		if (source.tabId) attached.delete(source.tabId);
	});
}
//#endregion
//#region src/background.ts
var ws = null;
var reconnectTimer = null;
var reconnectAttempts = 0;
var _origLog = console.log.bind(console);
var _origWarn = console.warn.bind(console);
var _origError = console.error.bind(console);
function forwardLog(level, args) {
	if (!ws || ws.readyState !== WebSocket.OPEN) return;
	try {
		const msg = args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
		ws.send(JSON.stringify({
			type: "log",
			level,
			msg,
			ts: Date.now()
		}));
	} catch {}
}
console.log = (...args) => {
	_origLog(...args);
	forwardLog("info", args);
};
console.warn = (...args) => {
	_origWarn(...args);
	forwardLog("warn", args);
};
console.error = (...args) => {
	_origError(...args);
	forwardLog("error", args);
};
function connect() {
	if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
	try {
		ws = new WebSocket(DAEMON_WS_URL);
	} catch {
		scheduleReconnect();
		return;
	}
	ws.onopen = () => {
		console.log("[opencli] Connected to daemon");
		reconnectAttempts = 0;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
	};
	ws.onmessage = async (event) => {
		try {
			const result = await handleCommand(JSON.parse(event.data));
			ws?.send(JSON.stringify(result));
		} catch (err) {
			console.error("[opencli] Message handling error:", err);
		}
	};
	ws.onclose = () => {
		console.log("[opencli] Disconnected from daemon");
		ws = null;
		scheduleReconnect();
	};
	ws.onerror = () => {
		ws?.close();
	};
}
function scheduleReconnect() {
	if (reconnectTimer) return;
	reconnectAttempts++;
	const delay = Math.min(WS_RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts - 1), WS_RECONNECT_MAX_DELAY);
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		connect();
	}, delay);
}
var automationWindowId = null;
/** Get or create the dedicated automation window. */
async function getAutomationWindow() {
	if (automationWindowId !== null) try {
		await chrome.windows.get(automationWindowId);
		return automationWindowId;
	} catch {
		automationWindowId = null;
	}
	automationWindowId = (await chrome.windows.create({
		url: "about:blank",
		focused: false,
		width: 1280,
		height: 900,
		type: "normal"
	})).id;
	console.log(`[opencli] Created automation window ${automationWindowId}`);
	return automationWindowId;
}
chrome.windows.onRemoved.addListener((windowId) => {
	if (windowId === automationWindowId) {
		console.log("[opencli] Automation window closed");
		automationWindowId = null;
	}
});
var initialized = false;
function initialize() {
	if (initialized) return;
	initialized = true;
	chrome.alarms.create("keepalive", { periodInMinutes: .4 });
	registerListeners();
	connect();
	console.log("[opencli] Browser Bridge extension initialized");
}
chrome.runtime.onInstalled.addListener(() => {
	initialize();
});
chrome.runtime.onStartup.addListener(() => {
	initialize();
});
chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === "keepalive") connect();
});
async function handleCommand(cmd) {
	try {
		switch (cmd.action) {
			case "exec": return await handleExec(cmd);
			case "navigate": return await handleNavigate(cmd);
			case "tabs": return await handleTabs(cmd);
			case "cookies": return await handleCookies(cmd);
			case "screenshot": return await handleScreenshot(cmd);
			default: return {
				id: cmd.id,
				ok: false,
				error: `Unknown action: ${cmd.action}`
			};
		}
	} catch (err) {
		return {
			id: cmd.id,
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
/** Check if a URL is a debuggable web page (not chrome:// or extension page) */
function isWebUrl(url) {
	if (!url) return false;
	return !url.startsWith("chrome://") && !url.startsWith("chrome-extension://");
}
/**
* Resolve target tab in the automation window.
* If explicit tabId is given, use that directly.
* Otherwise, find or create a tab in the dedicated automation window.
*/
async function resolveTabId(tabId) {
	if (tabId !== void 0) return tabId;
	const windowId = await getAutomationWindow();
	const tabs = await chrome.tabs.query({ windowId });
	const webTab = tabs.find((t) => t.id && isWebUrl(t.url));
	if (webTab?.id) return webTab.id;
	if (tabs.length > 0 && tabs[0]?.id) return tabs[0].id;
	const newTab = await chrome.tabs.create({
		windowId,
		url: "about:blank",
		active: true
	});
	if (!newTab.id) throw new Error("Failed to create tab in automation window");
	return newTab.id;
}
async function handleExec(cmd) {
	if (!cmd.code) return {
		id: cmd.id,
		ok: false,
		error: "Missing code"
	};
	const tabId = await resolveTabId(cmd.tabId);
	try {
		const data = await evaluateAsync(tabId, cmd.code);
		return {
			id: cmd.id,
			ok: true,
			data
		};
	} catch (err) {
		return {
			id: cmd.id,
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
async function handleNavigate(cmd) {
	if (!cmd.url) return {
		id: cmd.id,
		ok: false,
		error: "Missing url"
	};
	const tabId = await resolveTabId(cmd.tabId);
	await chrome.tabs.update(tabId, { url: cmd.url });
	await new Promise((resolve) => {
		chrome.tabs.get(tabId).then((tab) => {
			if (tab.status === "complete") {
				resolve();
				return;
			}
			const listener = (id, info) => {
				if (id === tabId && info.status === "complete") {
					chrome.tabs.onUpdated.removeListener(listener);
					resolve();
				}
			};
			chrome.tabs.onUpdated.addListener(listener);
			setTimeout(() => {
				chrome.tabs.onUpdated.removeListener(listener);
				resolve();
			}, 15e3);
		});
	});
	const tab = await chrome.tabs.get(tabId);
	return {
		id: cmd.id,
		ok: true,
		data: {
			title: tab.title,
			url: tab.url,
			tabId
		}
	};
}
async function handleTabs(cmd) {
	switch (cmd.op) {
		case "list": {
			const data = (await chrome.tabs.query({})).filter((t) => isWebUrl(t.url)).map((t, i) => ({
				index: i,
				tabId: t.id,
				url: t.url,
				title: t.title,
				active: t.active
			}));
			return {
				id: cmd.id,
				ok: true,
				data
			};
		}
		case "new": {
			const tab = await chrome.tabs.create({
				url: cmd.url,
				active: true
			});
			return {
				id: cmd.id,
				ok: true,
				data: {
					tabId: tab.id,
					url: tab.url
				}
			};
		}
		case "close": {
			if (cmd.index !== void 0) {
				const target = (await chrome.tabs.query({}))[cmd.index];
				if (!target?.id) return {
					id: cmd.id,
					ok: false,
					error: `Tab index ${cmd.index} not found`
				};
				await chrome.tabs.remove(target.id);
				detach(target.id);
				return {
					id: cmd.id,
					ok: true,
					data: { closed: target.id }
				};
			}
			const tabId = await resolveTabId(cmd.tabId);
			await chrome.tabs.remove(tabId);
			detach(tabId);
			return {
				id: cmd.id,
				ok: true,
				data: { closed: tabId }
			};
		}
		case "select": {
			if (cmd.index === void 0 && cmd.tabId === void 0) return {
				id: cmd.id,
				ok: false,
				error: "Missing index or tabId"
			};
			if (cmd.tabId !== void 0) {
				await chrome.tabs.update(cmd.tabId, { active: true });
				return {
					id: cmd.id,
					ok: true,
					data: { selected: cmd.tabId }
				};
			}
			const target = (await chrome.tabs.query({}))[cmd.index];
			if (!target?.id) return {
				id: cmd.id,
				ok: false,
				error: `Tab index ${cmd.index} not found`
			};
			await chrome.tabs.update(target.id, { active: true });
			return {
				id: cmd.id,
				ok: true,
				data: { selected: target.id }
			};
		}
		default: return {
			id: cmd.id,
			ok: false,
			error: `Unknown tabs op: ${cmd.op}`
		};
	}
}
async function handleCookies(cmd) {
	const details = {};
	if (cmd.domain) details.domain = cmd.domain;
	if (cmd.url) details.url = cmd.url;
	const data = (await chrome.cookies.getAll(details)).map((c) => ({
		name: c.name,
		value: c.value,
		domain: c.domain,
		path: c.path,
		secure: c.secure,
		httpOnly: c.httpOnly,
		expirationDate: c.expirationDate
	}));
	return {
		id: cmd.id,
		ok: true,
		data
	};
}
async function handleScreenshot(cmd) {
	const tabId = await resolveTabId(cmd.tabId);
	try {
		const data = await screenshot(tabId, {
			format: cmd.format,
			quality: cmd.quality,
			fullPage: cmd.fullPage
		});
		return {
			id: cmd.id,
			ok: true,
			data
		};
	} catch (err) {
		return {
			id: cmd.id,
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
//#endregion
