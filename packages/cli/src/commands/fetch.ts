/**
 * fetch 命令 - 在浏览器上下文中执行 fetch()，自动处理同源路由
 *
 * 用法：
 *   bb-browser fetch <url> [options]
 *   bb-browser fetch https://www.reddit.com/api/me.json
 *   bb-browser fetch /api/me.json                     # 相对路径，用当前 tab 的 origin
 *   bb-browser fetch https://www.reddit.com/... --json
 *   bb-browser fetch https://x.com/... --method POST --body '{"query":"..."}'
 *
 * 本质：curl，但带浏览器登录态。
 */

import { generateId, type Request, type Response, type TabInfo } from "@bb-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";

export interface FetchOptions {
  json?: boolean;
  method?: string;
  body?: string;
  headers?: string;
  output?: string;
  tabId?: number;
}

/**
 * 从 URL 提取 origin（protocol + host）
 */
function extractOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * 从 URL 提取域名（不含协议）
 */
function extractHostname(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return null;
  }
}

/**
 * 找到匹配域名的 tab，如果没有则新建
 */
async function ensureTabForOrigin(origin: string, hostname: string): Promise<number | undefined> {
  // 获取所有 tab
  const listReq: Request = { id: generateId(), action: "tab_list" };
  const listResp: Response = await sendCommand(listReq);

  if (listResp.success && listResp.data?.tabs) {
    // 查找匹配域名的 tab
    const matchingTab = listResp.data.tabs.find((tab: TabInfo) =>
      tab.url.includes(hostname)
    );

    if (matchingTab) {
      // 如果不是当前 tab，切换过去
      if (!matchingTab.active) {
        const selectReq: Request = {
          id: generateId(),
          action: "tab_select",
          tabId: matchingTab.tabId,
        };
        await sendCommand(selectReq);
      }
      return matchingTab.tabId;
    }
  }

  // 没找到，新建 tab
  const newReq: Request = {
    id: generateId(),
    action: "tab_new",
    url: origin,
  };
  const newResp: Response = await sendCommand(newReq);

  if (!newResp.success) {
    throw new Error(`无法打开 ${origin}: ${newResp.error}`);
  }

  // 等待页面加载
  await new Promise((resolve) => setTimeout(resolve, 3000));

  return newResp.data?.tabId;
}

/**
 * 构造浏览器内执行的 fetch JS 代码
 */
function buildFetchScript(url: string, options: FetchOptions): string {
  const method = options.method || "GET";
  const hasBody = options.body && method !== "GET";

  // 解析额外 headers
  let extraHeaders = "";
  if (options.headers) {
    extraHeaders = `, ...${options.headers}`;
  }

  return `(async () => {
    try {
      const resp = await fetch(${JSON.stringify(url)}, {
        method: ${JSON.stringify(method)},
        credentials: 'include',
        headers: { ${extraHeaders} }${hasBody ? `,\n        body: ${JSON.stringify(options.body)}` : ""}
      });
      const contentType = resp.headers.get('content-type') || '';
      let body;
      if (contentType.includes('application/json')) {
        body = await resp.json();
      } else {
        body = await resp.text();
      }
      return JSON.stringify({
        status: resp.status,
        contentType,
        body
      });
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  })()`;
}

export async function fetchCommand(
  url: string,
  options: FetchOptions = {}
): Promise<void> {
  if (!url) {
    throw new Error(
      "缺少 URL 参数\n" +
      "  用法: bb-browser fetch <url> [--json] [--method POST] [--body '{...}']\n" +
      "  示例: bb-browser fetch https://www.reddit.com/api/me.json --json"
    );
  }

  await ensureDaemonRunning();

  const isAbsolute = url.startsWith("http://") || url.startsWith("https://");
  let targetTabId = options.tabId;

  if (isAbsolute) {
    const origin = extractOrigin(url);
    const hostname = extractHostname(url);

    if (!origin || !hostname) {
      throw new Error(`无效的 URL: ${url}`);
    }

    // 自动找到或新建同源 tab
    if (!targetTabId) {
      targetTabId = await ensureTabForOrigin(origin, hostname);
    }
  }
  // 相对路径直接用当前 tab（不需要路由）

  // 构造并执行 fetch
  const script = buildFetchScript(url, options);
  const evalReq: Request = {
    id: generateId(),
    action: "eval",
    script,
    tabId: targetTabId,
  };

  const evalResp: Response = await sendCommand(evalReq);

  if (!evalResp.success) {
    throw new Error(`Fetch 失败: ${evalResp.error}`);
  }

  const rawResult = evalResp.data?.result;
  if (rawResult === undefined || rawResult === null) {
    throw new Error("Fetch 未返回结果");
  }

  // 解析结果
  let result: { status?: number; contentType?: string; body?: unknown; error?: string };
  try {
    result = typeof rawResult === "string" ? JSON.parse(rawResult) : rawResult as typeof result;
  } catch {
    // 如果不是 JSON，直接输出
    console.log(rawResult);
    return;
  }

  if (result.error) {
    throw new Error(`Fetch error: ${result.error}`);
  }

  // 写文件
  if (options.output) {
    const { writeFileSync } = await import("node:fs");
    const content = typeof result.body === "object"
      ? JSON.stringify(result.body, null, 2)
      : String(result.body);
    writeFileSync(options.output, content, "utf-8");

    if (options.json) {
      console.log(JSON.stringify({
        success: true,
        status: result.status,
        contentType: result.contentType,
        outputPath: options.output,
        size: content.length,
      }, null, 2));
    } else {
      console.log(`已写入 ${options.output} (${result.status}, ${content.length} bytes)`);
    }
    return;
  }

  // 输出
  if (options.json) {
    if (typeof result.body === "object") {
      console.log(JSON.stringify(result.body, null, 2));
    } else {
      console.log(result.body);
    }
  } else {
    if (typeof result.body === "object") {
      console.log(JSON.stringify(result.body, null, 2));
    } else {
      console.log(result.body);
    }
  }
}
