/**
 * recipe 命令 - 管理和运行社区/私有 fetch 食谱
 *
 * 用法：
 *   bb-browser recipe list                      列出所有可用 recipe
 *   bb-browser recipe search <query>            搜索 recipe
 *   bb-browser recipe run <name> [args...]      运行 recipe
 *   bb-browser recipe update                    更新社区 recipe 库
 *
 * Recipe 目录：
 *   ~/.bb-browser/recipes/      私有 recipe（优先）
 *   ~/.bb-browser/bb-recipes/   社区 recipe（bb-browser recipe update 拉取）
 */

import { generateId, type Request, type Response, type TabInfo } from "@bb-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const BB_DIR = join(homedir(), ".bb-browser");
const LOCAL_RECIPES_DIR = join(BB_DIR, "recipes");
const COMMUNITY_RECIPES_DIR = join(BB_DIR, "bb-recipes");
const COMMUNITY_REPO = "https://github.com/epiral/bb-recipes.git";

export interface RecipeOptions {
  json?: boolean;
}

/** Recipe 元数据 */
interface RecipeMeta {
  name: string;         // e.g. "reddit/thread"
  description: string;
  domain: string;
  args: string[];       // e.g. ["url", "comment_id"]
  example?: string;
  filePath: string;
  source: "local" | "community";
}

/**
 * 从 JS 文件的注释中解析 @metadata
 */
function parseRecipeMeta(filePath: string, source: "local" | "community"): RecipeMeta | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const meta: RecipeMeta = {
    name: "",
    description: "",
    domain: "",
    args: [],
    filePath,
    source,
  };

  // 从文件路径推断 name（如 recipes/reddit/thread.js → reddit/thread）
  const recipesDir = source === "local" ? LOCAL_RECIPES_DIR : COMMUNITY_RECIPES_DIR;
  const relPath = relative(recipesDir, filePath);
  const defaultName = relPath.replace(/\.js$/, "").replace(/\\/g, "/");
  meta.name = defaultName;

  // 解析 @tags
  const tagPattern = /\/\/\s*@(\w+)[ \t]+(.*)/g;
  let match;
  while ((match = tagPattern.exec(content)) !== null) {
    const [, key, value] = match;
    switch (key) {
      case "name":
        meta.name = value.trim();
        break;
      case "description":
        meta.description = value.trim();
        break;
      case "domain":
        meta.domain = value.trim();
        break;
      case "args":
        meta.args = value.trim().split(/[,\s]+/).filter(Boolean);
        break;
      case "example":
        meta.example = value.trim();
        break;
    }
  }

  return meta;
}

/**
 * 扫描目录下所有 .js recipe 文件
 */
function scanRecipes(dir: string, source: "local" | "community"): RecipeMeta[] {
  if (!existsSync(dir)) return [];

  const recipes: RecipeMeta[] = [];

  function walk(currentDir: string): void {
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        const meta = parseRecipeMeta(fullPath, source);
        if (meta) recipes.push(meta);
      }
    }
  }

  walk(dir);
  return recipes;
}

/**
 * 获取所有 recipe（私有优先，同名时覆盖社区）
 */
function getAllRecipes(): RecipeMeta[] {
  const community = scanRecipes(COMMUNITY_RECIPES_DIR, "community");
  const local = scanRecipes(LOCAL_RECIPES_DIR, "local");

  // 私有覆盖社区（同名时）
  const byName = new Map<string, RecipeMeta>();
  for (const r of community) byName.set(r.name, r);
  for (const r of local) byName.set(r.name, r);

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * recipe list
 */
function recipeList(options: RecipeOptions): void {
  const recipes = getAllRecipes();

  if (recipes.length === 0) {
    console.log("未找到任何 recipe。");
    console.log("  安装社区 recipe: bb-browser recipe update");
    console.log(`  私有 recipe 目录: ${LOCAL_RECIPES_DIR}`);
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(recipes.map(r => ({
      name: r.name,
      description: r.description,
      domain: r.domain,
      args: r.args,
      source: r.source,
    })), null, 2));
    return;
  }

  // 按 platform 分组
  const groups = new Map<string, RecipeMeta[]>();
  for (const r of recipes) {
    const platform = r.name.split("/")[0];
    if (!groups.has(platform)) groups.set(platform, []);
    groups.get(platform)!.push(r);
  }

  for (const [platform, items] of groups) {
    console.log(`\n${platform}/`);
    for (const r of items) {
      const cmd = r.name.split("/").slice(1).join("/");
      const src = r.source === "local" ? " (local)" : "";
      const desc = r.description ? ` - ${r.description}` : "";
      console.log(`  ${cmd.padEnd(20)}${desc}${src}`);
    }
  }
  console.log();
}

/**
 * recipe search
 */
function recipeSearch(query: string, options: RecipeOptions): void {
  const recipes = getAllRecipes();
  const q = query.toLowerCase();
  const matches = recipes.filter(r =>
    r.name.toLowerCase().includes(q) ||
    r.description.toLowerCase().includes(q) ||
    r.domain.toLowerCase().includes(q)
  );

  if (matches.length === 0) {
    console.log(`未找到匹配 "${query}" 的 recipe。`);
    console.log("  查看所有: bb-browser recipe list");
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(matches.map(r => ({
      name: r.name, description: r.description, domain: r.domain, source: r.source,
    })), null, 2));
    return;
  }

  for (const r of matches) {
    const src = r.source === "local" ? " (local)" : "";
    console.log(`${r.name.padEnd(24)} ${r.description}${src}`);
  }
}

/**
 * recipe update - clone 或 pull 社区 recipe 库
 */
function recipeUpdate(): void {
  mkdirSync(BB_DIR, { recursive: true });

  if (existsSync(join(COMMUNITY_RECIPES_DIR, ".git"))) {
    // 已有，git pull
    console.log("更新社区 recipe 库...");
    try {
      execSync("git pull --ff-only", { cwd: COMMUNITY_RECIPES_DIR, stdio: "pipe" });
      console.log("更新完成。");
    } catch (e) {
      console.error(`更新失败: ${e instanceof Error ? e.message : e}`);
      console.error("  手动修复: cd ~/.bb-browser/bb-recipes && git pull");
      process.exit(1);
    }
  } else {
    // 首次，git clone
    console.log(`克隆社区 recipe 库: ${COMMUNITY_REPO}`);
    try {
      execSync(`git clone ${COMMUNITY_REPO} ${COMMUNITY_RECIPES_DIR}`, { stdio: "pipe" });
      console.log("克隆完成。");
    } catch (e) {
      console.error(`克隆失败: ${e instanceof Error ? e.message : e}`);
      console.error(`  手动修复: git clone ${COMMUNITY_REPO} ~/.bb-browser/bb-recipes`);
      process.exit(1);
    }
  }

  // 显示安装了多少 recipe
  const recipes = scanRecipes(COMMUNITY_RECIPES_DIR, "community");
  console.log(`已安装 ${recipes.length} 个社区 recipe。`);
}

/**
 * recipe run - 执行 recipe
 */
async function recipeRun(
  name: string,
  args: string[],
  options: RecipeOptions
): Promise<void> {
  const recipes = getAllRecipes();
  const recipe = recipes.find(r => r.name === name);

  if (!recipe) {
    // 尝试模糊匹配
    const fuzzy = recipes.filter(r => r.name.includes(name));
    console.error(`[error] recipe: "${name}" not found.`);
    if (fuzzy.length > 0) {
      console.error("  Did you mean:");
      for (const r of fuzzy.slice(0, 5)) {
        console.error(`    bb-browser recipe run ${r.name}`);
      }
    } else {
      console.error("  Try: bb-browser recipe list");
      console.error("  Or:  bb-browser recipe update");
    }
    process.exit(1);
  }

  // 解析参数：按 recipe 定义的 @args 顺序匹配
  const argMap: Record<string, string> = {};
  for (let i = 0; i < recipe.args.length; i++) {
    const argName = recipe.args[i];
    // 支持 --name value 和位置参数
    const flagIdx = args.indexOf(`--${argName}`);
    if (flagIdx >= 0 && args[flagIdx + 1]) {
      argMap[argName] = args[flagIdx + 1];
    } else if (i < args.length) {
      argMap[argName] = args[i];
    }
  }

  // 检查必需参数
  for (const argName of recipe.args) {
    if (!argMap[argName]) {
      console.error(`[error] recipe ${name}: missing argument "${argName}".`);
      console.error(`  Usage: bb-browser recipe run ${name} ${recipe.args.map(a => `<${a}>`).join(" ")}`);
      if (recipe.example) {
        console.error(`  Example: ${recipe.example}`);
      }
      process.exit(1);
    }
  }

  // 读取 recipe JS
  const jsContent = readFileSync(recipe.filePath, "utf-8");

  // 移除注释行，提取纯 JS 函数体
  const jsLines = jsContent.split("\n").filter(line => !line.trimStart().startsWith("//"));
  const jsBody = jsLines.join("\n").trim();

  // 构造执行脚本：调用 recipe 函数并传入 args
  const argsJson = JSON.stringify(argMap);
  const script = `(${jsBody})(${argsJson})`;

  await ensureDaemonRunning();

  // 确保有正确域名的 tab
  if (recipe.domain) {
    const listReq: Request = { id: generateId(), action: "tab_list" };
    const listResp: Response = await sendCommand(listReq);

    let hasTab = false;
    if (listResp.success && listResp.data?.tabs) {
      const matchingTab = listResp.data.tabs.find((tab: TabInfo) =>
        tab.url.includes(recipe.domain)
      );
      if (matchingTab) {
        hasTab = true;
        if (!matchingTab.active) {
          await sendCommand({
            id: generateId(),
            action: "tab_select",
            tabId: matchingTab.tabId,
          });
        }
      }
    }

    if (!hasTab) {
      await sendCommand({
        id: generateId(),
        action: "tab_new",
        url: `https://${recipe.domain}`,
      });
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  // 执行
  const evalReq: Request = {
    id: generateId(),
    action: "eval",
    script,
  };
  const evalResp: Response = await sendCommand(evalReq);

  if (!evalResp.success) {
    console.error(`[error] recipe ${name}: eval failed.`);
    console.error(`  ${evalResp.error}`);
    console.error(`  Check: is ${recipe.domain} open and logged in?`);
    process.exit(1);
  }

  const result = evalResp.data?.result;
  if (result === undefined || result === null) {
    console.log("(no output)");
    return;
  }

  // 输出
  let parsed: unknown;
  try {
    parsed = typeof result === "string" ? JSON.parse(result) : result;
  } catch {
    console.log(result);
    return;
  }

  console.log(JSON.stringify(parsed, null, 2));
}

/**
 * recipe 命令入口
 */
export async function recipeCommand(
  args: string[],
  options: RecipeOptions = {}
): Promise<void> {
  const subCommand = args[0];

  if (!subCommand || subCommand === "--help" || subCommand === "-h") {
    console.log(`bb-browser recipe - 管理和运行 fetch 食谱

用法:
  bb-browser recipe list                      列出所有可用 recipe
  bb-browser recipe search <query>            搜索 recipe
  bb-browser recipe run <name> [args...]      运行 recipe
  bb-browser recipe update                    更新社区 recipe 库 (git clone/pull)

目录:
  ${LOCAL_RECIPES_DIR}      私有 recipe（优先）
  ${COMMUNITY_RECIPES_DIR}   社区 recipe

示例:
  bb-browser recipe update
  bb-browser recipe list
  bb-browser recipe run reddit/thread https://www.reddit.com/r/LocalLLaMA/comments/...
  bb-browser recipe search twitter`);
    return;
  }

  switch (subCommand) {
    case "list":
      recipeList(options);
      break;
    case "search":
      if (!args[1]) {
        console.error("[error] recipe search: <query> is required.");
        console.error("  Usage: bb-browser recipe search <query>");
        process.exit(1);
      }
      recipeSearch(args[1], options);
      break;
    case "update":
      recipeUpdate();
      break;
    case "run":
      if (!args[1]) {
        console.error("[error] recipe run: <name> is required.");
        console.error("  Usage: bb-browser recipe run <name> [args...]");
        console.error("  Try: bb-browser recipe list");
        process.exit(1);
      }
      await recipeRun(args[1], args.slice(2), options);
      break;
    default:
      // 如果直接写了 recipe name（省略 run）
      // e.g. bb-browser recipe reddit/thread <url>
      if (subCommand.includes("/")) {
        await recipeRun(subCommand, args.slice(1), options);
      } else {
        console.error(`[error] recipe: unknown subcommand "${subCommand}".`);
        console.error("  Available: list, search, run, update");
        console.error("  Try: bb-browser recipe --help");
        process.exit(1);
      }
      break;
  }
}
