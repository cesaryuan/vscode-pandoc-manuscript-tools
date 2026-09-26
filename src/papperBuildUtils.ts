import * as cp from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

export type PandocManuscriptProject = { rootUri: vscode.Uri };
export type RunProcessOptions = {
  cwd?: string;
  output?: vscode.OutputChannel;
  captureStdout?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Notifies callers when the child process writes to either output stream. */
  onOutputChunk?: (stream: "stdout" | "stderr") => void;
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
 */
async function installPapperTool(output: vscode.OutputChannel) {
  const uvExecutable = await findExecutableOnPath("uv");
  if (!uvExecutable) {
    throw new Error("`papper` is not on PATH and `uv` is not available to install it.");
  }

  let toolBinDirectory = await runProcess(uvExecutable, ["tool", "dir", "--bin"], { captureStdout: true });
  let installedExecutable = toolBinDirectory ? await findExecutableInDirectory("papper", toolBinDirectory) : undefined;
  if (installedExecutable) {
    cachedPapperExecutable = installedExecutable;
    return installedExecutable;
  }

  output.appendLine("[Papper] `papper` is not on PATH; installing it with `uv tool install papper`.");
  await runProcess(uvExecutable, ["tool", "install", "papper"], { output });

  installedExecutable = await findExecutableOnPath("papper");
  if (!installedExecutable) {
    toolBinDirectory = await runProcess(uvExecutable, ["tool", "dir", "--bin"], { captureStdout: true });
    installedExecutable = toolBinDirectory ? await findExecutableInDirectory("papper", toolBinDirectory) : undefined;
  }
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
      options.onOutputChunk?.("stdout");
      const text = chunk.toString();
      if (options.captureStdout) {
        stdout += text;
      }
      options.output?.append(text);
    });
    child.stderr.on("data", (chunk) => {
      options.onOutputChunk?.("stderr");
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
