(() => {
  "use strict";

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "扩展通信失败"));
          return;
        }
        resolve(response);
      });
    });
  }

  function waitForElement(findElement, timeout = 12000) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = window.setInterval(() => {
        const element = findElement();
        if (element) {
          window.clearInterval(timer);
          resolve(element);
        } else if (Date.now() - startedAt >= timeout) {
          window.clearInterval(timer);
          reject(new Error("ESJSON 页面加载超时"));
        }
      }, 120);
    });
  }

  function findSourceEditor() {
    return (
      document.querySelector("textarea#sourceText") ||
      [...document.querySelectorAll("textarea")].find((element) =>
        element.placeholder?.includes("请输入JSON字符串"),
      )
    );
  }

  function findVisualizeButton() {
    return (
      document.querySelector("button#jsonviewBtn") ||
      [...document.querySelectorAll("button")].find(
        (element) => element.textContent?.trim().includes("可视化"),
      )
    );
  }

  function fillEditor(editor, json) {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    valueSetter?.call(editor, json);
    if (!valueSetter) editor.value = json;
    editor.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: json }),
    );
    editor.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function showFailure(message) {
    const notice = document.createElement("div");
    notice.textContent = `JSON 拼接转换器：${message}`;
    Object.assign(notice.style, {
      position: "fixed",
      top: "16px",
      left: "50%",
      zIndex: "2147483647",
      maxWidth: "min(560px, calc(100vw - 32px))",
      padding: "12px 16px",
      borderRadius: "6px",
      color: "#ffffff",
      background: "#c43d4b",
      boxShadow: "0 8px 24px rgba(0, 0, 0, 0.18)",
      font: '14px/1.5 system-ui, "Microsoft YaHei", sans-serif',
      transform: "translateX(-50%)",
    });
    document.body.appendChild(notice);
  }

  async function run() {
    const params = new URLSearchParams(location.hash.slice(1));
    const token = params.get("transverter");
    if (!token) return;

    history.replaceState(history.state, "", `${location.pathname}${location.search}`);

    try {
      const payload = await sendRuntimeMessage({
        type: "GET_VISUALIZATION_PAYLOAD",
        token,
      });
      const editor = await waitForElement(findSourceEditor);
      const button = await waitForElement(findVisualizeButton);

      fillEditor(editor, payload.json);
      button.click();

      await waitForElement(() => {
        const target = document.querySelector("#targetText");
        return target?.textContent.trim() ? target : null;
      });
      await sendRuntimeMessage({ type: "FINISH_VISUALIZATION", token, success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "自动可视化失败";
      showFailure(message);
      try {
        await sendRuntimeMessage({
          type: "FINISH_VISUALIZATION",
          token,
          success: false,
          error: `${message}，结果已复制，可手动粘贴`,
        });
      } catch {
        // The original error is already visible on the ESJSON page.
      }
    }
  }

  void run();
})();
