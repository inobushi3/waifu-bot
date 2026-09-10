import crypto from "node:crypto";
import path from "node:path";
import WebSocket from "ws";

function normalizeBaseUrl(url) {
  return String(url || "http://127.0.0.1:8188").replace(/\/+$/, "");
}

function toWebSocketUrl(httpUrl, clientId) {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/ws`;
  url.search = "";
  url.searchParams.set("clientId", clientId);
  return url.toString();
}

async function readError(response) {
  try {
    return await response.text();
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

export class ComfyClient {
  constructor(baseUrl, timeoutMs = 600_000) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.timeoutMs = timeoutMs;
  }

  async queuePrompt(workflow, clientId) {
    const response = await fetch(`${this.baseUrl}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: workflow,
        client_id: clientId,
      }),
    });

    if (!response.ok) {
      throw new Error(`ComfyUI /prompt: ${await readError(response)}`);
    }

    return response.json();
  }

  async getHistory(promptId) {
    const response = await fetch(`${this.baseUrl}/history/${promptId}`);

    if (!response.ok) {
      throw new Error(`ComfyUI /history: ${await readError(response)}`);
    }

    return response.json();
  }

  async downloadImage(image) {
    const params = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder ?? "",
      type: image.type ?? "output",
    });

    const response = await fetch(`${this.baseUrl}/view?${params}`);

    if (!response.ok) {
      throw new Error(`ComfyUI /view: ${await readError(response)}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  connect(clientId) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(toWebSocketUrl(this.baseUrl, clientId));

      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("Timeout conectando ao WebSocket do ComfyUI."));
      }, 10_000);

      ws.once("open", () => {
        clearTimeout(timer);
        resolve(ws);
      });

      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(
          new Error(`Não foi possível conectar ao ComfyUI: ${error.message}`)
        );
      });
    });
  }

  waitForCompletion(ws, promptId, onProgress) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        ws.removeAllListeners("message");
        ws.removeAllListeners("close");
        ws.removeAllListeners("error");
      };

      const fail = (error) => {
        cleanup();
        try {
          ws.close();
        } catch {}
        reject(error);
      };

      const timer = setTimeout(() => {
        fail(new Error("A geração excedeu o tempo limite configurado."));
      }, this.timeoutMs);

      ws.on("message", (raw, isBinary) => {
        if (isBinary) return;

        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }

        const data = message?.data ?? {};

        if (message.type === "progress" && typeof onProgress === "function") {
          onProgress(data);
          return;
        }

        if (
          (message.type === "execution_error" ||
            message.type === "execution_interrupted") &&
          data.prompt_id === promptId
        ) {
          fail(
            new Error(
              data.exception_message ||
                data.exception_type ||
                "O ComfyUI interrompeu a geração."
            )
          );
          return;
        }

        if (
          message.type === "executing" &&
          data.prompt_id === promptId &&
          data.node === null
        ) {
          cleanup();
          try {
            ws.close();
          } catch {}
          resolve();
        }
      });

      ws.once("close", () => {});

      ws.once("error", (error) => {
        fail(new Error(`WebSocket do ComfyUI falhou: ${error.message}`));
      });
    });
  }

  extractImages(history, promptId) {
    const record = history?.[promptId];
    if (!record?.outputs) {
      throw new Error("O ComfyUI terminou, mas não retornou outputs no history.");
    }

    const images = [];

    for (const [nodeId, output] of Object.entries(record.outputs)) {
      for (const image of output?.images ?? []) {
        if (!image?.filename) continue;
        images.push({
          ...image,
          nodeId,
        });
      }
    }

    return images;
  }

  async generate(workflow, onProgress) {
    const clientId = crypto.randomUUID();
    const ws = await this.connect(clientId);

    let queued;
    try {
      queued = await this.queuePrompt(workflow, clientId);
    } catch (error) {
      try {
        ws.close();
      } catch {}
      throw error;
    }

    const promptId = queued?.prompt_id;
    if (!promptId) {
      try {
        ws.close();
      } catch {}
      throw new Error("O ComfyUI não retornou prompt_id.");
    }

    await this.waitForCompletion(ws, promptId, onProgress);

    const history = await this.getHistory(promptId);
    const images = this.extractImages(history, promptId);

    if (images.length === 0) {
      throw new Error(
        "A geração terminou, mas nenhum output de imagem foi encontrado."
      );
    }

    const selected = images.slice(-4);
    const downloaded = [];

    for (const image of selected) {
      const buffer = await this.downloadImage(image);
      downloaded.push({
        buffer,
        filename: path.basename(image.filename),
        nodeId: image.nodeId,
      });
    }

    return {
      promptId,
      images: downloaded,
    };
  }
}
