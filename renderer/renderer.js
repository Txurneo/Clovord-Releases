const versionElement = document.getElementById("version");
const statusLog = document.getElementById("status-log");
const bootScreen = document.getElementById("boot-screen");
const bootStatusElement = document.getElementById("boot-status");
const appView = document.getElementById("clovord-view");
const progressContainer = document.getElementById("boot-progress");
const progressTrack = document.getElementById("boot-progress-track");
const progressBar = document.getElementById("boot-progress-bar");
const progressLabel = document.getElementById("boot-progress-label");

const updateUiState = {
    available: false,
    ready: false,
    downloading: false,
    percent: 0,
    downloadRequested: false,
    installRequested: false
};

const updateErrorMessages = {
    DISABLED_IN_DEV: "Auto-updater deaktiviert (Entwicklungsmodus).",
    ALREADY_CHECKING: "Ein Update-Check läuft bereits.",
    DOWNLOAD_IN_PROGRESS: "Update-Download läuft bereits.",
    READY_TO_INSTALL: "Update bereits heruntergeladen.",
    UPDATE_AVAILABLE: "Update bereits verfügbar.",
    NO_UPDATE_AVAILABLE: "Kein Update verfügbar.",
    NOT_READY: "Kein Update zur Installation bereit.",
    UNKNOWN: "Unbekannter Update-Fehler."
};

let lastLoggedProgress = null;
let appRevealTimer = null;
let appVisible = false;
let autoDownloadInFlight = false;
let installInFlight = false;

function resolveUpdateMessage(code, fallback) {
    if (typeof code !== "string" || code.length === 0) {
        return fallback ?? "Unbekannter Update-Fehler.";
    }
    return updateErrorMessages[code] ?? fallback ?? code;
}

function appendStatus(message) {
    if (!statusLog) {
        return;
    }

    const lines = statusLog.textContent
        ? statusLog.textContent.split(/\r?\n/).filter(Boolean)
        : [];
    lines.push(`${new Date().toLocaleTimeString()} ${message}`);
    const trimmed = lines.slice(-120);
    statusLog.textContent = trimmed.join("\n");
    statusLog.scrollTop = statusLog.scrollHeight;
}

function setBootStatus(message) {
    if (bootStatusElement) {
        bootStatusElement.textContent = message;
    }
}

function updateProgress(percent) {
    if (!progressContainer || !progressTrack || !progressBar || !progressLabel) {
        return;
    }

    const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
    progressContainer.classList.remove("hidden");
    progressTrack.setAttribute("aria-valuenow", String(safePercent));
    progressBar.style.width = `${safePercent}%`;
    progressLabel.textContent = `${safePercent}%`;
}

function clearProgress() {
    if (progressContainer) {
        progressContainer.classList.add("hidden");
    }
    if (progressTrack) {
        progressTrack.setAttribute("aria-valuenow", "0");
    }
    if (progressBar) {
        progressBar.style.width = "0%";
    }
    if (progressLabel) {
        progressLabel.textContent = "0%";
    }
}

function scheduleAppReveal(delay = 800) {
    if (appVisible) {
        return;
    }

    if (appRevealTimer) {
        clearTimeout(appRevealTimer);
    }

    appRevealTimer = setTimeout(() => {
        appRevealTimer = null;
        if (appVisible) {
            return;
        }
        if (bootScreen) {
            bootScreen.classList.add("hidden");
        }
        if (appView) {
            appView.classList.remove("hidden");
        }
        appVisible = true;
    }, delay);
}

async function startAutoDownload() {
    if (autoDownloadInFlight || updateUiState.downloading || updateUiState.ready) {
        return;
    }

    autoDownloadInFlight = true;
    updateUiState.downloadRequested = true;
    appendStatus("Starting automatic update download...");

    try {
        const response = await window.clovordApp.downloadUpdate();
        if (!response?.success) {
            const errorKey = response?.error;
            if (errorKey === "DOWNLOAD_IN_PROGRESS") {
                appendStatus("Update download already in progress.");
                return;
            }

            const message = resolveUpdateMessage(errorKey, `Unable to start download: ${errorKey}`);
            appendStatus(message);
            setBootStatus("Update download konnte nicht gestartet werden. Starte trotzdem...");
            updateUiState.downloadRequested = false;
            scheduleAppReveal(1500);
        }
    } catch (error) {
        appendStatus(`Unable to start update download: ${error}`);
        setBootStatus("Update-Download fehlgeschlagen. Starte trotzdem...");
        updateUiState.downloadRequested = false;
        scheduleAppReveal(1500);
    } finally {
        autoDownloadInFlight = false;
    }
}

async function startInstall() {
    if (installInFlight || updateUiState.installRequested || !updateUiState.ready) {
        return;
    }

    installInFlight = true;
    updateUiState.installRequested = true;
    appendStatus("Requesting application restart to install update...");

    try {
        const response = await window.clovordApp.installUpdate();
        if (!response?.success && response?.error) {
            const message = resolveUpdateMessage(response.error, `Unable to start installation: ${response.error}`);
            appendStatus(message);
            setBootStatus("Update bereit, aber automatischer Neustart fehlgeschlagen.");
            scheduleAppReveal(2000);
        }
    } catch (error) {
        appendStatus(`Install request failed: ${error}`);
        setBootStatus("Update konnte nicht installiert werden. Bitte manuell neu starten.");
        scheduleAppReveal(2000);
    } finally {
        installInFlight = false;
    }
}

function describeUpdateEvent(event) {
    if (!event || typeof event !== "object") {
        return;
    }

    switch (event.type) {
        case "disabled":
            updateUiState.available = false;
            updateUiState.ready = false;
            updateUiState.downloading = false;
            updateUiState.percent = 0;
            updateUiState.downloadRequested = false;
            updateUiState.installRequested = false;
            clearProgress();
            setBootStatus("Auto-updater deaktiviert (Entwicklungsmodus).");
            appendStatus("Auto-updater deaktiviert (Entwicklungsmodus).");
            scheduleAppReveal(400);
            break;
        case "idle":
            updateUiState.available = false;
            updateUiState.ready = false;
            updateUiState.downloading = false;
            updateUiState.percent = 0;
            updateUiState.downloadRequested = false;
            updateUiState.installRequested = false;
            clearProgress();
            setBootStatus("Updater bereit.");
            appendStatus("Auto-updater bereit.");
            scheduleAppReveal(600);
            break;
        case "checking":
            setBootStatus("Prüfe auf Updates…");
            appendStatus("Checking for updates...");
            break;
        case "available":
            updateUiState.available = true;
            updateUiState.ready = false;
            updateUiState.downloading = false;
            updateUiState.percent = 0;
            updateUiState.installRequested = false;
            updateUiState.downloadRequested = false;
            lastLoggedProgress = null;
            clearProgress();
            setBootStatus("Update verfügbar. Starte Download…");
            appendStatus("Update available. Starting automatic download.");
            startAutoDownload();
            break;
        case "progress":
            updateUiState.available = true;
            updateUiState.downloading = true;
            if (event.payload && typeof event.payload.percent === "number") {
                updateUiState.percent = event.payload.percent;
                updateProgress(event.payload.percent);
                const rounded = Math.floor(event.payload.percent);
                if (lastLoggedProgress === null || rounded - lastLoggedProgress >= 5) {
                    appendStatus(`Download progress: ${rounded}%`);
                    lastLoggedProgress = rounded;
                }
            } else {
                appendStatus("Download progress event received.");
            }
            setBootStatus("Update wird heruntergeladen…");
            break;
        case "warning":
            if (event.payload?.message) {
                appendStatus(`Updater warning: ${event.payload.message}`);
            } else {
                appendStatus("Updater warning received.");
            }
            break;
        case "downloaded":
            updateUiState.available = true;
            updateUiState.ready = true;
            updateUiState.downloading = false;
            updateUiState.percent = 100;
            updateUiState.downloadRequested = true;
            lastLoggedProgress = null;
            updateProgress(100);
            setBootStatus("Update fertig – starte neu…");
            appendStatus("Update downloaded. Preparing restart.");
            startInstall();
            break;
        case "installing":
            updateUiState.available = false;
            updateUiState.ready = false;
            updateUiState.downloading = false;
            updateUiState.percent = 0;
            setBootStatus("Update wird installiert…");
            appendStatus("Installing update...");
            break;
        case "not-available":
            updateUiState.available = false;
            updateUiState.ready = false;
            updateUiState.downloading = false;
            updateUiState.percent = 0;
            updateUiState.downloadRequested = false;
            updateUiState.installRequested = false;
            lastLoggedProgress = null;
            clearProgress();
            setBootStatus("Alles aktuell. Starte Clovord…");
            appendStatus("No updates available. Launching app.");
            scheduleAppReveal();
            break;
        case "error":
            updateUiState.downloading = false;
            if (!updateUiState.ready) {
                updateUiState.percent = 0;
                clearProgress();
            }
            updateUiState.downloadRequested = false;
            setBootStatus("Update-Fehler – starte App trotzdem…");
            appendStatus(`Update error: ${event.payload}`);
            scheduleAppReveal(1500);
            break;
        default:
            appendStatus(`Event: ${event.type}`);
    }
}

window.clovordApp.getVersion().then(version => {
    if (versionElement) {
        versionElement.textContent = `Version ${version}`;
    }
}).catch(error => {
    appendStatus(`Unable to read version: ${error}`);
});

window.clovordApp.onUpdateMessage(event => {
    describeUpdateEvent(event);
});

async function bootstrapUpdater() {
    try {
        const state = await window.clovordApp.getLastUpdateEvent();
        const lastEvent = state && typeof state === "object" && "lastEvent" in state
            ? state.lastEvent
            : state;
        const checkRequested = state && typeof state === "object" && "checkRequested" in state
            ? Boolean(state.checkRequested)
            : false;

        if (state && typeof state === "object") {
            updateUiState.available = Boolean(state.available);
            updateUiState.ready = Boolean(state.readyToInstall);
            updateUiState.downloading = Boolean(state.downloadInProgress);
            updateUiState.percent = typeof state.downloadPercent === "number" ? state.downloadPercent : 0;

            if (updateUiState.downloading) {
                updateProgress(updateUiState.percent);
                lastLoggedProgress = Math.floor(updateUiState.percent);
            }
        }

        if (lastEvent) {
            describeUpdateEvent(lastEvent);
        } else if (updateUiState.ready) {
            setBootStatus("Update bereit – starte neu…");
            updateProgress(updateUiState.percent || 100);
            appendStatus("Update ready from previous session. Preparing restart.");
            startInstall();
        } else if (updateUiState.available && !updateUiState.downloading) {
            setBootStatus("Update verfügbar. Starte Download…");
            appendStatus("Update available from previous session. Starting download.");
            startAutoDownload();
        } else if (!updateUiState.downloading && !updateUiState.available) {
            setBootStatus("Prüfe auf Updates…");
        }

        const canCheck = !checkRequested && !updateUiState.downloading && !updateUiState.ready && !updateUiState.available;
        const shouldTrigger = canCheck && (!lastEvent || ["idle", "error", "warning", "not-available"].includes(lastEvent.type));

        if (shouldTrigger) {
            const response = await window.clovordApp.triggerUpdateCheck();
            if (response?.success) {
                appendStatus("Update check triggered.");
            } else if (response?.error) {
                appendStatus(resolveUpdateMessage(response.error, `Unable to start update check: ${response.error}`));
                scheduleAppReveal(1500);
            }
        } else if (!lastEvent && !updateUiState.downloading && !updateUiState.available) {
            scheduleAppReveal(1600);
        }
    } catch (error) {
        appendStatus(`Failed to initialize updater: ${error}`);
        setBootStatus("Updater konnte nicht gestartet werden. Starte App…");
        scheduleAppReveal(1500);
    }
}

bootstrapUpdater();

const devtoolsMessages = {
    UNAUTHORIZED: "DevTools authentication failed.",
    SECRET_NOT_CONFIGURED: "DevTools secret is not configured on this build.",
    INVALID_PAYLOAD: "DevTools authentication request was invalid.",
    MAIN_WINDOW_MISSING: "Main window unavailable – cannot toggle DevTools."
};

let devtoolsAuthInFlight = false;

async function requestDevToolsUnlock(requireSecret) {
    if (devtoolsAuthInFlight) {
        return;
    }
    devtoolsAuthInFlight = true;

    try {
        let secret = "";
        if (requireSecret) {
            const input = window.prompt("Bitte Entwickler-Code eingeben", "");
            if (input === null) {
                appendStatus("DevTools authentication cancelled.");
                return;
            }
            secret = input.trim();
        }

        const result = await window.clovordApp.authenticateDevTools(secret);
        if (!result?.success) {
            const errorKey = result?.error ?? "UNKNOWN";
            appendStatus(devtoolsMessages[errorKey] ?? `DevTools auth error: ${errorKey}`);
            return;
        }

        appendStatus(result.open ? "DevTools geöffnet." : "DevTools geschlossen.");
    } catch (error) {
        appendStatus(`DevTools auth exception: ${error}`);
    } finally {
        devtoolsAuthInFlight = false;
    }
}

window.clovordApp.onDevToolsAuthRequest(({ requireSecret }) => {
    requestDevToolsUnlock(Boolean(requireSecret));
});

window.clovordApp.onDevToolsStatus(({ open }) => {
    appendStatus(open ? "DevTools geöffnet." : "DevTools geschlossen.");
});
