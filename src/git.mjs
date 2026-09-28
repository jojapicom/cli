// Where the deployed code comes from, sent with every deploy so Studio can link
// a deployment to its commit: GitHub Actions' environment when running there,
// otherwise the local git checkout (if any). Nothing here is required; a
// deploy outside git simply carries no origin.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// { git: {commit, branch, repository, pr, ci, dirty}, message } — both optional
export function gitOrigin(dir, env = process.env) {
  if (env.GITHUB_ACTIONS === "true") return fromGitHubActions(env);
  return fromCheckout(dir);
}

function fromGitHubActions(env) {
  let event = {};
  try {
    event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {};
  } catch {
    event = {};
  }
  const pr = event.pull_request ?? null;
  const git = {
    // On pull_request events GITHUB_SHA is a merge commit; the head is what was pushed
    commit: pr?.head?.sha ?? env.GITHUB_SHA,
    branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME,
    repository: env.GITHUB_REPOSITORY,
    ci: "github-actions",
  };
  if (pr?.number) git.pr = pr.number;
  const message = pr?.title ?? firstLine(event.head_commit?.message);
  return { git: clean(git), message };
}

function fromCheckout(dir) {
  const run = (...args) => {
    try {
      return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  const commit = run("rev-parse", "HEAD");
  if (!commit) return { git: null, message: undefined };
  const branch = run("rev-parse", "--abbrev-ref", "HEAD");
  const git = {
    commit,
    branch: branch && branch !== "HEAD" ? branch : undefined,
    repository: githubRepository(run("remote", "get-url", "origin")),
    dirty: (run("status", "--porcelain") ?? "") !== "" ? true : undefined,
  };
  return { git: clean(git), message: firstLine(run("log", "-1", "--pretty=%s")) };
}

// owner/name of a GitHub remote (https or ssh form); other hosts are not linked
export function githubRepository(url) {
  const match = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url ?? "");
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function firstLine(text) {
  if (typeof text !== "string") return undefined;
  const line = text.split("\n")[0].trim();
  return line === "" ? undefined : line.slice(0, 255);
}

function clean(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) if (value !== undefined && value !== null && value !== "") out[key] = value;
  return Object.keys(out).length > 0 ? out : null;
}
