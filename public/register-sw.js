// Service worker registration
if (typeof window !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => console.log("SW registered:", reg.scope))
      .catch((err) => console.warn("SW registration failed:", err));
  });
}
