#!/usr/bin/env node
// Mirrors cursor/plugins/pstack into this package, byte for byte, with link
// rewriting as the only touch. Two phases: `stageSync` prepares a reviewable
// candidate, `continueSync` publishes it after review.

import { spawnSync } from "node:child_process";
import { hash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve as resolvePath } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const REPOSITORY = "https://github.com/cursor/plugins";
const VENDOR = "vendor/pstack";
const OUTPUTS = ["skills", "agents", "LICENSE", "plugin.json"];
const STAGE = join(ROOT, ".pstack-sync");
const LINK = /\]\(([^)\s]+)\)/g;
// Top-level upstream paths that exist but are not shipped; links into them are
// rewritten to pinned absolute URLs during publish.
const KNOWN_REFERENCE = [".cursor-plugin", ".gitignore", "README.md", "assets", "automations", "docs", "guide"];

function git(cwd, args, options = {}) {
  const result = spawnSync("git", ["-C", cwd, "-c", "core.autocrlf=false", "-c", "core.filemode=true",
    "-c", "user.name=pstack sync", "-c", "user.email=pstack-sync@example.invalid",
    "-c", "commit.gpgsign=false", ...args], {
    encoding: options.binary ? null : "utf8", maxBuffer: Infinity, env: { ...process.env, ...options.env },
  });
  if (result.error) throw result.error;
  if (!(options.allow ?? [0]).includes(result.status)) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
  return result;
}

function gitText(cwd, ...args) {
  return git(cwd, args).stdout.trim();
}

function copyChildren(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source)) {
    cpSync(join(source, name), join(destination, name), { recursive: true, verbatimSymlinks: true });
  }
}

function npmGitignores(repo, tree) {
  return git(repo, ["ls-tree", "-r", "-z", tree]).stdout.split("\0").filter(Boolean).flatMap((entry) => {
    const [metadata, path] = entry.split("\t");
    if (path !== ".gitignore" && !path.endsWith("/.gitignore")) return [];
    const [mode, , object] = metadata.split(" ");
    return [{ path, mode, content: git(repo, ["cat-file", "blob", object], { binary: true }).stdout.toString("base64") }];
  });
}

function makeRepository(destination, source, provenance, allowPackagedSource) {
  mkdirSync(destination, { recursive: true });
  git(destination, ["init", "--quiet"]);
  copyChildren(source, destination);
  if (!Array.isArray(provenance.npmGitignoreFiles)) {
    throw new Error("Missing npm Git-ignore transport metadata in upstream.json.");
  }
  // npm omits .gitignore files from packages. Restore their recorded bytes only
  // for an unpacked package; a Git checkout must still contain the real source.
  for (const { path, mode, content } of provenance.npmGitignoreFiles) {
    const file = join(destination, path);
    if (existsSync(file)) continue;
    if (!allowPackagedSource) throw new Error(`Vendored source is missing ${path}.`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(content, "base64"));
    chmodSync(file, mode === "100755" ? 0o755 : 0o644);
  }
  git(destination, ["add", "--force", "--all"]);
  const tree = gitText(destination, "write-tree");
  if (JSON.stringify(npmGitignores(destination, tree)) !== JSON.stringify(provenance.npmGitignoreFiles)) {
    throw new Error("Vendored .gitignore files do not match the npm transport metadata.");
  }
  return tree;
}

function commitIndex(repo, message) {
  git(repo, ["commit", "--quiet", "--allow-empty", "-m", message]);
  return gitText(repo, "rev-parse", "HEAD");
}

function ignoredOutputs(root, reference) {
  const checkout = existsSync(join(root, ".git"));
  const options = checkout ? [] : [`--work-tree=${root}`];
  const paths = git(checkout ? root : reference, [...options, "ls-files", "--others", "--ignored",
    "--exclude-standard", "--directory", "-z", "--", ...OUTPUTS]).stdout;
  return new Set(paths.split("\0").filter(Boolean).map((path) => path.replace(/\/$/, "")));
}

function inventory(root, paths, ignored = new Set()) {
  const entries = new Map();
  function visit(rel) {
    if (ignored.has(rel.split("\\").join("/"))) return;
    const path = join(root, rel);
    let stat;
    try { stat = lstatSync(path); } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (stat.isDirectory()) {
      entries.set(rel, { type: "directory" });
      for (const name of readdirSync(path).sort()) visit(join(rel, name));
    } else if (stat.isSymbolicLink()) {
      entries.set(rel, { type: "link", target: readlinkSync(path) });
    } else {
      entries.set(rel, { type: "file", bytes: readFileSync(path), executable: (stat.mode & 0o111) !== 0 });
    }
  }
  for (const path of paths) visit(path);
  return entries;
}

function compareTrees(expected, actual, paths, ignored) {
  const want = inventory(expected, paths);
  const have = inventory(actual, paths, ignored);
  const problems = [];
  for (const [path, entry] of want) {
    const other = have.get(path);
    if (!other) problems.push(`Missing generated path: ${path}`);
    else if (entry.type !== other.type || entry.target !== other.target ||
      entry.executable !== other.executable || (entry.bytes && !entry.bytes.equals(other.bytes))) {
      problems.push(`Drifted generated path: ${path}`);
    }
  }
  for (const path of have.keys()) if (!want.has(path)) problems.push(`Unexpected generated path: ${path}`);
  return problems;
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function mirrorProblems(root, source, provenance) {
  const problems = [];
  for (const agent of ["poteto-agent.md", "comment-sicko.md"]) {
    if (!existsSync(join(root, "agents", agent))) problems.push(`Missing agents/${agent}`);
  }
  for (const path of OUTPUTS.slice(0, 2).flatMap((dir) => existsSync(join(root, dir)) ? walk(join(root, dir)) : [])) {
    if (!path.endsWith(".md")) continue;
    const rel = relative(root, path).split("\\").join("/");
    const text = readFileSync(path, "utf8");
    for (const [, href] of text.matchAll(LINK)) {
      const external = href.match(/^https:\/\/github\.com\/cursor\/plugins\/(?:blob|tree)\/([^/]+)\/pstack\//);
      if (external && external[1] !== provenance.pstackCommitSha) {
        problems.push(`${rel} links to unpinned upstream source: ${href}`);
      }
      const target = relativeSourceTarget(source, rel, href);
      if (target && !isShipped(root, target)) problems.push(`${rel} links to omitted upstream path: ${href}`);
    }
  }
  return problems;
}

function relativeSourceTarget(source, from, href) {
  const path = href.replace(/[#?].*/, "");
  if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("/")) return undefined;
  const target = posix.normalize(posix.join(posix.dirname(from), path)).replace(/\/$/, "");
  if (target === ".." || target.startsWith("../")) return undefined;
  return existsSync(join(source, target)) ? target : undefined;
}

function isShipped(root, target) {
  return OUTPUTS.some((path) => target === path || target.startsWith(`${path}/`)) &&
    existsSync(join(root, target));
}

function rewriteLinks(repo, commit) {
  const pinned = new RegExp(`https://github\\.com/cursor/plugins/(blob|tree)/(?:main|${commit})/pstack/`, "g");
  for (const path of OUTPUTS.slice(0, 2).flatMap((dir) => existsSync(join(repo, dir)) ? walk(join(repo, dir)) : [])) {
    if (!path.endsWith(".md")) continue;
    const rel = relative(repo, path).split("\\").join("/");
    let text = readFileSync(path, "utf8").replace(pinned, `${REPOSITORY}/$1/${commit}/pstack/`);
    text = text.replace(LINK, (link, href) => {
      const target = relativeSourceTarget(repo, rel, href);
      if (!target || isShipped(repo, target)) return link;
      const kind = statSync(join(repo, target)).isDirectory() ? "tree" : "blob";
      return `](${REPOSITORY}/${kind}/${commit}/pstack/${target}${href.slice(href.search(/[#?]|$/))})`;
    });
    writeFileSync(path, text);
  }
}

function checkTree(root, sourceRepo) {
  const provenance = JSON.parse(readFileSync(join(root, "upstream.json"), "utf8"));
  const source = join(root, VENDOR);
  const temp = mkdtempSync(join(tmpdir(), "pi-better-pstack-render-"));
  try {
    const tree = makeRepository(temp, source, provenance, !existsSync(join(root, ".git")));
    const problems = [];
    if (tree !== provenance.pstackTreeSha) problems.push(`Vendored pstack tree ${tree} != upstream.json ${provenance.pstackTreeSha}`);
    if (sourceRepo) {
      const upstreamTree = gitText(sourceRepo, "rev-parse", "HEAD:pstack");
      if (tree !== upstreamTree) problems.push(`Vendored pstack tree ${tree} != source ${upstreamTree}`);
    }
    const plugin = JSON.parse(readFileSync(join(source, "plugin.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (plugin.version !== provenance.version || pkg.version !== provenance.version) {
      problems.push("package.json, vendored plugin.json, and upstream.json versions differ");
    }
    rewriteLinks(temp, provenance.pstackCommitSha);
    problems.push(...compareTrees(temp, root, OUTPUTS, ignoredOutputs(root, temp)));
    problems.push(...mirrorProblems(temp, source, provenance));
    if (problems.length) throw new Error(problems.join("\n"));
    const skills = readdirSync(join(root, "skills")).filter((name) =>
      existsSync(join(root, "skills", name, "SKILL.md"))).length;
    return { provenance, skills };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function sourceMetadata(repo) {
  const repoCommitSha = gitText(repo, "rev-parse", "--verify", "HEAD^{commit}");
  const pstackCommitSha = gitText(repo, "log", "-1", "--format=%H", repoCommitSha, "--", "pstack");
  if (!pstackCommitSha) throw new Error("Could not determine the last commit touching pstack.");
  if (gitText(repo, "rev-parse", "--is-shallow-repository") === "true") {
    const shallowPath = resolvePath(repo, gitText(repo, "rev-parse", "--git-path", "shallow"));
    if (readFileSync(shallowPath, "utf8").split("\n").includes(pstackCommitSha)) {
      throw new Error("The last pstack commit is at the shallow boundary. Fetch the complete history before syncing.");
    }
  }
  const pstackTreeSha = gitText(repo, "rev-parse", `${repoCommitSha}:pstack`);
  const plugin = JSON.parse(git(repo, ["show", `${repoCommitSha}:pstack/plugin.json`]).stdout);
  return { repository: REPOSITORY, subpath: "pstack", version: plugin.version,
    repoCommitSha, pstackCommitSha, pstackTreeSha, npmGitignoreFiles: npmGitignores(repo, pstackTreeSha) };
}

function checkoutTree(repo, tree, destination, index) {
  mkdirSync(destination, { recursive: true });
  rmSync(index, { force: true });
  const options = { env: { GIT_INDEX_FILE: index } };
  git(repo, ["read-tree", tree], options);
  git(repo, ["checkout-index", "--all", `--prefix=${destination}/`], options);
  rmSync(index, { force: true });
}

function hashFile(path) {
  return hash("sha256", readFileSync(path), "hex");
}

function changes(repo, base, upstream) {
  const parts = git(repo, ["diff", "--name-status", "--find-renames", "-z", base, upstream]).stdout.split("\0");
  const changes = [];
  for (let index = 0; parts[index];) {
    const status = parts[index++];
    const oldPath = /^[RC]/.test(status) ? parts[index++] : undefined;
    const path = parts[index++];
    const top = path.split("/")[0];
    const shipped = OUTPUTS.includes(top);
    const knownReference = KNOWN_REFERENCE.includes(top);
    changes.push({ status, ...(oldPath ? { oldPath } : {}), path,
      classification: shipped ? "shipped" : knownReference || !status.startsWith("A") ? "source-only" : null });
  }
  return changes;
}

function stageSync(source) {
  if (existsSync(STAGE)) throw new Error(`A sync is already staged at ${STAGE}. Finish it or remove that staging directory.`);
  const current = checkTree(ROOT).provenance;
  const incoming = sourceMetadata(source);
  if (incoming.pstackTreeSha === current.pstackTreeSha) {
    console.log(`pstack is already at upstream tree ${incoming.pstackTreeSha}; no sync needed.`);
    return;
  }
  mkdirSync(STAGE);
  const repo = join(STAGE, "worktree");
  const tree = makeRepository(repo, join(ROOT, VENDOR), current, !existsSync(join(ROOT, ".git")));
  if (tree !== current.pstackTreeSha) throw new Error("Vendored tree changed while staging; no generated files were written.");
  const base = commitIndex(repo, "Pinned upstream");
  git(repo, ["switch", "--quiet", "-c", "incoming-upstream"]);
  for (const name of readdirSync(repo)) if (name !== ".git") rmSync(join(repo, name), { recursive: true, force: true });
  checkoutTree(source, incoming.pstackTreeSha, repo, join(STAGE, "source.index"));
  git(repo, ["add", "--force", "--all"]);
  const staged = gitText(repo, "write-tree");
  if (staged !== incoming.pstackTreeSha) {
    throw new Error(`Staged tree ${staged} does not match upstream ${incoming.pstackTreeSha}; no generated files were written.`);
  }
  const upstream = commitIndex(repo, "Incoming upstream");
  const metadata = { current, incoming, base, upstream,
    provenanceHash: hashFile(join(ROOT, "upstream.json")) };
  const review = { changes: changes(repo, base, upstream), approvedSkillRemovals: [] };
  writeFileSync(join(STAGE, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  writeFileSync(join(STAGE, "review.json"), `${JSON.stringify(review, null, 2)}\n`);
  console.log(`Staged upstream ${current.pstackCommitSha.slice(0, 7)} -> ${incoming.pstackCommitSha.slice(0, 7)} in ${repo}.`);
  for (const change of review.changes) {
    console.log(`${change.status} ${change.oldPath ? `${change.oldPath} -> ` : ""}${change.path}` +
      ` [${change.classification ?? "unclassified"}]`);
  }
  console.log(`Review every upstream change: git -C ${repo} diff ${base} ${upstream}`);
  console.log(`Classify unknown additions and approve intentional skill removals in ${join(STAGE, "review.json")}.`);
  console.log(`Then run npm run sync -- --continue.`);
}

function shippedSkills(root) {
  const dir = join(root, "skills");
  return existsSync(dir) ? readdirSync(dir).filter((name) => existsSync(join(dir, name, "SKILL.md"))) : [];
}

function publish(candidate, paths) {
  const backup = join(STAGE, "backup");
  const moved = [];
  try {
    for (const rel of paths) {
      const destination = join(ROOT, rel);
      const previous = join(backup, rel);
      mkdirSync(dirname(destination), { recursive: true });
      mkdirSync(dirname(previous), { recursive: true });
      const hadPrevious = existsSync(destination);
      if (hadPrevious) renameSync(destination, previous);
      moved.push({ destination, previous, hadPrevious });
      renameSync(join(candidate, rel), destination);
    }
  } catch (error) {
    const failures = [];
    for (const { destination, previous, hadPrevious } of moved.reverse()) {
      try {
        rmSync(destination, { recursive: true, force: true });
        if (hadPrevious) renameSync(previous, destination);
      } catch (rollbackError) { failures.push(`${destination}: ${rollbackError.message}`); }
    }
    if (failures.length) throw new Error(`Publication failed: ${error.message}\nRollback needs attention; backups remain at ${backup}:\n${failures.join("\n")}`);
    throw new Error(`Publication failed and previous files were restored: ${error.message}`);
  }
}

function continueSync() {
  const repo = join(STAGE, "worktree");
  const metadata = JSON.parse(readFileSync(join(STAGE, "metadata.json"), "utf8"));
  const review = JSON.parse(readFileSync(join(STAGE, "review.json"), "utf8"));
  checkTree(ROOT);
  if (hashFile(join(ROOT, "upstream.json")) !== metadata.provenanceHash) {
    throw new Error("upstream.json changed since staging; start a new sync instead of overwriting it.");
  }
  if (gitText(repo, "rev-parse", `${metadata.upstream}^{tree}`) !== metadata.incoming.pstackTreeSha) {
    throw new Error("The staged upstream tree no longer matches its recorded provenance.");
  }
  const expectedChanges = changes(repo, metadata.base, metadata.upstream);
  const identity = ({ status, oldPath, path }) => ({ status, oldPath, path });
  if (!Array.isArray(review.changes) ||
      JSON.stringify(review.changes.map(identity)) !== JSON.stringify(expectedChanges.map(identity))) {
    throw new Error("The review report no longer lists every upstream change. Restore its change inventory before continuing.");
  }
  const unclassified = review.changes.filter((change) => !["shipped", "source-only"].includes(change.classification));
  if (unclassified.length) throw new Error(`Classify upstream additions in ${join(STAGE, "review.json")}:\n${unclassified.map(({ path }) => path).join("\n")}`);
  const inconsistent = review.changes.filter(({ path, classification }) =>
    (OUTPUTS.includes(path.split("/")[0]) ? "shipped" : "source-only") !== classification);
  if (inconsistent.length) throw new Error(`Review classifications must match the published paths:\n${inconsistent.map(({ path }) => path).join("\n")}`);
  const removed = shippedSkills(ROOT).filter((skill) => !shippedSkills(repo).includes(skill));
  const unapproved = removed.filter((skill) => !review.approvedSkillRemovals.includes(skill));
  if (unapproved.length) throw new Error(`Refusing to remove shipped skills without approval: ${unapproved.join(", ")}. Restore them in ${repo} or record approved removals in ${join(STAGE, "review.json")}.`);
  const candidate = join(STAGE, "candidate");
  mkdirSync(candidate, { recursive: true });
  checkoutTree(repo, metadata.incoming.pstackTreeSha, join(candidate, VENDOR), join(STAGE, "candidate.index"));
  // Link rewriting needs the full upstream tree to resolve links into omitted
  // paths, so it runs on the staged worktree before OUTPUTS are copied out.
  rewriteLinks(repo, metadata.incoming.pstackCommitSha);
  for (const path of OUTPUTS) cpSync(join(repo, path), join(candidate, path), { recursive: true, verbatimSymlinks: true });
  writeFileSync(join(candidate, "upstream.json"), `${JSON.stringify(metadata.incoming, null, 2)}\n`);
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  pkg.version = metadata.incoming.version;
  writeFileSync(join(candidate, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  checkTree(candidate);
  publish(candidate, [...OUTPUTS, VENDOR, "package.json", "upstream.json"]);
  rmSync(STAGE, { recursive: true, force: true });
  console.log(`Published the reviewed pstack candidate at ${metadata.incoming.pstackCommitSha} (tree ${metadata.incoming.pstackTreeSha}, v${metadata.incoming.version}).`);
}

const args = process.argv.slice(2);
const explicitSource = args.find((arg) => !arg.startsWith("--"));
let clone;
try {
  if (args.includes("--continue")) continueSync();
  else if (args.includes("--check")) {
    const { provenance, skills } = checkTree(ROOT, explicitSource ? resolvePath(explicitSource) : undefined);
    console.log(`pi-better-pstack offline check passed (${skills} skills; upstream ${provenance.pstackCommitSha.slice(0, 7)}).`);
  } else {
    let source = explicitSource ? resolvePath(explicitSource) : undefined;
    if (!source && args.includes("--fetch")) {
      clone = mkdtempSync(join(tmpdir(), "pi-better-pstack-upstream-"));
      git(clone, ["clone", "--filter=blob:none", "--no-checkout", `${REPOSITORY}.git`, "."]);
      source = clone;
    }
    if (!source) throw new Error("Usage: node scripts/sync-pstack.mjs <cursor-plugins-dir> | --fetch | --continue | --check [cursor-plugins-dir]");
    stageSync(source);
  }
} catch (error) {
  console.error(`pi-better-pstack sync: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (clone) rmSync(clone, { recursive: true, force: true });
}
