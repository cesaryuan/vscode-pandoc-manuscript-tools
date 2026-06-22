"use strict";

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(repoRoot, "node_modules", "@mathjax", "mathjax-newcm-font", "cjs", "svg", "dynamic");
const targetDir = path.join(repoRoot, "assets", "mathjax-newcm-font", "cjs", "svg", "dynamic");

/**
 * Copies the MathJax NewCM dynamic SVG font chunks used at runtime.
 */
function copyMathJaxFonts() {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`MathJax NewCM font source directory is missing: ${sourceDir}`);
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });

  let copied = 0;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) {
      continue;
    }
    fs.copyFileSync(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
    copied += 1;
  }

  console.log(`[build] Copied ${copied} MathJax NewCM dynamic font chunk(s).`);
}

copyMathJaxFonts();
