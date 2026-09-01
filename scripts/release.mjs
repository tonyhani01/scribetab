#!/usr/bin/env node
// Local release-prep CLI for ScribeTab.
//
// Usage: node scripts/release.mjs <patch|minor|major|x.y.z> [--dry-run] [--allow-branch]
//
// Pure Node stdlib, ESM. Prepares a release locally: bumps the version in both
// package.json files, updates CHANGELOG.md, runs typecheck/test/zip/release
// checks, then commits and tags. NEVER pushes — pushing is a manual step
// after review.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT_PACKAGE = "package.json";
const EXT_PACKAGE = "apps/extension/package.json";
const CHANGELOG = "CHANGELOG.md";
const README = "README.md";
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * Bump a "x.y.z" version string.
 * @param {string} current current version, e.g. "1.1.0"
 * @param {string} arg "patch" | "minor" | "major" | explicit "x.y.z"
 * @returns {string} the new "x.y.z" version
 * @throws {Error} on invalid current version or invalid bump argument
 */
export function bumpVersion(current, arg) {
  if (typeof current !== "string" || !VERSION_RE.test(current)) {
    throw new Error(`invalid current version ${JSON.stringify(current)} — expected "x.y.z"`);
  }
  const [maj, min, pat] = current.split(".").map(Number);
  if (arg === "patch") return `${maj}.${min}.${pat + 1}`;
  if (arg === "minor") return `${maj}.${min + 1}.0`;
  if (arg === "major") return `${maj + 1}.0.0`;
  if (typeof arg === "string" && VERSION_RE.test(arg)) return arg;
  throw new Error(`invalid bump argument ${JSON.stringify(arg)} — expected patch|minor|major or "x.y.z"`);
}

/**
 * Render the markdown section for one release.
 * @param {string} version new version, e.g. "1.2.0"
 * @param {string} dateISO ISO date (full timestamp or "YYYY-MM-DD")
 * @param {string[]} subjects commit subjects for this release
 * @returns {string} markdown ending with a newline
 */
export function changelogSection(version, dateISO, subjects = []) {
  const date = String(dateISO).slice(0, 10);
  const list = (Array.isArray(subjects) ? subjects : [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const body = list.length > 0 ? list.map((s) => `- ${s}`).join("\n") : "- No changes recorded.";
  return `## v${version} — ${date}\n\n${body}\n`;
}

// ---------------------------------------------------------------------------
// internals (CLI only)
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function printUsage() {
  console.log(`scribetab release — prepare a release locally

Usage: node scripts/release.mjs <patch|minor|major|x.y.z> [options]

Arguments:
  <patch|minor|major|x.y.z>   Bump type, or an explicit version

Options:
  --dry-run                   Preview the version bump and changelog; write nothing
  --allow-branch              Allow running on a branch other than main
  -h, --help                  Show this help

Flow: preflight checks → bump version → update CHANGELOG.md →
pnpm -r typecheck, pnpm -r test, extension zip, release-checks →
commit "chore(release): vX.Y.Z" + annotated tag v*X.Y.Z.

Never runs git push. After review, push manually:
  git push origin main vX.Y.Z`);
}

function gitOut(args) {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0 || r.error) {
    const detail = (r.stderr || "").trim().split("\n")[0] || (r.error?.message ?? "");
    fail(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return r.stdout;
}

function gitOk(args) {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return !r.error && r.status === 0;
}

/** Stream a subprocess's output; true on exit code 0. */
function run(cmd, args) {
  console.log(`\n→ ${[cmd, ...args].join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  return !r.error && r.status === 0;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`cannot read ${path}: ${err.message}`);
  }
}

function writeVersion(path, version) {
  const pkg = readJson(path);
  pkg.version = version;
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n", "utf8");
}

/** Update the `**Status: vX.Y.Z.**` line in README.md, if present. */
function writeReadmeVersion(version) {
  let text;
  try {
    text = readFileSync(README, "utf8");
  } catch {
    return;
  }
  const updated = text.replace(/\*\*Status: v\d+\.\d+\.\d+\.\*\*/, `**Status: v${version}.**`);
  if (updated !== text) writeFileSync(README, updated, "utf8");
}

function lastTag() {
  const out = gitOut(["tag", "--list", "v*", "--sort=-v:refname"]);
  return out.split("\n").map((l) => l.trim()).find(Boolean) ?? null;
}

function commitSubjects() {
  const tag = lastTag();
  return gitOut(["log", "--format=%s", tag ? `${tag}..HEAD` : "HEAD"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Insert a new section directly under the "# Changelog" header (adding it if absent). */
function insertChangelogSection(existing, section) {
  if (!existing.trim()) return `# Changelog\n\n${section}`;
  if (/^#\s+Changelog\b/.test(existing)) {
    const lines = existing.split("\n");
    let i = 1;
    while (i < lines.length && lines[i].trim() === "") i += 1;
    return `${lines[0]}\n\n${section}\n${lines.slice(i).join("\n")}`;
  }
  return `# Changelog\n\n${section}\n${existing}`;
}

/**
 * Restore files touched by a failed release. Matches
 * `git checkout -- package.json apps/extension/package.json CHANGELOG.md`
 * when CHANGELOG.md is tracked; a newly created (untracked) CHANGELOG.md
 * is removed or rewound directly instead, since git checkout cannot.
 */
function restoreFiles(changelogTracked, originalChangelog) {
  const paths = [ROOT_PACKAGE, EXT_PACKAGE, README, ...(changelogTracked ? [CHANGELOG] : [])];
  spawnSync("git", ["checkout", "--", ...paths], { stdio: "inherit" });
  if (!changelogTracked) {
    if (originalChangelog === null) rmSync(CHANGELOG, { force: true });
    else writeFileSync(CHANGELOG, originalChangelog, "utf8");
  }
}

function main(argv) {
  const bumpArgs = [];
  let dryRun = false;
  let allowBranch = false;

  for (const a of argv) {
    if (a === "--dry-run") dryRun = true;
    else if (a === "--allow-branch") allowBranch = true;
    else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else if (a.startsWith("-")) {
      fail(`unknown option '${a}' — see --help`);
    } else {
      bumpArgs.push(a);
    }
  }
  if (bumpArgs.length === 0) {
    fail("missing version argument — usage: node scripts/release.mjs <patch|minor|major|x.y.z> [--dry-run] [--allow-branch]");
  }
  if (bumpArgs.length > 1) {
    fail(`expected one version argument, got ${bumpArgs.length}: ${bumpArgs.join(" ")}`);
  }
  const arg = bumpArgs[0];

  // 1. Preflight (read-only).
  const dirty = gitOut(["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.trim() !== "") {
    fail("working tree has uncommitted changes — commit or stash before releasing");
  }
  const branch = gitOut(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (branch !== "main" && !allowBranch) {
    fail(`refusing to release from branch '${branch}' — switch to main or pass --allow-branch`);
  }
  const rootPkg = readJson(ROOT_PACKAGE);
  const extPkg = readJson(EXT_PACKAGE);
  if (rootPkg.version !== extPkg.version) {
    fail(`version mismatch: ${ROOT_PACKAGE}=${rootPkg.version}, ${EXT_PACKAGE}=${extPkg.version}`);
  }
  const current = rootPkg.version;

  // 2. Compute new version.
  let next;
  try {
    next = bumpVersion(current, arg);
  } catch (err) {
    fail(`invalid bump '${arg}': ${err.message}`);
  }

  // Changelog content (git reads only).
  const section = changelogSection(next, new Date().toISOString(), commitSubjects());

  // 3. Dry run: preview and exit without writing anything.
  if (dryRun) {
    console.log(`Dry run: ${current} → ${next}`);
    console.log("\nChangelog section to add:\n");
    console.log(section);
    console.log("Dry run — no files modified.");
    process.exit(0);
  }

  // 4. Write the new version into both package.json files.
  writeVersion(ROOT_PACKAGE, next);
  writeVersion(EXT_PACKAGE, next);
  writeReadmeVersion(next);

  // 5. Prepend the changelog section under the top header.
  const changelogExisted = existsSync(CHANGELOG);
  const changelogTracked = changelogExisted && gitOk(["ls-files", "--error-unmatch", CHANGELOG]);
  const originalChangelog = changelogExisted ? readFileSync(CHANGELOG, "utf8") : null;
  writeFileSync(
    CHANGELOG,
    changelogExisted ? insertChangelogSection(originalChangelog, section) : `# Changelog\n\n${section}`,
    "utf8",
  );

  // 6. Verify sequentially, streaming output; restore files on any failure.
  const steps = [
    ["pnpm", ["-r", "typecheck"]],
    ["pnpm", ["-r", "test"]],
    ["pnpm", ["--filter", "@scribetab/extension", "zip"]],
    ["node", ["scripts/release-checks.mjs", "--version", next]],
  ];
  for (const [cmd, args] of steps) {
    if (!run(cmd, args)) {
      console.error(`✗ '${cmd} ${args.join(" ")}' failed — restoring files.`);
      restoreFiles(changelogTracked, originalChangelog);
      process.exit(1);
    }
  }

  // 7. Commit and tag. Never push (step 8 is a printed instruction only).
  if (!run("git", ["add", ROOT_PACKAGE, EXT_PACKAGE, README, CHANGELOG])) fail("git add failed");
  if (!run("git", ["commit", "-m", `chore(release): v${next}`])) fail("git commit failed");
  if (!run("git", ["tag", "-a", `v${next}`, "-m", `v${next}`])) fail("git tag failed");

  console.log(`\n✓ Release v${next} prepared.`);
  console.log(`Next step: git push origin main v${next} (manual, after review).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
