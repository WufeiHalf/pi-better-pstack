import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { findPackageJSON } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requiredSkills } from "./required-skills.mjs";

function resolveHostIndex() {
  if (process.env.PI_HOST_INDEX) return pathToFileURL(process.env.PI_HOST_INDEX).href;
  try {
    return import.meta.resolve("@earendil-works/pi-coding-agent");
  } catch {
    const candidates = [
      process.env.PI_PACKAGE_DIR && join(process.env.PI_PACKAGE_DIR, "dist/index.js"),
      join(homedir(), ".local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
    ].filter(Boolean);
    try {
      const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
      candidates.push(join(globalRoot, "@earendil-works/pi-coding-agent/dist/index.js"));
    } catch {
      // The explicitly selected host does not require a global npm installation.
    }
    for (const candidate of candidates) {
      if (existsSync(candidate)) return pathToFileURL(candidate).href;
    }
    throw new Error("Could not resolve @earendil-works/pi-coding-agent for discovery test.");
  }
}

const hostIndex = resolveHostIndex();
const { CustomMessageComponent, DefaultResourceLoader, SettingsManager, initTheme } = await import(hostIndex);
const root = fileURLToPath(new URL("..", import.meta.url));
const upstream = JSON.parse(readFileSync(join(root, "upstream.json"), "utf8"));
const delegationSkills = [
  "architect", "arena", "how", "interrogate", "maintain-verification-skill",
  "no-comments", "reflect", "show-me-your-work", "swarm",
];

async function withRpc(cli, args, options, run) {
  const child = spawn(process.execPath, [cli, "--mode", "rpc", ...args], options);
  const closed = once(child, "close");
  const events = [];
  const waiting = new Map();
  const watchers = new Set();
  let buffer = "";
  let stderr = "";
  let sequence = 0;
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      events.push(event);
      for (const watch of watchers) watch(event);
      const resolve = waiting.get(event.id);
      if (resolve) {
        waiting.delete(event.id);
        resolve(event);
      }
    }
  });
  child.once("close", () => {
    for (const resolve of waiting.values()) resolve({ success: false, error: `RPC exited: ${stderr}` });
    waiting.clear();
    for (const watch of watchers) watch();
  });
  const request = (command) => new Promise((resolve) => {
    const id = `request-${++sequence}`;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
  });
  // Resolves with the first matching event, including one already received, or undefined if Pi exits first.
  const waitForEvent = (matches) => new Promise((resolve) => {
    const seen = events.find(matches);
    if (seen) return resolve(seen);
    const watch = (event) => {
      if (event && !matches(event)) return;
      watchers.delete(watch);
      resolve(event);
    };
    watchers.add(watch);
  });
  try {
    await run(request, events, waitForEvent, (response) => {
      child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", ...response })}\n`);
    });
  } finally {
    child.stdin.end();
    const [code, signal] = await closed;
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, stderr);
  }
}

function assertNoRunnableModel(response) {
  assert.equal(response.success, true, JSON.stringify(response));
  const model = response.data.model;
  assert.ok(!model || (model.provider === "unknown" && model.api === "unknown"),
    "The isolated fixture must have no runnable model before prompts are submitted");
}

function assertModelValidation(response) {
  assert.equal(response.success, false, JSON.stringify(response));
  assert.match(response.error, /No model|No API key|Authentication/i);
  assert.doesNotMatch(response.error, /pi-pstack:/);
}

async function readToolState(request, events) {
  const result = await request({ type: "prompt", message: "/pstack-test-tools" });
  assert.equal(result.success, true, JSON.stringify(result));
  const notification = events.findLast((event) => event.message?.startsWith("pstack-test-tools:"));
  assert.ok(notification, "Missing tool-state probe");
  return JSON.parse(notification.message.slice("pstack-test-tools:".length));
}

test("packed pstack loads and routes workflows with or without delegation", async (t) => {
  const packageDir = fileURLToPath(new URL("..", hostIndex));
  const temp = mkdtempSync(join(tmpdir(), "pi-pstack-discovery-"));
  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const cwd = join(temp, "project");
  const agentDir = join(temp, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  try {
    const [packed] = Object.values(JSON.parse(execFileSync(
      "npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temp],
      { cwd: root, encoding: "utf8" },
    )));
    execFileSync("tar", ["-xzf", join(temp, packed.filename), "-C", temp]);
    const packedRoot = join(temp, "package");
    process.env.HOME = temp;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const settingsManager = SettingsManager.inMemory({ packages: [packedRoot] });
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true });
    await loader.reload();
    const { skills, diagnostics } = loader.getSkills();
    assert.deepEqual(diagnostics, []);
    const expected = readdirSync(join(root, "skills")).sort();
    for (const name of requiredSkills) {
      assert.ok(expected.includes(name), `Missing shipped skill: ${name}`);
    }
    assert.deepEqual(skills.map(({ name }) => name).sort(), expected);
    for (const skill of skills) {
      const source = readFileSync(join(packedRoot, "skills", skill.name, "SKILL.md"), "utf8");
      assert.equal(/^disable-model-invocation: true\s*$/m.test(source),
        Boolean(skill.disableModelInvocation), `Frontmatter parity for ${skill.name}`);
    }
    assert.equal(loader.getExtensions().extensions.length, 1);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [packedRoot] }));
    const env = {
      HOME: temp,
      PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_PACKAGE_DIR: packageDir,
    };
    const cli = join(packageDir, "dist/bundle/cli.js");
    const args = ["--offline", "--no-session", "--no-approve", "-np", "-nc", "--no-themes"];
    const options = { cwd, env, stdio: ["pipe", "pipe", "pipe"] };
    await t.test("native package filters exclude only the selected skill", async () => {
      const filtered = join(temp, "filtered-agent");
      mkdirSync(filtered);
      writeFileSync(join(filtered, "settings.json"), JSON.stringify({
        packages: [{ source: packedRoot, skills: ["!skills/how/SKILL.md"] }],
      }));
      await withRpc(cli, args, { ...options, env: { ...env, PI_CODING_AGENT_DIR: filtered } }, async (request) => {
        const commands = await request({ type: "get_commands" });
        assert.equal(commands.success, true);
        const names = commands.data.commands.map(({ name }) => name);
        assert.ok(!names.includes("skill:how"));
        assert.ok(names.includes("skill:why"));
        assert.ok(names.includes("pstack-mode"));
      });
    });
    const probe = join(temp, "tool-state.mjs");
    writeFileSync(probe, `export default function(pi) {
      pi.registerCommand("pstack-test-tools", { handler: async (_args, ctx) => {
        ctx.ui.notify("pstack-test-tools:" + JSON.stringify({ active: pi.getActiveTools(),
          tools: pi.getAllTools().map(({ name, exposure, sourceInfo }) => ({ name, exposure, path: sourceInfo.path })) }), "info");
      } });
    }`);
    await t.test("status handles an unavailable upstream and caches success under a tilde agent directory", async () => {
      const fetchProbe = join(temp, "pstack-fetch-probe.mjs");
      writeFileSync(fetchProbe, `
        let available = false;
        globalThis.fetch = async () => {
          if (!available) throw new TypeError("fetch failed");
          return { ok: true, json: async () => [{ sha: "test-upstream", commit: { message: "test update" } }] };
        };
        export default function(pi) {
          pi.registerCommand("pstack-test-fetch", { handler: async () => { available = true; } });
        }
      `);
      const statusEnv = { ...env, PI_CODING_AGENT_DIR: "~/agent" };
      delete statusEnv.PI_OFFLINE;
      const statusArgs = [...args.filter((arg) => arg !== "--offline"), "-e", fetchProbe];
      await withRpc(cli, statusArgs, { ...options, env: statusEnv }, async (request, events) => {
        async function command(message) {
          const before = events.length;
          const result = await request({ type: "prompt", message });
          assert.equal(result.success, true, JSON.stringify(result));
          return events.slice(before).findLast((event) => event.type === "extension_ui_request" && event.method === "notify")?.message;
        }
        assert.match(await command("/pstack-status"), /Could not reach GitHub API/);
        await command("/pstack-test-fetch");
        const status = await command("/pstack-status");
        assert.match(status, /need a reviewed sync before they are installable/);
        assert.doesNotMatch(status, /Run 'pi update/);
        const cache = JSON.parse(readFileSync(join(agentDir, "cache/pi-better-pstack-upstream.json"), "utf8"));
        assert.equal(cache.latestSha, "test-upstream");
      });
    });
    await t.test("mode reports unavailable skills and a later forced system prompt", async () => {
      await withRpc(cli, [...args, "--no-skills"], options, async (request, events) => {
        const result = await request({ type: "prompt", message: "/pstack-mode on" });
        assert.equal(result.success, true, JSON.stringify(result));
        assert.ok(events.some((event) => event.method === "notify" && event.message?.includes("skill is excluded or unavailable")));
      });
      const forceProbe = join(temp, "pstack-force-probe.mjs");
      writeFileSync(forceProbe, `
        import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
        export default function(pi) {
          const main = fauxProvider({ provider: "pstack-force-main", models: [{ id: "native" }] });
          main.setResponses([fauxAssistantMessage("Done.")]);
          pi.registerProvider(main.provider);
          pi.on("before_agent_start", (event) => { event.systemPromptOptions.forceSystemPrompt = "A forced system prompt."; });
        }
      `);
      await withRpc(cli, [...args, "-e", join(packedRoot, "extensions/index.js"), "-e", forceProbe,
        "--provider", "pstack-force-main", "--model", "native"],
        options, async (request, events, waitForEvent) => {
          assert.equal((await request({ type: "prompt", message: "/pstack-mode on" })).success, true);
          const before = events.length;
          assert.equal((await request({ type: "prompt", message: "Run with the forced prompt." })).success, true);
          assert.ok(await waitForEvent((event) => event.type === "agent_settled" && events.indexOf(event) >= before));
          assert.ok(events.slice(before).some((event) => event.method === "notify" &&
            event.message?.includes("forces the system prompt")), JSON.stringify(events.slice(before)));
        });
    });
    await t.test("mode picker and status follow the active branch and each user prompt gets a sticky reminder", async () => {
      const runtimeProbe = join(temp, "pstack-runtime-probe.mjs");
      writeFileSync(runtimeProbe, `
        import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
        export default function(pi) {
          const main = fauxProvider({ provider: "pstack-runtime-main", models: [{ id: "native" }] });
          main.setResponses([
            fauxAssistantMessage("Mode enabled."),
            fauxAssistantMessage("Mode checked.")
          ]);
          pi.registerProvider(main.provider);
          pi.registerCommand("pstack-test-navigate", { handler: async (id, ctx) => {
            await ctx.navigateTree(id.trim(), { summarize: false });
          } });
        }
      `);
      const runtimeArgs = [...args.filter((arg) => arg !== "--no-session"), "-e", runtimeProbe, "-e", probe,
        "--provider", "pstack-runtime-main", "--model", "native"];
      await withRpc(cli, runtimeArgs, options, async (request, events, waitForEvent, respond) => {
        async function command(message) {
          const before = events.length;
          const result = await request({ type: "prompt", message });
          assert.equal(result.success, true, JSON.stringify(result));
          assert.equal(result.data.disposition, "handled");
          return events.slice(before).findLast((event) => event.type === "extension_ui_request" && event.method === "notify")?.message;
        }
        async function run(message) {
          const before = events.length;
          const result = await request({ type: "prompt", message });
          assert.equal(result.success, true, JSON.stringify(result));
          assert.equal(result.data.disposition, "started");
          assert.ok(await waitForEvent((event) => event.type === "agent_settled" && events.indexOf(event) >= before));
        }
        assert.match(await command("/pstack-mode status"), /mode is off/);
        const pick = async (value) => {
          const before = events.length;
          const pending = request({ type: "prompt", message: "/pstack-mode" });
          const dialog = await Promise.race([
            pending,
            waitForEvent((event) => event.method === "select" && events.indexOf(event) >= before),
          ]);
          assert.equal(dialog?.method, "select", JSON.stringify(dialog));
          assert.deepEqual(dialog.options, ["on", "status"]);
          respond({ id: dialog.id, ...(value ? { value } : { cancelled: true }) });
          assert.equal((await pending).success, true);
        };
        await pick();
        assert.match(await command("/pstack-mode status"), /mode is off/);
        await pick("on");
        assert.equal(events.findLast((event) => event.method === "setStatus" && event.statusKey === "pstack-mode")?.statusText, "pstack: on");
        const entries = await request({ type: "get_entries" });
        const enabledEntry = entries.data.entries.findLast((entry) => entry.type === "custom" && entry.customType === "pstack-mode" && entry.data.enabled);
        assert.ok(enabledEntry);

        await run("Check the enabled mode.");
        const messages = await request({ type: "get_messages" });
        assert.ok(messages.data.messages.some((message) => message.role === "system" &&
          message.sections?.pstack_mode?.includes("Persistent pstack mode is on.")), JSON.stringify(messages));
        const afterRun = await request({ type: "get_entries" });
        const sticky = afterRun.data.entries.findLast((entry) => entry.customType === "pstack-sticky");
        assert.ok(sticky, "Every user prompt while the mode is on must add a sticky reminder entry");
        assert.match(JSON.stringify(sticky.data ?? sticky.message ?? sticky), /pstack-mode reminder/);

        assert.match(await command("/pstack-mode off"), /mode is off/);
        assert.equal(events.findLast((event) => event.method === "setStatus" && event.statusKey === "pstack-mode")?.statusText, undefined);
        await command(`/pstack-test-navigate ${enabledEntry.id}`);
        assert.match(await command("/pstack-mode status"), /mode is on/);
        await run("Continue on the restored branch.");
        const state = await request({ type: "get_state" });
        assert.ok(state.data.sessionFile);
        assert.equal((await request({ type: "new_session" })).success, true);
        assert.match(await command("/pstack-mode status"), /mode is off/);
        assert.equal((await request({ type: "switch_session", sessionPath: state.data.sessionFile })).success, true);
        assert.match(await command("/pstack-mode status"), /mode is on/);
      });
    });
    await t.test("each user-facing skill reaches Pi directly and through a nested read without delegation", async () => {
      const workflowSkills = expected.filter((name) => !name.startsWith("principle-"));
      const inlineProbe = join(temp, "inline-probe.mjs");
      writeFileSync(inlineProbe, `
        import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
        export default function(pi) {
          const model = fauxProvider({ provider: "pstack-inline-probe", models: [{ id: "native" }] });
          model.setResponses(${JSON.stringify(workflowSkills)}.flatMap((name) => [
            fauxAssistantMessage(fauxToolCall("read", { path: ${JSON.stringify(packedRoot)} + "/skills/" + name + "/SKILL.md" },
              { id: "nested-" + name }), { stopReason: "toolUse" }),
            fauxAssistantMessage("Inline route available.")
          ]));
          pi.registerProvider(model.provider);
        }
      `);
      await withRpc(cli, [...args, "-e", inlineProbe, "--provider", "pstack-inline-probe", "--model", "native"],
        options, async (request, events, waitForEvent) => {
          for (const name of workflowSkills) {
            const before = events.length;
            const started = await request({ type: "prompt", message: `/skill:${name} inspect` });
            assert.equal(started.success, true, JSON.stringify(started));
            assert.equal(started.data.disposition, "started");
            assert.ok(await waitForEvent((event) => event.type === "agent_settled" && events.indexOf(event) >= before));
            const current = events.slice(before);
            const user = current.find((event) => event.type === "message_end" && event.message.role === "user")?.message;
            const userText = typeof user?.content === "string" ? user.content :
              user?.content?.map((part) => part.text ?? "").join("") ?? "";
            assert.ok(userText.includes(`<skill name="${name}"`), name);
            const read = current.find((event) => event.type === "tool_execution_end" && event.toolCallId === `nested-${name}`);
            assert.ok(read && !read.isError, JSON.stringify(read));
            const content = read.result.content.map((part) => part.text ?? "").join("\n");
            assert.match(content, new RegExp("name: " + name));
          }
        });
    });
    await t.test("poteto-mode routes playbooks and reads every packed playbook", async () => {
      const modeRoot = join(packedRoot, "skills/poteto-mode");
      const mode = readFileSync(join(modeRoot, "SKILL.md"), "utf8");
      assert.match(mode, /playbooks\//, "poteto-mode must route to its playbooks");
      const shipped = readdirSync(join(modeRoot, "playbooks"))
        .filter((name) => name.endsWith(".md")).map((name) => `playbooks/${name}`).sort();
      assert.ok(shipped.length > 15, `expected the full playbook set, got ${shipped.length}`);
      const named = shipped;
      const probe = join(temp, "playbook-probe.mjs");
      writeFileSync(probe, `
        import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
        export default function(pi) {
          const model = fauxProvider({ provider: "pstack-playbook-probe", models: [{ id: "native" }] });
          model.setResponses([
            fauxAssistantMessage(${JSON.stringify(named)}.map((name, i) =>
              fauxToolCall("read", { path: ${JSON.stringify(modeRoot)} + "/" + name }, { id: "playbook-" + i })),
              { stopReason: "toolUse" }),
            fauxAssistantMessage("Playbooks read.")
          ]);
          pi.registerProvider(model.provider);
        }
      `);
      await withRpc(cli, [...args, "-e", probe, "--provider", "pstack-playbook-probe", "--model", "native"],
        options, async (request, events, waitForEvent) => {
          const started = await request({ type: "prompt", message: "/skill:poteto-mode inspect playbooks" });
          assert.equal(started.data.disposition, "started");
          assert.ok(await waitForEvent((event) => event.type === "agent_settled"));
          for (const [index, name] of named.entries()) {
            const result = events.find((event) => event.type === "tool_execution_end" && event.toolCallId === `playbook-${index}`);
            assert.ok(result && !result.isError, name);
            assert.match(result.result.content.map((part) => part.text ?? "").join("\n"), /^#{1,3} /m, name);
          }
        });
    });
    // Issue #7: exercise the real native command expander, not source-text equality
    // or a paid model. Public followUp queues expanded input without inference.
    await t.test("native SDK expands synced formal skills and sharpen without inference", () => {
      execFileSync(process.execPath, ["--input-type=module", "-e", `
        import assert from "node:assert/strict";
        const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(${JSON.stringify(hostIndex)});
        const settingsManager = SettingsManager.inMemory({ packages: [${JSON.stringify(packedRoot)}] });
        const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
          settingsManager, noContextFiles: true });
        await loader.reload();
        const { session } = await createAgentSession({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
          settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory() });
        try {
          const cases = [
            ["create-formal-verification-skill", "TLA+ is the default"],
            ["maintain-formal-verification-skill", "Do not move the sync commit for a blocked check"],
            ["sharpen", "Then rewrite my prompt", "prototype any choice an experiment can settle"],
          ];
          for (const [name, ...markers] of cases) {
            assert.equal(await session.followUp("/skill:" + name + " issue7-input"), "queued");
            const [expanded] = session.getFollowUpMessages();
            assert.ok(expanded.startsWith('<skill name="' + name + '" location="'));
            assert.ok(expanded.includes(${JSON.stringify(packedRoot)} + "/skills/" + name + "/SKILL.md"));
            for (const marker of markers) assert.ok(expanded.includes(marker), name + ": " + marker);
            assert.ok(expanded.endsWith("</skill>\\n\\nissue7-input"));
            session.clearQueue();
          }
          assert.deepEqual(session.messages, []);
        } finally { session.dispose(); }
      `], { cwd, env, encoding: "utf8", timeout: 30000 });
    });
    await withRpc(cli, args, options, async (request, events) => {
      const commands = await request({ type: "get_commands" });
      assert.equal(commands.success, true, JSON.stringify(commands));
      assert.deepEqual(commands.data.commands.filter(({ source }) => source === "skill").map(({ name }) => name).sort(), expected.map((name) => `skill:${name}`).sort());
      assert.ok(commands.data.commands.some(({ name }) => name === "pstack-status"));
      assert.equal((await request({ type: "prompt", message: "/pstack-status" })).success, true);
      assert.ok(events.some((event) => event.method === "notify" &&
        event.message?.includes(`v${upstream.version}`) && event.message.includes(upstream.pstackCommitSha.slice(0, 7)) &&
        event.message.includes("Offline mode active")));
      const state = await request({ type: "get_state" });
      assertNoRunnableModel(state);
      for (const name of delegationSkills) {
        assertModelValidation(await request({ type: "prompt", message: `/skill:${name} audit` }));
      }
      for (const name of ["unslop", "tdd", "poteto-mode", "create-formal-verification-skill", "maintain-formal-verification-skill", "sharpen"]) {
        assertModelValidation(await request({ type: "prompt", message: `/skill:${name} text` }));
      }
      assert.ok(!events.some(({ type }) => type === "agent_start" || type === "tool_execution_start"));
    });


    await t.test("a different package's namesake remains runnable", async () => {
      const otherSkill = join(temp, "other-swarm", "SKILL.md");
      mkdirSync(dirname(otherSkill));
      writeFileSync(otherSkill, "---\nname: swarm\ndescription: An unrelated inline skill\n---\nWrite one sentence.\n");
      await withRpc(cli, [...args, "--no-skills", "--skill", otherSkill], options, async (request) => {
        const commands = await request({ type: "get_commands" });
        const selected = commands.data.commands.find(({ name }) => name === "skill:swarm");
        assert.equal(realpathSync(selected.sourceInfo.path), realpathSync(otherSkill));
        assertModelValidation(await request({ type: "prompt", message: "/skill:swarm text" }));
      });
    });

    await t.test("print mode keeps inline skill work in the foreground", () => {
      const printProbe = join(temp, "print-probe.mjs");
      writeFileSync(printProbe, `
        import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
        export default function(pi) {
          const model = fauxProvider({ provider: "pstack-print-probe", models: [{ id: "native" }] });
          model.setResponses([fauxAssistantMessage("PSTACK_PRINT_INLINE")]);
          pi.registerProvider(model.provider);
        }
      `);
      const result = spawnSync(process.execPath, [cli, ...args, "-e", printProbe,
        "--provider", "pstack-print-probe", "--model", "native", "-p", "/skill:swarm audit"],
      { cwd, env, encoding: "utf8", timeout: 30000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /PSTACK_PRINT_INLINE/);
    });
    t.diagnostic(`Selected native host: ${packageDir}`);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(temp, { recursive: true, force: true });
  }
});
