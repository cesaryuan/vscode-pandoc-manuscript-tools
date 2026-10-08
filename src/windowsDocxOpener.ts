import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Opens a local DOCX through Windows' file association, preserving Unicode paths. */
export async function openWindowsDocx(filePath: string): Promise<void> {
  // Electron passes percent-encoded file URLs to ShellExecuteExW, which fails
  // on Chinese filenames here (error 2). Pass the original path as data so
  // Unicode and shell metacharacters remain literal.
  const command = "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:PMT_DOCX_PATH";
  const powershellPath = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  await execFileAsync(powershellPath, [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(command, "utf16le").toString("base64"),
  ], {
    windowsHide: true,
    env: { ...process.env, PMT_DOCX_PATH: filePath },
  });
}
