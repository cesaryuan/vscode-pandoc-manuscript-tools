import assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type * as vscode from "vscode";
import { SourceModuleFixture } from "./helpers/sourceModule";

/** Checks the actual URI target, including path decoding and separate URL suffixes. */
function preservesResourceUrlComponents(): void {
  const source = path.resolve("resource-fixture");
  const resolvedPaths: string[] = [];
  const module = new SourceModuleFixture({ vscode: { Uri: {
    /** Captures the filesystem path before conversion to a URL can mask a decoding bug. */
    file(fsPath: string) { resolvedPaths.push(fsPath); return { fsPath }; },
  } } }).load<typeof import("../src/papperMarkdownPreview/webview")>("src/papperMarkdownPreview/webview.ts");
  const webview = {
    /** Uses standard file-URL escaping to model asWebviewUri's treatment of literal filenames. */
    asWebviewUri(uri: vscode.Uri) { return pathToFileURL(uri.fsPath); },
  } as unknown as vscode.Webview;
  const html = module.rewriteHtmlResourceUris('<img src="assets/figure%201.png?v=2&amp;theme=dark#panel"><a href="chapter.html#results">Go</a><img src="a&#38;b%23c.png"><img src="literal%ZZ.png">', webview, source);
  assert.deepEqual(resolvedPaths, [
    path.join(source, "assets", "figure 1.png"), path.join(source, "chapter.html"),
    path.join(source, "a&b#c.png"), path.join(source, "literal%ZZ.png"),
  ]);
  assert.ok(html.includes(`${pathToFileURL(resolvedPaths[0])}?v=2&amp;theme=dark#panel`));
  assert.ok(html.includes(`${pathToFileURL(resolvedPaths[1])}#results`));
  const external = '<a href="#local">Local</a><img src="https://example.com/a.png"><img src="data:image/png;base64,eA==">';
  assert.equal(module.rewriteHtmlResourceUris(external, webview, source), external);
}

test("HTML resources decode filenames and retain query/fragment components", preservesResourceUrlComponents);
