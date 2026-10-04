import * as cp from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { CHINESE_PYPI_MIRROR, shouldUseChinesePypiMirror } from "./papperToolPolicy";

export type PandocManuscriptProject = { rootUri: vscode.Uri };
export type RunProcessOptions = {
  cwd?: string;
  output?: vscode.OutputChannel;
  captureStdout?: boolean;
  env?: NodeJS.ProcessEnv;
};

let cachedPapperExecutable: string | undefined;
let papperResolutionPromise: Promise<string> | undefined;

/** Finds the nearest Papper manuscript project containing a Markdown file. */
export async function findPandocManuscriptProject(markdownUri: vscode.Uri): Promise<PandocManuscriptProject | undefined> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(markdownUri);
  const stopAtPath = workspaceFolder ? workspaceFolder.uri.fsPath : undefined;
  let currentPath = path.dirname(markdownUri.fsPath);

  while (true) {
    const project = await readPandocManuscriptProject(vscode.Uri.file(currentPath));
    if (project) {
      return project;
    }

    if (stopAtPath && isSameFsPath(currentPath, stopAtPath)) {
      return undefined;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return undefined;
    }
    currentPath = parentPath;
  }
}

/**
 * Returns manuscript project metadata when a directory has the required layout.
 *
 * `style.yml` marks the main manuscript directory in current templates. The
 * older Pandoc defaults path is no longer required for showing the DOCX button.
 *
 * @param rootUri Candidate project root.
 */
async function readPandocManuscriptProject(rootUri: vscode.Uri) {
  if (!(await pathExists(vscode.Uri.joinPath(rootUri, "style.yml")))) {
    return undefined;
  }

  return { rootUri };
}

/**
 * Checks whether a file or directory exists.
 *
 * @param uri File or directory URI.
 */
export async function pathExists(uri: vscode.Uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export async function isPapperBuildAvailable() {
  if (cachedPapperExecutable && await isExecutableFile(cachedPapperExecutable)) {
    return true;
  }
  if (await findExecutableOnPath("papper")) {
    return true;
  }
  return Boolean(await findExecutableOnPath("uv"));
}

/** Describes an available Papper update reported by uv. */
export type PapperUpdateInfo = { summary: string };

/**
 * Checks uv's installed-tool list without changing any environment.
 *
 * @returns Papper update details, or `undefined` when no update is reported.
 */
export async function checkForPapperUpdate(): Promise<PapperUpdateInfo | undefined> {
  const uvExecutable = await findExecutableOnPath("uv");
  if (!uvExecutable) {
    return undefined;
  }

  try {
    const toolBinDirectory = await runProcess(uvExecutable, ["tool", "dir", "--bin"], { captureStdout: true });
    const uvPapperExecutable = toolBinDirectory ? await findExecutableInDirectory("papper", toolBinDirectory) : undefined;
    if (!uvPapperExecutable) {
      return undefined;
    }
    const pathPapperExecutable = await findExecutableOnPath("papper");
    if (pathPapperExecutable && !isSameFsPath(pathPapperExecutable, uvPapperExecutable)) {
      return undefined;
    }

    const outdated = await runProcess(uvExecutable, ["tool", "list", "--outdated"], { captureStdout: true });
    const papperLine = outdated
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^(?:[-*]\s*)?papper\b/i.test(line));
    return papperLine ? { summary: papperLine } : undefined;
  } catch {
    // Network failures and older uv versions must not disturb the editor.
    return undefined;
  }
}

/**
 * Upgrades the installed Papper uv tool after the user has confirmed.
 */
export async function upgradePapper() {
  if (papperResolutionPromise) {
    // A manual maintenance command already covers this automatic upgrade request.
    await papperResolutionPromise;
    return;
  }
  const uvExecutable = await findExecutableOnPath("uv");
  if (!uvExecutable) {
    throw new Error("`uv` is not available to upgrade Papper.");
  }

  await runProcess(uvExecutable, ["tool", "upgrade", "papper"], {});
  cachedPapperExecutable = undefined;
}

/**
 * Installs Papper when absent, or upgrades the uv-managed installation.
 *
 * @param output Output channel receiving the uv command and its progress.
 * @returns The executable installed or refreshed by uv.
 */
export async function installOrUpdatePapper(output: vscode.OutputChannel): Promise<string> {
  if (papperResolutionPromise) {
    // Let a build's first-time installation finish before requesting an upgrade.
    await papperResolutionPromise;
  }
  papperResolutionPromise = installPapperTool(output, true).finally(() => {
    papperResolutionPromise = undefined;
  });
  return papperResolutionPromise;
}

/**
 * Finds Papper only when it is already installed, without starting a tool installation.
 */
export async function findExistingPapperExecutable() {
  const pathExecutable = await findExecutableOnPath("papper");
  if (pathExecutable) {
    cachedPapperExecutable = pathExecutable;
    return pathExecutable;
  }
  if (cachedPapperExecutable && await isExecutableFile(cachedPapperExecutable)) {
    return cachedPapperExecutable;
  }

  const uvExecutable = await findExecutableOnPath("uv");
  if (!uvExecutable) {
    return undefined;
  }

  try {
    const toolBinDirectory = await runProcess(uvExecutable, ["tool", "dir", "--bin"], { captureStdout: true });
    const installedExecutable = toolBinDirectory ? await findExecutableInDirectory("papper", toolBinDirectory) : undefined;
    if (installedExecutable) {
      cachedPapperExecutable = installedExecutable;
      return installedExecutable;
    }
  } catch {
    // Missing or unavailable uv tool metadata means background hints should stay idle.
  }
  return undefined;
}

/**
 * Resolves a direct Papper executable, installing the uv tool only when needed.
 *
 * @param output Build log channel.
 */
export async function resolvePapperExecutable(output: vscode.OutputChannel) {
  if (papperResolutionPromise) {
    // Builds must not use an executable while the manual command is replacing it.
    return papperResolutionPromise;
  }
  const pathExecutable = await findExecutableOnPath("papper");
  if (pathExecutable) {
    cachedPapperExecutable = pathExecutable;
    return pathExecutable;
  }
  if (cachedPapperExecutable && await isExecutableFile(cachedPapperExecutable)) {
    return cachedPapperExecutable;
  }

  if (!papperResolutionPromise) {
    papperResolutionPromise = installPapperTool(output).finally(() => {
      papperResolutionPromise = undefined;
    });
  }
  return papperResolutionPromise;
}

/**
 * Finds an existing uv tool install, or installs Papper and resolves its launcher.
 *
 * @param output Build log channel.
 * @param upgrade Whether to refresh an already installed uv tool.
 */
async function installPapperTool(output: vscode.OutputChannel, upgrade = false) {
  const uvExecutable = await findExecutableOnPath("uv");
  if (!uvExecutable) {
    throw new Error("`uv` is not available to install or update Papper. Install uv and reload VS Code before retrying.");
  }

  let toolBinDirectory = await runProcess(uvExecutable, ["tool", "dir", "--bin"], { captureStdout: true });
  let installedExecutable = toolBinDirectory ? await findExecutableInDirectory("papper", toolBinDirectory) : undefined;
  if (upgrade) {
    const pathExecutable = await findExecutableOnPath("papper");
    if (pathExecutable && (!installedExecutable || !isSameFsPath(pathExecutable, installedExecutable))) {
      // Updating a hidden uv copy would leave the active Papper version unchanged.
      throw new Error("The Papper executable on PATH is not managed by uv. Update it with its original package manager.");
    }
  }
  if (installedExecutable && !upgrade) {
    cachedPapperExecutable = installedExecutable;
    return installedExecutable;
  }

  const installArgs = ["tool", "install", "papper"];
  if (upgrade) {
    installArgs.push("--upgrade");
  }
  const fallbackArgs = [...installArgs];
  const systemLocale = Intl.DateTimeFormat().resolvedOptions().locale;
  const useMirror = shouldUseChinesePypiMirror(systemLocale, -new Date().getTimezoneOffset());
  if (useMirror) {
    installArgs.push("--default-index", CHINESE_PYPI_MIRROR);
  }
  output.appendLine(`[Papper] ${upgrade ? "Installing or updating" : "Installing"} with \`uv ${installArgs.join(" ")}\`.`);
  try {
    await runProcess(uvExecutable, installArgs, { output });
  } catch (error) {
    if (!useMirror) {
      throw error;
    }
    // A mirror outage must not prevent installation from the user's normal index.
    output.appendLine("[Papper] Mirror installation failed; retrying without a custom index.");
    await runProcess(uvExecutable, fallbackArgs, { output });
  }

  toolBinDirectory = await runProcess(uvExecutable, ["tool", "dir", "--bin"], { captureStdout: true });
  installedExecutable = toolBinDirectory ? await findExecutableInDirectory("papper", toolBinDirectory) : undefined;
  installedExecutable ||= await findExecutableOnPath("papper");
  if (!installedExecutable) {
    throw new Error("uv installed Papper, but its `papper` executable could not be found on PATH or in uv's tool bin directory.");
  }

  cachedPapperExecutable = installedExecutable;
  return installedExecutable;
}

/**
 * Finds a named executable in the current process PATH.
 *
 * @param executable Executable basename without its platform suffix.
 */
async function findExecutableOnPath(executable: string) {
  const pathValue = process.env.PATH || process.env.Path || "";
  for (const entry of pathValue.split(path.delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!directory) {
      continue;
    }
    const found = await findExecutableInDirectory(executable, directory);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/**
 * Finds an executable file by name in one directory, honoring Windows PATHEXT.
 *
 * @param executable Executable basename without its platform suffix.
 * @param directory Directory to inspect.
 */
async function findExecutableInDirectory(executable: string, directory: string) {
  const suffixes = process.platform === "win32"
    ? [...(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";"), ""]
    : [""];
  for (const suffix of suffixes) {
    const candidate = path.join(directory, `${executable}${suffix}`);
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Checks that a path points to a runnable file for the current platform.
 *
 * @param filePath Candidate executable path.
 */
async function isExecutableFile(filePath: string) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

/**
 * Adds discoverable system Pandoc tool directories to Papper's child environment.
 *
 * VS Code can keep an older PATH than the shell that launched Scoop. In that
 * case Papper cannot see an already installed Pandoc and may enter its network
 * installation path on every preview refresh. The ancestor scan covers Scoop's
 * `persist\\uv\\tools\\shims` and sibling `shims` layout without hard-coding a
 * user-specific drive or installation root.
 *
 * @param papperExecutable Resolved Papper executable path.
 */
export async function preparePapperEnvironment(papperExecutable: string) {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  const existingPath = environment.PATH || environment.Path || "";
  const existingEntries = existingPath
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  const candidateEntries = new Map<string, string>();
  const rememberCandidate = (entry: string) => {
    const normalized = path.resolve(entry);
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (!candidateEntries.has(key)) {
      candidateEntries.set(key, normalized);
    }
  };

  if (process.env.SCOOP) {
    rememberCandidate(path.join(process.env.SCOOP, "shims"));
  }

  let ancestor = path.dirname(papperExecutable);
  for (let depth = 0; depth < 8; depth += 1) {
    rememberCandidate(path.join(ancestor, "shims"));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      break;
    }
    ancestor = parent;
  }

  const toolPathEntries: string[] = [];
  const prependEntries: string[] = [];
  for (const candidate of candidateEntries.values()) {
    const hasPandoc = Boolean(await findExecutableInDirectory("pandoc", candidate));
    const hasCrossref = Boolean(await findExecutableInDirectory("pandoc-crossref", candidate));
    if (!hasPandoc && !hasCrossref) {
      continue;
    }
    toolPathEntries.push(candidate);
    const alreadyPresent = existingEntries.some((entry) => isSameFsPath(entry, candidate));
    if (!alreadyPresent) {
      prependEntries.push(candidate);
    }
  }

  const combinedPath = [...prependEntries, ...existingEntries].join(path.delimiter);
  if (combinedPath) {
    environment.PATH = combinedPath;
    if (environment.Path !== undefined) {
      environment.Path = combinedPath;
    }
  }
  return { env: environment, toolPathEntries };
}

/**
 * Runs a child process and optionally streams output to the extension channel.
 *
 * @param command Command executable.
 * @param args Command arguments.
 * @param options Process options.
 * @returns Captured stdout when requested; otherwise an empty string.
 */
export function runProcess(command: string, args: string[], options: RunProcessOptions) {
  return new Promise<string>((resolve, reject) => {
    const child = cp.spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: process.platform === "win32" && /\.(?:bat|cmd)$/i.test(command),
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      if (options.captureStdout) {
        stdout += text;
      }
      options.output?.append(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr = `${stderr}${text}`.slice(-8192);
      options.output?.append(text);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`${command} exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
      }
    });
  });
}

/**
 * Compares filesystem paths with Windows casing rules.
 *
 * @param left Left path.
 * @param right Right path.
 */
function isSameFsPath(left: string, right: string) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  if (process.platform === "win32") {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}
