import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import type * as vscode from "vscode";
import type { PandocWorkspaceIndex } from "../src/workspaceIndex";
import { SourceModuleFixture } from "./helpers/sourceModule";

/** Supplies definition files and editor buffers independently of each other. */
class IndexFixture {
  readonly index: PandocWorkspaceIndex;
  readonly documents: vscode.TextDocument[] = [];
  source = "![Manuscript](image.png){#fig:source}";
  failure: string | undefined;

  /** Models filesystem deletion and transient failure while executing real indexing code. */
  constructor() {
    const fixture = this;
    const host = {
      workspace: {
        textDocuments: this.documents,
        /** Resolves the reviewer's workspace-level manuscript source. */
        getWorkspaceFolder: () => ({ uri: IndexFixture.uri("") }),
        fs: { /** Makes filesystem failures explicit without creating repository fixtures. */
          async readFile() {
            if (fixture.failure) throw Object.assign(new Error(fixture.failure), { code: fixture.failure });
            return Buffer.from(fixture.source);
          } },
      },
      Uri: { /** Resolves the root manuscript path as the production code requests it. */
        joinPath: (_root: vscode.Uri, name: string) => IndexFixture.uri(name) },
    };
    const module = new SourceModuleFixture({ vscode: host,
      "src/configuration.ts": { /** Disables optional workspace preloading in this definition-scope fixture. */
        getConfiguration: () => ({ /** Keeps the index on open buffers plus reviewer dependencies. */ get: () => false }) },
    }).load<{ PandocWorkspaceIndex: typeof PandocWorkspaceIndex }>("src/workspaceIndex.ts");
    this.index = new module.PandocWorkspaceIndex({ /** Suppresses expected missing-file diagnostics. */ appendLine() {} } as unknown as vscode.OutputChannel);
  }

  /** Provides a consistent workspace-relative file identity. */
  static uri(name: string): vscode.Uri {
    const fsPath = path.resolve("index-fixture", name);
    return { scheme: "file", fsPath, path: fsPath.replace(/\\/g, "/"),
      /** Provides the same key for cache reads and writes. */ toString: () => `file:${fsPath}` } as vscode.Uri;
  }

  /** Creates a Markdown buffer and adds it to the host's open documents. */
  document(name: string, text: string): vscode.TextDocument {
    const document = { uri: IndexFixture.uri(name), languageId: "markdown", version: 1,
      /** Keeps source text separate from the filesystem manuscript. */ getText: () => text } as vscode.TextDocument;
    this.documents.push(document);
    return document;
  }
}

/** Deleted reviewer sources must stop contributing definitions and recover when recreated. */
async function removesDeletedManuscriptDefinitions(): Promise<void> {
  for (const code of ["ENOENT", "ENOTDIR", "FileNotFound"]) {
    const fixture = new IndexFixture();
    const reply = fixture.document("reply_to_reviewers.md", "See @fig:source");
    await fixture.index.refreshWorkspace();
    assert.equal(fixture.index.getDefinitions(reply, "fig:source").length, 1);
    fixture.failure = code;
    await fixture.index.refreshWorkspace();
    assert.equal(fixture.index.getDefinitions(reply, "fig:source").length, 0);
    fixture.failure = undefined;
    fixture.source = "![New](new.png){#fig:new}";
    await fixture.index.refreshWorkspace();
    assert.equal(fixture.index.getDefinitions(reply, "fig:new").length, 1);
    assert.equal(fixture.index.getDefinitions(reply, "fig:source").length, 0);
  }
}

/** Temporary access failures preserve known definitions instead of producing false warnings. */
async function preservesDefinitionsOnTransientFailures(): Promise<void> {
  const fixture = new IndexFixture();
  const reply = fixture.document("reply_to_reviewers.md", "See @fig:source");
  await fixture.index.refreshWorkspace();
  fixture.failure = "EACCES";
  await fixture.index.refreshWorkspace();
  assert.equal(fixture.index.getDefinitions(reply, "fig:source").length, 1);
}

/** Map lookups retain local precedence, duplicate counts, source locations, and reference ordering. */
async function preservesIndexedLookupSemantics(): Promise<void> {
  const fixture = new IndexFixture();
  const reply = fixture.document("reply_to_reviewers.md", "![Local](local.png){#fig:source}\n\nSee @fig:source and @fig:source\n\n![Duplicate](other.png){#fig:source}");
  const ordinary = fixture.document("ordinary.md", "See @fig:source");
  await fixture.index.refreshWorkspace();
  const definitions = fixture.index.getDefinitions(reply, "fig:source");
  assert.equal(definitions.length, 2);
  assert.ok(definitions.every((entry) => entry.uriText === reply.uri.toString()));
  assert.deepEqual(fixture.index.getReferences(reply, "fig:source").map((entry) => entry.line), [2, 2]);
  assert.deepEqual(fixture.index.getDocumentEntriesByLabel(reply, "labels", "fig:source"), definitions);
  assert.equal(fixture.index.getDefinitionMap(reply).get("fig:source")?.length, 2);
  assert.deepEqual(fixture.index.getDefinitions(ordinary, "fig:source"), []);
}

test("Reviewer definitions disappear after manuscript deletion and follow recreation", removesDeletedManuscriptDefinitions);
test("Reviewer definitions survive transient manuscript read failures", preservesDefinitionsOnTransientFailures);
test("Indexed lookups preserve document scope, duplicates and reviewer precedence", preservesIndexedLookupSemantics);
