import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type * as vscode from "vscode";
import type { ParagraphTranslator } from "../src/paragraphTranslator";
import { SourceModuleFixture } from "./helpers/sourceModule";

/** Supplies real translator behavior while controlling only configuration and HTTP. */
class TranslationFixture {
  readonly translator: ParagraphTranslator;
  readonly logs: string[] = [];
  authCalls = 0;
  readonly authorization: string[] = [];
  readonly sources: string[] = [];
  rejectTokens = new Set<string>(["token-1"]);
  expireTokens = false;
  debug = false;

  /** Replaces fetch per test and restores it before another network fixture runs. */
  constructor(context: TestContext, engine: "google" | "microsoft" = "microsoft") {
    const fixture = this;
    const module = new SourceModuleFixture({
      "src/configuration.ts": { /** Exposes only the selected debug toggle and normal defaults. */
        getConfiguration: () => ({ /** Returns normal settings without an editor host. */
          get: (key: string, fallback: unknown) => key === "debugParagraphHoverTranslation" ? fixture.debug : fallback }),
      },
    }).load<{ ParagraphTranslator: typeof ParagraphTranslator }>("src/paragraphTranslator.ts");
    this.translator = new module.ParagraphTranslator({ /** Captures user-visible diagnostic output. */
      appendLine: (line: string) => { this.logs.push(line); } } as unknown as vscode.OutputChannel);
    this.translator.preferredEngine = engine;
    const originalFetch = globalThis.fetch;
    context.after(() => { globalThis.fetch = originalFetch; });
    /** Models short-lived authorization and translation responses, using actual request payloads. */
    globalThis.fetch = async (input, options) => {
      const url = String(input);
      if (url.includes("/auth")) {
        fixture.authCalls++;
        const token = fixture.expireTokens
          ? `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 10 })).toString("base64url")}.signature`
          : `token-${fixture.authCalls}`;
        return new Response(token);
      }
      const payload = JSON.parse(options!.body as string);
      const source = url.includes("googleapis") ? payload[0][0][0] : payload[0].Text;
      fixture.sources.push(source);
      if (url.includes("googleapis")) return Response.json([[`Translated ${source}`]]);
      const token = new Headers(options!.headers).get("Authorization")!.slice(7);
      fixture.authorization.push(token);
      return fixture.rejectTokens.has(token)
        ? new Response("Rejected sensitive body", { status: 401 })
        : Response.json([{ translations: [{ text: `Translated ${source}` }] }]);
    };
  }
}

/** Expired authorization is refreshed once, and the new token serves later paragraphs. */
async function recoversRejectedTokens(context: TestContext): Promise<void> {
  const fixture = new TranslationFixture(context);
  assert.equal((await fixture.translator.translateText("First source"))?.text, "Translated First source");
  assert.equal((await fixture.translator.translateText("Second source"))?.text, "Translated Second source");
  assert.equal(fixture.authCalls, 2);
  assert.deepEqual(fixture.authorization, ["token-1", "token-2", "token-2"]);
}

/** Persistent rejection stays bounded and does not poison a later hover's retry. */
async function boundsRejectedTokenRetries(context: TestContext): Promise<void> {
  const fixture = new TranslationFixture(context);
  fixture.rejectTokens = new Set(["token-1", "token-2"]);
  assert.equal(await fixture.translator.translateText("Retry me"), undefined);
  assert.equal(fixture.authorization.length, 2);
  assert.equal((await fixture.translator.translateText("Retry me"))?.text, "Translated Retry me");
  assert.equal(fixture.authCalls, 3);
}

/** Concurrent failures share a refresh rather than invalidating another request's newer token. */
async function coalescesTokenRefresh(context: TestContext): Promise<void> {
  const fixture = new TranslationFixture(context);
  const results = await Promise.all([fixture.translator.translateText("First"), fixture.translator.translateText("Second")]);
  assert.deepEqual(results.map((value) => value?.text), ["Translated First", "Translated Second"]);
  assert.equal(fixture.authCalls, 2);
}

/** Token expiry hints trigger a fresh authentication request without waiting for a 401. */
async function honorsTokenExpiry(context: TestContext): Promise<void> {
  const fixture = new TranslationFixture(context);
  fixture.expireTokens = true;
  fixture.rejectTokens.clear();
  await fixture.translator.translateText("First");
  await fixture.translator.translateText("Second");
  assert.equal(fixture.authCalls, 2);
}

/** Normal logging retains useful metadata; full paragraph and error bodies require debug mode. */
async function logsMetadataByDefault(context: TestContext): Promise<void> {
  const fixture = new TranslationFixture(context, "google");
  await fixture.translator.translateText("PRIVATE_SOURCE_TEXT");
  assert.ok(fixture.logs.some((line) => line.includes("duration=") && line.includes("sourceCharacters=")));
  assert.ok(fixture.logs.every((line) => !line.includes("PRIVATE_SOURCE_TEXT")));
  fixture.debug = true;
  await fixture.translator.translateText("DEBUG_SOURCE_TEXT");
  assert.ok(fixture.logs.includes("DEBUG_SOURCE_TEXT"));
  assert.ok(fixture.logs.includes("Translated DEBUG_SOURCE_TEXT"));
}

/** Recent translations stay reusable while old paragraphs are eventually translated again. */
async function boundsTranslationReuse(context: TestContext): Promise<void> {
  const fixture = new TranslationFixture(context, "google");
  await Promise.all([fixture.translator.translateText("same"), fixture.translator.translateText("same")]);
  assert.equal(fixture.sources.length, 1);
  for (let index = 0; index < 300; index++) await fixture.translator.translateText(`paragraph ${index}`);
  await fixture.translator.translateText("paragraph 299");
  assert.equal(fixture.sources.length, 301);
  await fixture.translator.translateText("same");
  assert.equal(fixture.sources.length, 302);
}

test("Microsoft translation recovers a rejected token and reuses its replacement", recoversRejectedTokens);
test("Microsoft authorization retry is bounded and later hovers can recover", boundsRejectedTokenRetries);
test("Concurrent Microsoft translation failures share one token refresh", coalescesTokenRefresh);
test("Microsoft translation renews tokens after their expiry", honorsTokenExpiry);
test("Translation logs contain metadata by default and full text only in debug mode", logsMetadataByDefault);
test("Translation cache coalesces duplicate work and evicts old paragraphs", boundsTranslationReuse);
