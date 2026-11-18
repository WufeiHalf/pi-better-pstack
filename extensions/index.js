import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { replaceControlCharacters, stripTerminalSequences } from "@earendil-works/pi-tui";

const PACKAGE_ROOT = join(import.meta.dirname, "..");
const UPSTREAM_FILE = join(PACKAGE_ROOT, "upstream.json");
const SKILL_FILE = join(PACKAGE_ROOT, "skills", "poteto-mode", "SKILL.md");
const CONTRACT_FILE = join(PACKAGE_ROOT, "docs", "harness", "pi.md");
const SHEET_FILE = () => join(getAgentDir(), "pstack-models.md");
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const API_URL = "https://api.github.com/repos/cursor/plugins/commits?path=pstack&per_page=1";
const PRESET_PROVIDER = "pstack";
const PRESET_LEVELS = ["low", "medium", "high", "xhigh", "max"];

function safeLine(value) {
  return replaceControlCharacters(stripTerminalSequences(String(value ?? "")));
}

function notifyUI(ctx, message, level) {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function ownsSkill(command, name) {
  try {
    return (
      command?.source === "skill" &&
      realpathSync(command.sourceInfo.path) ===
        realpathSync(join(PACKAGE_ROOT, "skills", name, "SKILL.md"))
    );
  } catch {
    return false;
  }
}

/**
 * The alias sheet at <agentDir>/pstack-models.md, one preset per line:
 * `fable: provider/modelId @level`. Lines that do not parse are ignored.
 */
function readModelSheet() {
  const file = SHEET_FILE();
  if (!existsSync(file)) return [];
  const presets = [];
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-z][a-z0-9-]*):\s*(\S+)(?:\s*@([a-z]+))?\s*$/i.exec(line);
    if (!match) continue;
    const slash = match[2].indexOf("/");
    if (slash <= 0) continue;
    presets.push({
      alias: match[1],
      provider: match[2].slice(0, slash),
      modelId: match[2].slice(slash + 1),
      level: match[3] ?? "high",
    });
  }
  return presets;
}

function registerPresets(pi, presets) {
  for (const preset of presets) {
    const { alias, provider, modelId, level } = preset;
    pi.registerVirtualModel({
      provider: PRESET_PROVIDER,
      id: alias,
      name: alias,
      thinkingLevels: PRESET_LEVELS,
      route(request, ctx) {
        const model = ctx.modelRegistry.find(provider, modelId);
        if (!model) throw new Error(`pstack preset ${alias} routes to ${provider}/${modelId}, which is not configured.`);
        return { model, thinkingLevel: request.thinkingLevel ?? level };
      },
    });
  }
}

function getCachePath() {
  return join(getAgentDir(), "cache", "pi-better-pstack-upstream.json");
}

function readJsonSafe(filePath) {
  try {
    if (!existsSync(filePath)) return undefined;
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}


function writeJsonSafe(filePath, data) {
  try {
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  } catch {
    // Cache writes are best-effort.
  }
}

async function fetchLatestUpstreamCommit(signal) {
  try {
    const response = await fetch(API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "pi-better-pstack-update-checker",
      },
      signal,
    });
    if (!response.ok) return undefined;
    const commits = await response.json();
    if (!Array.isArray(commits) || commits.length === 0) return undefined;
    const latest = commits[0];
    const sha = typeof latest?.sha === "string" ? latest.sha : undefined;
    if (!sha) return undefined;
    const subject =
      typeof latest?.commit?.message === "string"
        ? safeLine(latest.commit.message.split(/\r?\n/, 1)[0])
        : "upstream update";
    const date = latest?.commit?.committer?.date ?? latest?.commit?.author?.date ?? undefined;
    return { sha, subject, date };
  } catch {
    return undefined;
  }
}

const stickyMessage = (contractAliases) => [
  "pstack-mode reminder for this run:",
  "1. The matched playbook's steps are visible as your checklist, verbatim, each done or with `skip: <reason>`.",
  "2. Code-writing steps go through the Agent tool (`subagent_type: \"poteto-agent\"`, background, explicit model" +
    (contractAliases ? " alias" : "") + ").",
  "3. You verified the result on the real artifact before reporting done.",
  contractAliases
    ? `Configured model presets: ${contractAliases}.`
    : "No model presets are configured; omit model so children inherit the parent model.",
  "The full skill text and the Pi execution contract are in your system prompt.",
].join("\n");

export default function piPstackExtension(pi) {
  let activeController;
  let modeEnabled = false;
  let modeRequested = false;
  let runOptions;
  let turnCount = 0;

  registerPresets(pi, readModelSheet());

  const modeAvailable = () => ownsSkill(
    pi.getCommands().find((entry) => entry.name === "skill:poteto-mode"),
    "poteto-mode",
  );
  const updateModeStatus = (ctx) => {
    if (!ctx.hasUI) return;
    const status = !modeEnabled ? undefined : !modeAvailable() ? "pstack: unavailable" :
      runOptions?.forceSystemPrompt !== undefined ? "pstack: prompt overridden" : "pstack: on";
    ctx.ui.setStatus("pstack-mode", status);
  };
  const restoreMode = (ctx) => {
    modeEnabled = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "pstack-mode" &&
          typeof entry.data?.enabled === "boolean") {
        modeEnabled = entry.data.enabled;
      }
    }
    updateModeStatus(ctx);
  };

  pi.on("session_start", (event, ctx) => {
    restoreMode(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    restoreMode(ctx);
  });

  pi.registerCommand("pstack-mode", {
    description: "Manage persistent poteto mode for this session branch",
    getArgumentCompletions: (prefix) => {
      const items = ["on", "off", "status"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      let action = args.trim();
      if (!action && ctx.hasUI) {
        action = await ctx.ui.select(`Pstack mode is ${modeEnabled ? "on" : "off"}`, [
          modeEnabled ? "off" : "on", "status",
        ]);
        if (!action) return;
      }
      if (action === "status") {
        const availability = modeEnabled && !modeAvailable() ? " (poteto-mode is excluded or unavailable)" :
          modeEnabled && runOptions?.forceSystemPrompt !== undefined ? " (system prompt is overridden)" : "";
        updateModeStatus(ctx);
        const presets = readModelSheet();
        const presetLine = presets.length
          ? `Model presets: ${presets.map((p) => `${p.alias} -> ${p.provider}/${p.modelId} @${p.level}`).join(", ")}.`
          : "No model presets configured; delegated children inherit the parent model.";
        notifyUI(ctx, `pstack mode is ${modeEnabled ? "on" : "off"}${availability}. ${presetLine}`, "info");
        return;
      }
      if (action !== "on" && action !== "off") {
        notifyUI(ctx, "Usage: /pstack-mode on|off|status", "warning");
        return;
      }
      if (action === "on" && !modeAvailable()) {
        notifyUI(ctx, "pstack mode cannot start: this package's poteto-mode skill is excluded or unavailable.", "warning");
        return;
      }
      modeEnabled = action === "on";
      pi.appendEntry("pstack-mode", { enabled: modeEnabled });
      updateModeStatus(ctx);
      notifyUI(ctx, `pstack mode is ${modeEnabled ? "on" : "off"}.`, "info");
    },
  });

  pi.on("before_agent_start", (event) => {
    runOptions = event.systemPromptOptions;
    turnCount = 0;
    modeRequested = modeEnabled && modeAvailable();
    if (!modeRequested) {
      delete event.systemPromptOptions.sections.pstack_mode;
      return;
    }
    if (event.systemPromptOptions.forceSystemPrompt !== undefined) return;
    const contract = readFileSync(CONTRACT_FILE, "utf8");
    const skill = readFileSync(SKILL_FILE, "utf8");
    const presets = readModelSheet();
    const aliases = presets.map((preset) => preset.alias);
    event.systemPromptOptions.sections.pstack_mode = [
      "Persistent pstack mode is on. The poteto-mode skill and the Pi execution contract below govern this session's code work.",
      `This pstack package is installed at ${PACKAGE_ROOT}.`,
      "# Pi execution contract",
      contract.trim(),
      "# Configured model presets",
      aliases.length
        ? `${aliases.join(", ")} (as configured in ${SHEET_FILE()}; pass the bare alias in the Agent call's model field).`
        : "None. Omit model on Agent calls so children inherit the parent model.",
      "# poteto-mode skill",
      skill,
    ].join("\n\n");
    if (event.messageType === "user") {
      return {
        message: {
          customType: "pstack-sticky",
          content: stickyMessage(aliases.length ? aliases.join(", ") : ""),
          display: true,
        },
      };
    }
  });
  pi.on("turn_start", (_event, ctx) => {
    turnCount += 1;
    if (turnCount === 1) updateModeStatus(ctx);
    if (turnCount === 1 && modeRequested && runOptions.forceSystemPrompt !== undefined) {
      notifyUI(ctx, "pstack mode is on, but another extension forces the system prompt; its mode section cannot be applied.", "warning");
    }
  });

  pi.on("session_shutdown", () => {
    activeController?.abort();
    activeController = undefined;
  });

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup" || ctx.mode !== "tui" || process.env.PI_OFFLINE === "1") {
      return;
    }
    const upstream = readJsonSafe(UPSTREAM_FILE);
    if (!upstream?.pstackCommitSha) return;

    const cachePath = getCachePath();
    const cached = readJsonSafe(cachePath);
    const now = Date.now();
    if (
      cached &&
      typeof cached.checkedAtMs === "number" &&
      now - cached.checkedAtMs < CHECK_TTL_MS
    ) {
      if (
        cached.latestSha &&
        cached.latestSha !== upstream.pstackCommitSha &&
        cached.notifiedForInstalledSha !== upstream.pstackCommitSha
      ) {
        writeJsonSafe(cachePath, {
          ...cached,
          notifiedForInstalledSha: upstream.pstackCommitSha,
        });
        notifyUI(
          ctx,
          `pstack upstream has new commits in cursor/plugins (${safeLine(cached.latestSha.slice(0, 7))}: ${safeLine(cached.latestSubject ?? "updated")}). These changes may not be packaged here yet. Use /pstack-status for details.`,
          "info",
        );
      }
      return;
    }

    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]);

    void fetchLatestUpstreamCommit(signal)
      .then((latest) => {
        if (!latest || signal.aborted) return;
        const isOutdated = latest.sha !== upstream.pstackCommitSha;
        const alreadyNotified =
          cached?.notifiedSha === latest.sha &&
          cached?.notifiedForInstalledSha === upstream.pstackCommitSha;
        writeJsonSafe(cachePath, {
          checkedAtMs: Date.now(),
          latestSha: latest.sha,
          latestSubject: latest.subject,
          latestDate: latest.date,
          notifiedSha: isOutdated ? latest.sha : cached?.notifiedSha,
          notifiedForInstalledSha: isOutdated
            ? upstream.pstackCommitSha
            : cached?.notifiedForInstalledSha,
        });
        if (isOutdated && !alreadyNotified) {
          notifyUI(
            ctx,
            `pstack upstream has new commits in cursor/plugins (${latest.sha.slice(0, 7)}: ${latest.subject}). These changes may not be packaged here yet. Use /pstack-status for details.`,
            "info",
          );
        }
      })
      .catch(() => {
        // Network errors during background check are ignored.
      })
      .finally(() => {
        if (activeController === controller) {
          activeController = undefined;
        }
      });
  });

  pi.registerCommand("pstack-status", {
    description: "Check the installed pstack snapshot against upstream cursor/plugins/pstack",
    handler: async (_args, ctx) => {
      const upstream = readJsonSafe(UPSTREAM_FILE);
      if (!upstream) {
        notifyUI(ctx, "pi-better-pstack: upstream.json is missing.", "warning");
        return;
      }
      if (process.env.PI_OFFLINE === "1") {
        notifyUI(
          ctx,
          `pi-better-pstack v${upstream.version} (pstack commit ${upstream.pstackCommitSha?.slice(0, 7)}, tree ${upstream.pstackTreeSha?.slice(0, 7)}). Offline mode active.`,
          "info",
        );
        return;
      }
      const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000);
      const latest = await fetchLatestUpstreamCommit(signal);
      if (!latest) {
        notifyUI(
          ctx,
          `pi-better-pstack v${upstream.version} (installed pstack commit ${upstream.pstackCommitSha?.slice(0, 7)}). Could not reach GitHub API.`,
          "warning",
        );
        return;
      }
      writeJsonSafe(getCachePath(), {
        checkedAtMs: Date.now(),
        latestSha: latest.sha,
        latestSubject: latest.subject,
        latestDate: latest.date,
        notifiedSha: latest.sha,
        notifiedForInstalledSha: upstream.pstackCommitSha,
      });
      if (latest.sha === upstream.pstackCommitSha) {
        notifyUI(
          ctx,
          `pi-better-pstack is up to date with cursor/plugins/pstack (${latest.sha.slice(0, 7)}, v${upstream.version}).`,
          "info",
        );
      } else {
        notifyUI(
          ctx,
          `pi-better-pstack upstream update available: installed ${upstream.pstackCommitSha?.slice(0, 7)} -> latest ${latest.sha.slice(0, 7)} (${latest.subject}). These changes need a reviewed sync before they are installable.`,
          "info",
        );
      }
    },
  });
}
