import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOrigin, githubRepository } from "../src/git.mjs";

test("GitHub remotes become owner/name, other hosts are not linked", () => {
  assert.equal(githubRepository("https://github.com/owner/repo.git"), "owner/repo");
  assert.equal(githubRepository("git@github.com:owner/repo.git"), "owner/repo");
  assert.equal(githubRepository("https://github.com/owner/repo"), "owner/repo");
  assert.equal(githubRepository("https://gitlab.com/owner/repo.git"), undefined);
  assert.equal(githubRepository(null), undefined);
});

test("a pull_request run records the head commit, branch, PR number and title", () => {
  const dir = mkdtempSync(join(tmpdir(), "jojapi-git-"));
  const eventPath = join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 12, title: "TEST faster search", head: { sha: "a".repeat(40) } } }));
  const origin = gitOrigin(dir, {
    GITHUB_ACTIONS: "true",
    GITHUB_SHA: "b".repeat(40), // the merge commit GitHub creates for the PR
    GITHUB_HEAD_REF: "feature/search",
    GITHUB_REF_NAME: "12/merge",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_EVENT_PATH: eventPath,
  });
  assert.deepEqual(origin.git, { commit: "a".repeat(40), branch: "feature/search", repository: "owner/repo", ci: "github-actions", pr: 12 });
  assert.equal(origin.message, "TEST faster search");
});

test("a push run records the pushed commit and its message's first line", () => {
  const dir = mkdtempSync(join(tmpdir(), "jojapi-git-"));
  const eventPath = join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify({ head_commit: { message: "TEST merge search\n\nlong body" } }));
  const origin = gitOrigin(dir, { GITHUB_ACTIONS: "true", GITHUB_SHA: "c".repeat(40), GITHUB_REF_NAME: "main", GITHUB_REPOSITORY: "owner/repo", GITHUB_EVENT_PATH: eventPath });
  assert.deepEqual(origin.git, { commit: "c".repeat(40), branch: "main", repository: "owner/repo", ci: "github-actions" });
  assert.equal(origin.message, "TEST merge search");
});

test("outside git and CI there is no origin", () => {
  const dir = mkdtempSync(join(tmpdir(), "jojapi-git-"));
  assert.deepEqual(gitOrigin(dir, {}), { git: null, message: undefined });
});
