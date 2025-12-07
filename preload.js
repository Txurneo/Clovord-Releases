const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clovordApp", {
    onUpdateMessage(callback) {
        const subscription = (_event, data) => callback(data);
        ipcRenderer.on("auto-updater-message", subscription);
        return () => ipcRenderer.removeListener("auto-updater-message", subscription);
    },
    getVersion() {
        return ipcRenderer.invoke("app:get-version");
    },
    onDevToolsAuthRequest(callback) {
        const listener = (_event, data) => callback(data ?? {});
        ipcRenderer.on("devtools-auth-request", listener);
        return () => ipcRenderer.removeListener("devtools-auth-request", listener);
    },
    onDevToolsStatus(callback) {
        const listener = (_event, data) => callback(data ?? {});
        ipcRenderer.on("devtools-status", listener);
        return () => ipcRenderer.removeListener("devtools-status", listener);
    },
    authenticateDevTools(secret) {
        return ipcRenderer.invoke("devtools:authenticate", { secret });
    },
    getLastUpdateEvent() {
        return ipcRenderer.invoke("updates:get-last-event");
    },
    triggerUpdateCheck() {
        return ipcRenderer.invoke("updates:check");
    },
    downloadUpdate() {
        return ipcRenderer.invoke("updates:download");
    },
    installUpdate() {
        return ipcRenderer.invoke("updates:install");
    }
});
