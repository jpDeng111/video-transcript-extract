const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopBridge", {
  notify: (payload) => {
    const safe = {
      title: String(payload?.title || "").slice(0, 120),
      body: String(payload?.body || "").slice(0, 500)
    };
    ipcRenderer.send("app:notify", safe);
  }
});
