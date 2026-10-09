import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { transformSync } from "esbuild";

/** Loads real production modules in isolation with explicit host/service replacements. */
export class SourceModuleFixture {
  private readonly modules = new Map<string, { exports: unknown }>();
  private readonly root = path.resolve(__dirname, "../..");

  /** Overrides use repository-relative module filenames, or bare names such as vscode. */
  constructor(private readonly replacements: Record<string, unknown>) {}

  /** Evaluates TypeScript without replacing the production code being exercised. */
  load<T>(relativePath: string): T {
    if (relativePath in this.replacements) return this.replacements[relativePath] as T;
    const filename = path.resolve(this.root, relativePath);
    const cached = this.modules.get(filename);
    if (cached) return cached.exports as T;
    const module = { exports: {} };
    this.modules.set(filename, module);
    const nativeRequire = createRequire(filename);
    /** Resolves source imports recursively while leaving external packages and Node APIs intact. */
    const requireSource = (name: string): unknown => {
      if (name in this.replacements) return this.replacements[name];
      const sourcePath = path.resolve(path.dirname(filename), name);
      const target = existsSync(`${sourcePath}.ts`) ? `${sourcePath}.ts` : path.join(sourcePath, "index.ts");
      if (name.startsWith(".") && existsSync(target)) {
        return this.load(path.relative(this.root, target).replace(/\\/g, "/"));
      }
      return nativeRequire(name);
    };
    const code = transformSync(readFileSync(filename, "utf8"), { loader: "ts", format: "cjs", target: "node20" }).code;
    new Function("require", "module", "exports", "__dirname", code)(requireSource, module, module.exports, path.dirname(filename));
    return module.exports as T;
  }
}
