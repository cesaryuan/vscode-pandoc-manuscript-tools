import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);
type CacheRun = { html: string; converted: number; reused: number; unavailable: number; svg: string };

/** Exercises persistent caches across converter upgrades without changing repository assets. */
class MetafileCacheFixture {
  /** Stores an isolated extension layout and its selected source or bundle execution mode. */
  constructor(readonly directory: string, readonly bundled: boolean) {}

  /** Copies the real converter and an EMF image into disposable extension/project storage. */
  static async create(context: TestContext, bundled: boolean): Promise<MetafileCacheFixture> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pmt-metafile-cache-"));
    context.after(async () => {
      await fs.rm(directory, { recursive: true, force: true });
    });
    const root = path.resolve(__dirname, "..");
    await fs.mkdir(path.join(directory, "src", "imagePreview"), { recursive: true });
    await fs.mkdir(path.join(directory, "project"));
    await Promise.all([
      fs.copyFile(path.join(root, "src", "htmlPreviewResourceCache.ts"), path.join(directory, "src", "htmlPreviewResourceCache.ts")),
      fs.copyFile(path.join(root, "src", "imagePreview", "libemf2svgRuntime.ts"), path.join(directory, "src", "imagePreview", "libemf2svgRuntime.ts")),
      fs.cp(path.join(root, "assets", "libemf2svg"), path.join(directory, "assets", "libemf2svg"), { recursive: true }),
      fs.copyFile(path.join(root, "test_project", "assets", "document-icon.emf"), path.join(directory, "project", "image.emf")),
    ]);
    // A fresh process models an extension reload after upgrading the bundled converter.
    await fs.writeFile(path.join(directory, "worker.ts"), `
/** Runs one isolated HTML preview and reports both cache behavior and the generated SVG. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { cacheHtmlMetafileImages } from "./src/htmlPreviewResourceCache";

/** Converts the fixture image using the same persistent cache across process restarts. */
async function main(): Promise<void> {
  const project = path.join(process.argv[2], "project");
  const result = await cacheHtmlMetafileImages(
    '<img src="image.emf">', project, project, path.join(project, "cache"),
    /** Exposes the cache file path so the worker can read the resulting SVG. */
    (filePath) => filePath,
    { /** Keeps diagnostics on stderr so stdout remains machine-readable. */
      appendLine(message) { console.error(message); } },
  );
  const svgPath = /src="([^"]+)"/.exec(result.html)?.[1];
  const svg = result.unavailable ? "" : await fs.readFile(svgPath!, "utf8");
  console.log(JSON.stringify({ ...result, svg }));
}

/** Reports failures without leaving a child process running. */
main().catch((error) => { console.error(error); process.exitCode = 1; });
`, "utf8");
    const fixture = new MetafileCacheFixture(directory, bundled);
    await fixture.bundle();
    return fixture;
  }

  /** Builds with the production minification and Node settings when testing packaged execution. */
  async bundle(): Promise<void> {
    if (this.bundled) {
      await build({
        entryPoints: [path.join(this.directory, "worker.ts")],
        outfile: path.join(this.directory, "dist", "worker.js"),
        bundle: true, platform: "node", format: "cjs", target: "node20",
        minify: true, legalComments: "none",
      });
    }
  }

  /** Restarts the converter while retaining the source image and persisted SVG cache. */
  async render(): Promise<CacheRun> {
    const args = this.bundled
      ? [path.join(this.directory, "dist", "worker.js"), this.directory]
      : [require.resolve("tsx/cli"), path.join(this.directory, "worker.ts"), this.directory];
    const { stdout } = await execFileAsync(process.execPath, args);
    return JSON.parse(stdout);
  }

  /** Verifies content changes invalidate caches even when library size and mtime are preserved. */
  async changeJavascript(): Promise<void> {
    const filePath = path.join(this.directory, "assets", "libemf2svg", "emf2svg.js");
    const stat = await fs.stat(filePath);
    const source = await fs.readFile(filePath, "utf8");
    assert.ok(source.includes('"./this.program"'));
    await fs.writeFile(filePath, source.replace('"./this.program"', '"./next.program"'), "utf8");
    await fs.utimes(filePath, stat.atime, stat.mtime);
    await this.bundle();
  }

  /** Adds a valid custom section, preserving WASM conversion behavior while changing its contents. */
  async changeWasm(): Promise<void> {
    await fs.appendFile(path.join(this.directory, "assets", "libemf2svg", "emf2svg.wasm"), Buffer.from([0, 2, 1, 120]));
  }
}

/** Verifies warm reuse and automatic regeneration after independent JS and WASM upgrades. */
async function verifiesConverterUpgradeInvalidation(context: TestContext, bundled: boolean): Promise<void> {
  const fixture = await MetafileCacheFixture.create(context, bundled);
  const first = await fixture.render();
  assert.equal(first.unavailable, 0);
  assert.equal(first.converted, 1);
  assert.match(first.svg, /<svg\b/);

  const warm = await fixture.render();
  assert.equal(warm.reused, 1);
  assert.equal(warm.html, first.html);

  await fixture.changeJavascript();
  const afterJavascript = await fixture.render();
  assert.equal(afterJavascript.unavailable, 0);
  assert.equal(afterJavascript.converted, 1);
  assert.notEqual(afterJavascript.html, first.html);
  assert.match(afterJavascript.svg, /<svg\b/);

  await fixture.changeWasm();
  const afterWasm = await fixture.render();
  assert.equal(afterWasm.unavailable, 0);
  assert.equal(afterWasm.converted, 1);
  assert.notEqual(afterWasm.html, afterJavascript.html);
  assert.match(afterWasm.svg, /<svg\b/);

  const upgradedWarm = await fixture.render();
  assert.equal(upgradedWarm.reused, 1);
  assert.equal(upgradedWarm.html, afterWasm.html);
}

/** Covers direct TypeScript execution and its source-relative converter paths. */
async function verifiesSourceCacheInvalidation(context: TestContext): Promise<void> {
  await verifiesConverterUpgradeInvalidation(context, false);
}

/** Covers the packaged extension layout with bundled JavaScript and external WASM assets. */
async function verifiesBundledCacheInvalidation(context: TestContext): Promise<void> {
  await verifiesConverterUpgradeInvalidation(context, true);
}

test("regenerates source-run HTML metafile previews after JS or WASM upgrades", verifiesSourceCacheInvalidation);
test("regenerates bundled HTML metafile previews after JS or WASM upgrades", verifiesBundledCacheInvalidation);
