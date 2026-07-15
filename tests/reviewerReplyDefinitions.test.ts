import assert from "node:assert/strict";
import test from "node:test";
import { isReviewerReplyPath, mergeReviewerReplyDefinitions, resolveReviewerReplyDefinitions } from "../src/reviewerReplyDefinitions";

/** Verifies the exact special-case filename across supported path styles. */
function verifiesReviewerReplyPathRecognition(): void {
  assert.equal(isReviewerReplyPath("/workspace/reply_to_reviewers.md"), true);
  assert.equal(isReviewerReplyPath("E:\\paper\\submissions\\REPLY_TO_REVIEWERS.MD"), true);
  assert.equal(isReviewerReplyPath("/workspace/reply_to_reviewers_first.md"), false);
}

/** Verifies that ordinary Markdown documents keep document-local definitions. */
function verifiesReviewerReplyDefinitionMerge(): void {
  const localDefinitions = ["eq:reply"];
  const manuscriptDefinitions = ["eq:method", "fig:pipeline"];

  assert.deepEqual(
    mergeReviewerReplyDefinitions("/workspace/reply_to_reviewers.md", localDefinitions, manuscriptDefinitions),
    ["eq:reply", "eq:method", "fig:pipeline"],
  );
  assert.equal(
    mergeReviewerReplyDefinitions("/workspace/notes.md", localDefinitions, manuscriptDefinitions),
    localDefinitions,
  );
}

/** Verifies local definitions override matching manuscript definitions. */
function verifiesReviewerReplyDefinitionResolution(): void {
  assert.deepEqual(
    resolveReviewerReplyDefinitions("/workspace/reply_to_reviewers.md", [], ["eq:method"]),
    ["eq:method"],
  );
  assert.deepEqual(
    resolveReviewerReplyDefinitions("/workspace/reply_to_reviewers.md", ["eq:local"], ["eq:manuscript"]),
    ["eq:local"],
  );
}

test("recognizes reply_to_reviewers.md across URI and Windows paths", verifiesReviewerReplyPathRecognition);
test("adds manuscript definitions only for reply_to_reviewers.md", verifiesReviewerReplyDefinitionMerge);
test("uses manuscript definitions only when a reviewer reply has no local match", verifiesReviewerReplyDefinitionResolution);
