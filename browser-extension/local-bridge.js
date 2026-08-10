(() => {
  "use strict";

  const marker = document.querySelector('meta[name="transverter-app"][content="json-extractor"]');
  if (!marker) return;

  const PAGE_MESSAGE_SOURCE = "transverter-page";
  const EXTENSION_MESSAGE_SOURCE = "transverter-extension";
  const statusPollers = new Map();

  function postToPage(message) {
    window.postMessage({ source: EXTENSION_MESSAGE_SOURCE, ...message }, "*");
  }

  function announceReady() {
    postToPage({ type: "TRANSVERTER_EXTENSION_READY" });
  }

  function pollVisualizationStatus(requestId) {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      chrome.runtime.sendMessage(
        { type: "GET_VISUALIZATION_STATUS", requestId },
        (response) => {
          if (chrome.runtime.lastError || !response?.ok) return;
          if (!response.complete && Date.now() - startedAt < 45000) return;

          window.clearInterval(timer);
          statusPollers.delete(requestId);
          if (!response.complete) return;

          postToPage({
            type: response.success ? "TRANSVERTER_COMPLETE" : "TRANSVERTER_ERROR",
            requestId,
            error: response.error,
          });
        },
      );
    }, 300);

    statusPollers.set(requestId, timer);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== PAGE_MESSAGE_SOURCE) return;

    if (event.data.type === "TRANSVERTER_PING") {
      announceReady();
      return;
    }

    if (event.data.type !== "TRANSVERTER_VISUALIZE") return;

    const { requestId, json } = event.data;
    chrome.runtime.sendMessage(
      { type: "OPEN_ESJSON_VISUALIZER", requestId, json },
      (response) => {
        if (chrome.runtime.lastError) {
          postToPage({
            type: "TRANSVERTER_ERROR",
            requestId,
            error: "扩展通信失败，请重新加载扩展",
          });
          return;
        }

        if (!response?.ok) {
          postToPage({
            type: "TRANSVERTER_ERROR",
            requestId,
            error: response?.error || "无法打开 ESJSON",
          });
          return;
        }

        postToPage({ type: "TRANSVERTER_OPENED", requestId });
        pollVisualizationStatus(requestId);
      },
    );
  });

  announceReady();
})();
