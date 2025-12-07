const { app, BrowserWindow, ipcMain, globalShortcut, protocol, shell, Menu, session } = require("electron");
const path = require("path");
const fs = require("fs");
const mime = require("mime-types");
const { autoUpdater } = require("electron-updater");

const CLOVORD_SCHEME = "clovord";
const DEFAULT_ENTRY_ROUTE = "/login";
const DEFAULT_ENTRY_FILE = "login.html";
const APP_ICON_FILENAME = "favicon.ico";
const UPDATE_INTERVAL_MS = 10 * 60 * 1000;
const REMOTE_WEB_ORIGIN = process.env.CLOVORD_REMOTE_ORIGIN || "https://clovord.com";
let updateCheckTimer = null;
protocol.registerSchemesAsPrivileged([
    {
        scheme: CLOVORD_SCHEME,
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
            allowServiceWorkers: true
        }
    }
]);

const isDev = !app.isPackaged;
let mainWindow;
const devtoolsSecret = process.env.CLOVORD_DEVTOOLS_SECRET || null;
let devtoolsUnlocked = isDev;
let webAppRoot = null;

const updateState = {
    lastEvent: isDev
        ? { type: "disabled", payload: { reason: "development" } }
        : { type: "idle", payload: null },
    checkRequested: false,
    available: null,
    readyToInstall: false,
    downloadInProgress: false,
    downloadPercent: 0
};

function getWebAppRoot() {
    if (webAppRoot) {
        return webAppRoot;
    }

    webAppRoot = isDev
        ? path.resolve(__dirname, "..", "web", "clovord.com")
        : path.join(process.resourcesPath, "app-web");

    if (!fs.existsSync(webAppRoot) && isDev) {
        console.warn(`Clovord web root not found at ${webAppRoot}`);
    }

    return webAppRoot;
}

function getAppIconPath() {
    const packagedIcon = path.join(process.resourcesPath, "app.ico");
    if (!isDev && fs.existsSync(packagedIcon)) {
        return packagedIcon;
    }

    const localIcon = path.resolve(__dirname, "resources", "app.ico");
    if (fs.existsSync(localIcon)) {
        return localIcon;
    }

    const root = getWebAppRoot();
    const fallbackIco = path.join(root, APP_ICON_FILENAME);
    if (fs.existsSync(fallbackIco)) {
        return fallbackIco;
    }

    const pngPath = path.join(root, "assets", "images", "icons", "favicon.png");
    if (fs.existsSync(pngPath)) {
        return pngPath;
    }

    return null;
}

function resolveClovordAsset(requestPath) {
    // Resolve SPA-style routes to concrete files inside the bundled Clovord web root.
    const root = getWebAppRoot();
    const trimmed = typeof requestPath === "string" ? requestPath : "/";
    const basePath = trimmed === "/" || trimmed === "" ? DEFAULT_ENTRY_ROUTE : trimmed;
    const withoutLeadingSlash = basePath.replace(/^\/+/g, "");
    let normalized = path.normalize(withoutLeadingSlash === "" ? DEFAULT_ENTRY_FILE : withoutLeadingSlash);
    if (normalized === "favicon.ico") {
        const iconPath = path.join("assets", "images", "icons", "favicon.png");
        normalized = path.normalize(iconPath);
    }
    const candidates = [];

    if (normalized === "index.html") {
        normalized = DEFAULT_ENTRY_FILE;
    }

    if (normalized && normalized !== ".") {
        candidates.push(normalized);
    }

    if (!path.extname(normalized)) {
        candidates.push(`${normalized}.html`);
        candidates.push(path.join(normalized, "index.html"));
    }

    if (!candidates.includes(DEFAULT_ENTRY_FILE)) {
        candidates.push(DEFAULT_ENTRY_FILE);
    }

    for (const candidate of candidates) {
        const targetPath = path.normalize(path.join(root, candidate));
        if (!targetPath.startsWith(root)) {
            continue;
        }

        try {
            const stats = fs.statSync(targetPath);
            if (stats.isFile()) {
                return targetPath;
            }
            if (stats.isDirectory()) {
                const indexPath = path.join(targetPath, "index.html");
                if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
                    return indexPath;
                }
            }
        } catch (error) {
            // Ignore and continue with next candidate.
        }
    }

    return path.join(root, DEFAULT_ENTRY_FILE);
}

function setupClovordProtocol() {
    try {
        protocol.registerFileProtocol(CLOVORD_SCHEME, (request, callback) => {
            try {
                const url = new URL(request.url);
                const assetPath = resolveClovordAsset(decodeURIComponent(url.pathname || "/"));

                if (!fs.existsSync(assetPath)) {
                    callback({ error: -6 });
                    return;
                }

                callback({
                    path: assetPath,
                    headers: {
                        "Content-Type": mime.lookup(assetPath) || "text/plain"
                    }
                });
            } catch (error) {
                if (isDev) {
                    console.error("Failed to resolve clovord:// asset", error);
                }
                callback({ error: -2 });
            }
        });
    } catch (error) {
        if (isDev) {
            console.error("Failed to register clovord protocol", error);
        }
    }
}

function registerProtocolRedirects() {
    if (!session || !session.defaultSession) {
        return;
    }

    const filter = {
        urls: [
            `${CLOVORD_SCHEME}://app/api/*`
        ]
    };

    const remoteOriginUrl = (() => {
        try {
            return new URL(REMOTE_WEB_ORIGIN);
        } catch (error) {
            if (isDev) {
                console.warn("Invalid REMOTE_WEB_ORIGIN, defaulting to https://clovord.com", error);
            }
            return new URL("https://clovord.com");
        }
    })();

    const remoteFilter = {
        urls: [
            `${remoteOriginUrl.protocol}//${remoteOriginUrl.host}/api/*`
        ]
    };

    session.defaultSession.webRequest.onBeforeRequest(filter, (details, callback) => {
        try {
            const requestUrl = new URL(details.url);
            const redirectURL = `${REMOTE_WEB_ORIGIN}${requestUrl.pathname}${requestUrl.search}`;
            callback({ redirectURL });
        } catch (error) {
            if (isDev) {
                console.warn("Failed to redirect clovord:// API request", error);
            }
            callback({});
        }
    });

    const populateCookies = (headers, done) => {
        const url = `${remoteOriginUrl.protocol}//${remoteOriginUrl.host}`;

        const applyCookies = (cookies) => {
            if (Array.isArray(cookies) && cookies.length > 0) {
                const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
                if (cookieHeader) {
                    headers.Cookie = cookieHeader;
                }
            }
            done();
        };

        const handleError = (error) => {
            if (isDev) {
                console.warn('Unable to read cookies for remote origin', error);
            }
            done();
        };

        try {
            const result = session.defaultSession.cookies.get({ url });
            if (result && typeof result.then === 'function') {
                result.then(applyCookies).catch(handleError);
            } else {
                session.defaultSession.cookies.get({ url }, (error, cookies) => {
                    if (error) {
                        handleError(error);
                        return;
                    }
                    applyCookies(cookies);
                });
            }
        } catch (err) {
            handleError(err);
        }
    };

    session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
        const headers = {
            ...details.requestHeaders,
            Origin: REMOTE_WEB_ORIGIN
        };
        populateCookies(headers, () => callback({ requestHeaders: headers }));
    });

    session.defaultSession.webRequest.onBeforeSendHeaders(remoteFilter, (details, callback) => {
        const headers = { ...details.requestHeaders };
        populateCookies(headers, () => callback({ requestHeaders: headers }));
    });


    session.defaultSession.webRequest.onHeadersReceived(remoteFilter, (details, callback) => {
        const responseHeaders = details.responseHeaders || {};
        const setCookieEntries = [];

        for (const key of Object.keys(responseHeaders)) {
            if (key.toLowerCase() === 'set-cookie') {
                const value = responseHeaders[key];
                if (Array.isArray(value)) {
                    setCookieEntries.push(...value);
                } else if (typeof value === 'string') {
                    setCookieEntries.push(value);
                }
            }
        }

        if (setCookieEntries.length === 0) {
            callback({ responseHeaders });
            return;
        }

        const tasks = setCookieEntries.map(entry => {
            if (typeof entry !== 'string' || entry.length === 0) {
                return Promise.resolve();
            }

            const parts = entry.split(';');
            const [nameValue, ...attributes] = parts;
            const [rawName, ...rawValueParts] = nameValue.split('=');
            const name = rawName ? rawName.trim() : '';
            const value = rawValueParts.join('=').trim();
            if (!name) {
                return Promise.resolve();
            }

            const cookieDetails = {
                url: `${remoteOriginUrl.protocol}//${remoteOriginUrl.host}`,
                name,
                value,
                secure: false,
                httpOnly: false
            };

            for (const attribute of attributes) {
                const trimmed = attribute.trim();
                if (!trimmed) continue;
                const [attrKeyRaw, ...attrValueParts] = trimmed.split('=');
                const attrKey = attrKeyRaw.toLowerCase();
                const attrValue = attrValueParts.join('=').trim();

                switch (attrKey) {
                    case 'path':
                        cookieDetails.path = attrValue || '/';
                        break;
                    case 'domain':
                        cookieDetails.domain = attrValue || undefined;
                        break;
                    case 'max-age':
                        {
                            const maxAge = Number.parseInt(attrValue, 10);
                            if (Number.isFinite(maxAge)) {
                                cookieDetails.expirationDate = Math.floor(Date.now() / 1000) + maxAge;
                            }
                        }
                        break;
                    case 'expires':
                        {
                            const expiry = Number.isNaN(Date.parse(attrValue)) ? null : Date.parse(attrValue);
                            if (expiry) {
                                cookieDetails.expirationDate = Math.floor(expiry / 1000);
                            }
                        }
                        break;
                    case 'samesite':
                        {
                            const mode = attrValue.toLowerCase();
                            if (mode === 'lax') {
                                cookieDetails.sameSite = 'lax';
                            } else if (mode === 'strict') {
                                cookieDetails.sameSite = 'strict';
                            } else if (mode === 'none') {
                                cookieDetails.sameSite = 'no_restriction';
                            }
                        }
                        break;
                    default:
                        if (attrKey === 'secure' && !attrValue) {
                            cookieDetails.secure = true;
                        } else if (attrKey === 'httponly' && !attrValue) {
                            cookieDetails.httpOnly = true;
                        }
                        break;
                }
            }

            if (attributes.some(attr => attr.trim().toLowerCase() === 'secure')) {
                cookieDetails.secure = true;
            }
            if (attributes.some(attr => attr.trim().toLowerCase() === 'httponly')) {
                cookieDetails.httpOnly = true;
            }

            return session.defaultSession.cookies.set(cookieDetails).catch(error => {
                if (isDev) {
                    console.warn('Failed to persist cookie from response', error, cookieDetails);
                }
            });
        });

        Promise.all(tasks).finally(() => {
            callback({ responseHeaders });
        });
    });
}

function emitUpdateEvent(type, payload) {
    const event = { type, payload };
    updateState.lastEvent = event;
    switch (type) {
        case "checking":
            updateState.checkRequested = true;
            break;
        case "available":
            updateState.checkRequested = false;
            updateState.available = payload || {};
            updateState.readyToInstall = false;
            updateState.downloadInProgress = false;
            updateState.downloadPercent = 0;
            break;
        case "not-available":
            updateState.checkRequested = false;
            updateState.available = null;
            updateState.readyToInstall = false;
            updateState.downloadInProgress = false;
            updateState.downloadPercent = 0;
            break;
        case "progress":
            updateState.downloadInProgress = true;
            if (payload && typeof payload.percent === "number") {
                updateState.downloadPercent = payload.percent;
            }
            break;
        case "downloaded":
            updateState.checkRequested = false;
            updateState.readyToInstall = true;
            updateState.downloadInProgress = false;
            updateState.downloadPercent = 100;
            break;
        case "installing":
            updateState.readyToInstall = false;
            updateState.downloadInProgress = false;
            updateState.available = null;
            break;
        case "error":
            updateState.checkRequested = false;
            updateState.downloadInProgress = false;
            break;
        default:
            break;
    }
    if (mainWindow) {
        try {
            mainWindow.webContents.send("auto-updater-message", event);
        } catch (error) {
            if (isDev) {
                console.warn("Failed to forward updater status", error);
            }
        }
    }
}

function initiateUpdateCheck(options = {}) {
    const force = Boolean(options.force);

    if (isDev) {
        return { started: false, reason: "DISABLED_IN_DEV" };
    }

    if (updateState.checkRequested) {
        return { started: false, reason: "ALREADY_CHECKING" };
    }

    if (updateState.downloadInProgress) {
        return { started: false, reason: "DOWNLOAD_IN_PROGRESS" };
    }

    if (updateState.readyToInstall && !force) {
        return { started: false, reason: "READY_TO_INSTALL" };
    }

    if (updateState.available && !force) {
        return { started: false, reason: "UPDATE_AVAILABLE" };
    }

    updateState.checkRequested = true;
    autoUpdater.checkForUpdates().catch(error => {
        updateState.checkRequested = false;
        emitUpdateEvent("error", error == null ? "Failed to check for updates" : error.toString());
    });

    return { started: true };
}

function scheduleRecurringUpdateChecks() {
    if (isDev || updateCheckTimer !== null) {
        return;
    }

    updateCheckTimer = setInterval(() => {
        const result = initiateUpdateCheck({ force: true });
        if (!result.started && result.reason === "DISABLED_IN_DEV") {
            clearInterval(updateCheckTimer);
            updateCheckTimer = null;
        }
    }, UPDATE_INTERVAL_MS);
}

function toggleDevTools() {
    if (!mainWindow) {
        return;
    }

    if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
    } else {
        mainWindow.webContents.openDevTools({ mode: "detach" });
    }
}

function createWindow() {
    const iconPath = getAppIconPath();
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        icon: iconPath && fs.existsSync(iconPath) ? iconPath : undefined,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    if (typeof mainWindow.setMenuBarVisibility === "function") {
        mainWindow.setMenuBarVisibility(false);
    }
    if (typeof mainWindow.setAutoHideMenuBar === "function") {
        mainWindow.setAutoHideMenuBar(true);
    }

    mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
    attachNavigationGuards(mainWindow);

    mainWindow.webContents.once("did-finish-load", () => {
        if (updateState.lastEvent) {
            try {
                mainWindow.webContents.send("auto-updater-message", updateState.lastEvent);
            } catch (error) {
                if (isDev) {
                    console.warn("Failed to send initial updater state", error);
                }
            }
        }
    });

    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}

function attachNavigationGuards(targetWindow) {
    if (!targetWindow) {
        return;
    }

    targetWindow.webContents.setWindowOpenHandler(({ url }) => {
        try {
            const parsed = new URL(url);
            if (parsed.protocol === `${CLOVORD_SCHEME}:`) {
                return { action: "allow" };
            }

            if (["https:", "mailto:"].includes(parsed.protocol)) {
                shell.openExternal(url);
            }
        } catch (error) {
            if (isDev) {
                console.warn("Blocked window open for", url, error);
            }
        }

        return { action: "deny" };
    });

    targetWindow.webContents.on("will-navigate", (event, url) => {
        try {
            if (url.startsWith(`${CLOVORD_SCHEME}://`)) {
                return;
            }

            event.preventDefault();
            shell.openExternal(url);
        } catch (error) {
            if (isDev) {
                console.warn("Navigation guard error", error);
            }
        }
    });
}

function registerDevtoolsShortcuts() {
    const shortcuts = ["Control+Shift+I", "CommandOrControl+Alt+I"];

    shortcuts.forEach(shortcut => {
        const registered = globalShortcut.register(shortcut, () => {
            if (!mainWindow) {
                return;
            }

            if (devtoolsUnlocked) {
                toggleDevTools();
                mainWindow.webContents.send("devtools-status", {
                    open: mainWindow.webContents.isDevToolsOpened()
                });
                return;
            }

            mainWindow.webContents.send("devtools-auth-request", {
                requireSecret: Boolean(devtoolsSecret)
            });
        });

        if (!registered && isDev) {
            console.warn(`Failed to register shortcut ${shortcut}`);
        }
    });
}

function setupAutoUpdater() {
    const updaterToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;
    if (updaterToken) {
        autoUpdater.requestHeaders = {
            Authorization: `token ${updaterToken.trim()}`
        };
    } else {
        emitUpdateEvent("warning", {
            reason: "NO_TOKEN",
            message: "GitHub token fehlt – Update-Feed für private Releases nicht erreichbar"
        });
    }

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on("checking-for-update", () => emitUpdateEvent("checking", null));
    autoUpdater.on("update-available", info => emitUpdateEvent("available", info));
    autoUpdater.on("update-not-available", info => emitUpdateEvent("not-available", info));
    autoUpdater.on("error", error => emitUpdateEvent("error", error == null ? "Unknown error" : error.toString()));
    autoUpdater.on("download-progress", progress => emitUpdateEvent("progress", progress));
    autoUpdater.on("update-downloaded", info => {
        emitUpdateEvent("downloaded", info);
    });

    initiateUpdateCheck({ force: true });

    scheduleRecurringUpdateChecks();
}

app.whenReady().then(() => {
    setupClovordProtocol();
    registerProtocolRedirects();
    Menu.setApplicationMenu(null);
    createWindow();
    setupAutoUpdater();
    registerDevtoolsShortcuts();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    if (updateCheckTimer) {
        clearInterval(updateCheckTimer);
        updateCheckTimer = null;
    }
});

ipcMain.handle("app:get-version", () => app.getVersion());

ipcMain.handle("updates:get-last-event", () => ({ ...updateState }));

ipcMain.handle("updates:check", () => {
    const result = initiateUpdateCheck();
    if (result.started) {
        return { success: true };
    }
    return { success: false, error: result.reason };
});

ipcMain.handle("updates:download", async () => {
    if (isDev) {
        return { success: false, error: "DISABLED_IN_DEV" };
    }

    if (!updateState.available) {
        return { success: false, error: "NO_UPDATE_AVAILABLE" };
    }

    if (updateState.downloadInProgress) {
        return { success: false, error: "DOWNLOAD_IN_PROGRESS" };
    }

    if (updateState.readyToInstall) {
        return { success: false, error: "READY_TO_INSTALL" };
    }

    try {
        emitUpdateEvent("progress", { percent: updateState.downloadPercent || 0 });
        await autoUpdater.downloadUpdate();
        return { success: true };
    } catch (error) {
        updateState.downloadInProgress = false;
        emitUpdateEvent("error", error == null ? "Failed to download update" : error.toString());
        return { success: false, error: error == null ? "UNKNOWN" : error.toString() };
    }
});

ipcMain.handle("updates:install", () => {
    if (isDev) {
        return { success: false, error: "DISABLED_IN_DEV" };
    }

    if (!updateState.readyToInstall) {
        return { success: false, error: "NOT_READY" };
    }

    try {
        emitUpdateEvent("installing", null);
        autoUpdater.quitAndInstall();
        return { success: true };
    } catch (error) {
        emitUpdateEvent("error", error == null ? "Failed to install update" : error.toString());
        return { success: false, error: error == null ? "UNKNOWN" : error.toString() };
    }
});

ipcMain.handle("devtools:authenticate", (_event, payload) => {
    if (!mainWindow) {
        return { success: false, error: "MAIN_WINDOW_MISSING" };
    }

    toggleDevTools();
    return { success: true, unlocked: true, open: mainWindow.webContents.isDevToolsOpened() };
});
