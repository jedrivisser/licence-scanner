// The about page: cache the site for offline use (the apps register the same worker).
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
