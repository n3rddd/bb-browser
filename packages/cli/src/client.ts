/**
 * HTTP 客户端 - 与 Daemon 通信
 */

import type { Request, Response } from "@bb-browser/shared";
import { DAEMON_BASE_URL, COMMAND_TIMEOUT } from "@bb-browser/shared";
import { applyJq } from "./jq.js";

let jqExpression: string | undefined;

export function setJqExpression(expression?: string): void {
  jqExpression = expression;
}

function printJqResults(response: Response): never {
  const target = response.data ?? response;
  const results = applyJq(target, jqExpression || ".");
  for (const result of results) {
    console.log(typeof result === "string" ? result : JSON.stringify(result));
  }
  process.exit(0);
}

export function handleJqResponse(response: Response): void {
  if (jqExpression) {
    printJqResults(response);
  }
}

/**
 * 发送命令到 Daemon 并等待响应
 */
export async function sendCommand(request: Request): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), COMMAND_TIMEOUT);

  try {
    const res = await fetch(`${DAEMON_BASE_URL}/command`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      // 根据 HTTP 状态码返回错误
      if (res.status === 408) {
        return {
          id: request.id,
          success: false,
          error: "命令执行超时",
        };
      }
      if (res.status === 503) {
        return {
          id: request.id,
          success: false,
          error: [
            "Chrome extension not connected.",
            "",
            "1. Download extension: https://github.com/epiral/bb-browser/releases/latest",
            "2. Unzip the downloaded file",
            "3. Open chrome://extensions/ → Enable Developer Mode",
            "4. Click \"Load unpacked\" → select the unzipped folder",
          ].join("\n"),
        };
      }
      return {
        id: request.id,
        success: false,
        error: `HTTP 错误: ${res.status} ${res.statusText}`,
      };
    }

    const response = (await res.json()) as Response;

    return response;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error) {
      if (error.name === "AbortError") {
        return {
          id: request.id,
          success: false,
          error: "请求超时",
        };
      }
      // 连接错误
      if (
        error.message.includes("fetch failed") ||
        error.message.includes("ECONNREFUSED")
      ) {
        throw new Error([
          "Cannot connect to daemon.",
          "",
          "Start the daemon first:",
          "  bb-browser daemon",
          "",
          "Then load the Chrome extension:",
          "  chrome://extensions/ → Developer Mode → Load unpacked → node_modules/bb-browser/extension/",
        ].join("\n"));
      }
      throw error;
    }
    throw error;
  }
}
