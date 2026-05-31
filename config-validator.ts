/**
 * Config file write validator — IDE config poisoning defense.
 *
 * Detects security-sensitive mutations in known IDE/tool config file writes.
 * Blocks writes that would disable security controls, redirect tools to
 * attacker-controlled endpoints, or enable arbitrary code execution.
 *
 * Reference CVEs informing this validator:
 *   - CVE-2025-53773 (CVSS 9.6): chat.tools.autoApprove in .vscode/settings.json
 *   - CVE-2025-54130 (Cursor): equivalent autoApprove bypass
 *   - CVE-2025-53536 (Roo Code): equivalent autoApprove bypass
 *   - CVE-2025-55012 (Zed.dev): equivalent autoApprove bypass
 *   - AIShellJack: .cursorrules as prompt injection vector
 */

import path from "node:path";
import { resolveRealPath } from "./resolve-path.js";

// ── Types ────────────────────────────────────────────────────────────

export type ConfigValidationResult =
	| { allow: true }
	| { allow: false; reason: string };

/** Prefix for all block reasons emitted by validators. */
const BLOCK_PREFIX = "blocked: ";

/** Internal categorisation of config file types. */
type ConfigFileType =
	| "vscode-settings"
	| "cursorrules"
	| "copilot-instructions"
	| "mcp"
	| "vscode-workspace"
	| "idea-workspace";

// ── URL helpers ──────────────────────────────────────────────────

/**
 * True if the URL points to a local (loopback) address.
 *
 * Rejects subdomain-prefix bypass attempts like localhost.evil.com by
 * requiring an exact loopback hostname match. DNS rebinding variants such as
 * 127.0.0.1.nip.io remain undetected at this string level — resolving DNS
 * would introduce latency and SSRF risk. This stays a best-effort guardrail,
 * not a security boundary.
 */
function isLocalhost(url: string): boolean {
	// Unix socket paths (unix:// or /var/run/...) are always local
	if (url.startsWith("unix:") || url.startsWith("/")) return true;

	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.toLowerCase();
		// Exact loopback hostnames only — never allow hostname prefixes.
		const LOCALHOST_VALUES = [
			"localhost",
			"127.0.0.1",
			"::1",
			"::ffff:127.0.0.1",
			"::ffff:7f00:1",
			"[::ffff:127.0.0.1]",
			"[::ffff:7f00:1]",
			// 0.0.0.0 accepts all interfaces — semantically broad but commonly used for
		// local-only servers that bind to loopback via OS firewall rules.
		"0.0.0.0",
		];
		return LOCALHOST_VALUES.includes(hostname);
	} catch {
		// Not a valid URL — treat as non-local
		return false;
	}
}

// ── Path classification ─────────────────────────────────────────────

/**
 * Classify a file path into a protected config file type, or null if not protected.
 *
 * Uses path matching (not regex on content) so it runs before reading the file.
 * Matches: .cursorrules, .github/copilot-instructions.md, .vscode/settings.json,
 * .vscode/*.code-workspace, .mcp*.json (any prefix), .idea/workspace.xml.
 */
function classifyConfigPath(filePath: string): ConfigFileType | null {
	const resolvedPath = resolveRealPath(path.resolve(filePath));
	// Normalise both the requested path and its real target so symlinked aliases
	// to protected config files inherit the same validation.
	const candidates = [filePath, resolvedPath].map((candidate) =>
		path.normalize(candidate).replace(/\\/g, "/").toLowerCase(),
	);
	const basenameSet = new Set(candidates.map((candidate) => path.basename(candidate)));

	// .cursorrules — plaintext, entire file is the attack vector (AIShellJack)
	if (basenameSet.has(".cursorrules")) return "cursorrules";

	// .github/copilot-instructions.md — embedded instructions
	if (candidates.some((candidate) => candidate.includes(".github/copilot-instructions.md"))) return "copilot-instructions";

	// .vscode/settings.json — structured JSON settings
	if (candidates.some((candidate) => candidate.includes(".vscode/settings.json"))) return "vscode-settings";

	// .vscode/*.code-workspace — multi-root workspace
	if (candidates.some((candidate) => path.basename(candidate).endsWith(".code-workspace") && candidate.includes(".vscode/"))) return "vscode-workspace";

	// MCP config: .mcp.json, mcp.json, mcp.servers.json, etc.
	if ([...basenameSet].some((basename) => /^\.?mcp[\w.-]*\.json$/i.test(basename))) return "mcp";

	// .idea/workspace.xml — IntelliJ IDEA workspace
	if (candidates.some((candidate) => candidate.includes(".idea/workspace.xml"))) return "idea-workspace";

	return null;
}

// ── JSON helpers ─────────────────────────────────────────────────────

type ParseResult =
	| { ok: true; value: Record<string, unknown> }
	| { ok: false; reason: string };

/**
 * Safely parse JSON content.
 * Returns parsed object on success, or a fail-closed result on parse failure.
 */
function tryParseJSON(content: string): ParseResult {
	try {
		const parsed = JSON.parse(content);
		if (typeof parsed !== "object" || parsed === null) {
			// Non-object JSON (primitives) can't contain dangerous settings.
			// Map to empty object so validators produce a clean allow result.
			return { ok: true, value: {} };
		}
		return { ok: true, value: parsed as Record<string, unknown> };
	} catch {
		return { ok: false, reason: "blocked: invalid JSON in protected config file — cannot validate" };
	}
}

// ── Case-insensitive key lookup ────────────────────────────────────

/** Find a key in config matching `target` case-insensitively. */
function findKeyCI(config: Record<string, unknown>, target: string): string | null {
	const lower = target.toLowerCase();
	for (const key of Object.keys(config)) {
		if (key.toLowerCase() === lower) return key;
	}
	return null;
}

// ── Individual validators ────────────────────────────────────────────

/**
 * Validate .vscode/settings.json writes.
 *
 * Dangerous patterns:
 *   - chat.tools.autoApprove = true/"on" (CVE-2025-53773 et al.)
 *   - *validate.executablePath (custom validation executable)
 *   - git.path / terminal.integrated.shell.* (executable hijacking)
 *   - files.associations mapping script extensions to executable paths
 */
function validateVSCodeSettings(content: string): ConfigValidationResult {
	const parseResult = tryParseJSON(content);
	if (!parseResult.ok) return { allow: false, reason: parseResult.reason };
	const config = parseResult.value;

	// ── 1. chat.tools.autoApprove ──────────────────────────────────────
	// VS Code normalises keys case-insensitively, so "Chat.Tools.AutoApprove" bypasses
	// an exact-key check. Scan all keys case-insensitively instead.
	const autoApproveKey = findKeyCI(config, "chat.tools.autoApprove");
	if (autoApproveKey !== null) {
		const val = config[autoApproveKey];
		if (val === true || (typeof val === "string" && val.toLowerCase() === "on")) {
			return {
				allow: false,
				reason:
					'blocked: chat.tools.autoApprove enables automatic tool approval without human review (CVE-2025-53773)',
			};
		}
	}

	// ── 2. *validate.executablePath — custom validation executable ─────
	// VS Code normalises keys case-insensitively; use .toLowerCase() for consistency
	// with the terminal.integrated.shell.* check below.
	for (const key of Object.keys(config)) {
		if (
			key.toLowerCase().includes("validate.executablepath") &&
			config[key] !== null &&
			config[key] !== undefined
		) {
			return {
				allow: false,
				reason: `blocked: ${key} sets custom validation executable path (code execution vector)`,
			};
		}
	}

	// ── 3. git.path — git executable hijacking ─────────────────────────
	const gitPathKey = findKeyCI(config, "git.path");
	if (
		gitPathKey !== null &&
		typeof config[gitPathKey] === "string" &&
		(config[gitPathKey] as string).length > 0
	) {
		return {
			allow: false,
			reason: "blocked: git.path overrides git executable path (executable hijacking)",
		};
	}

	// ── 4. terminal.integrated.shell.* — shell executable hijacking ────
	for (const key of Object.keys(config)) {
		if (key.toLowerCase().startsWith("terminal.integrated.shell.")) {
			return {
				allow: false,
				reason: `blocked: ${key} sets custom shell path (executable hijacking)`,
			};
		}
	}

	// ── 5. files.associations — script extension → executable handler ──
	// VS Code normalises keys case-insensitively; use findKeyCI for consistency.
	const associationsKey = findKeyCI(config, "files.associations");
	const associations = associationsKey ? config[associationsKey] : undefined;
	if (typeof associations === "object" && associations !== null) {
		for (const [glob, handler] of Object.entries(
			associations as Record<string, string>,
		)) {
			// Check if the handler value contains a path separator → executable path
			if (typeof handler === "string" && (handler.includes("/") || handler.includes("\\"))) {
				return {
					allow: false,
					reason: `blocked: files.associations maps "${glob}" to executable path "${handler}" (code execution via association)`,
				};
			}
		}
	}

	return { allow: true };
}

/**
 * Validate .vscode/*.code-workspace writes.
 *
 * Dangerous patterns mirror .vscode/settings.json (the workspace's "settings"
 * block can override user/workspace security settings), plus auto-install
 * extension recommendations.
 */
function validateVSCodeWorkspace(content: string): ConfigValidationResult {
	const parseResult = tryParseJSON(content);
	if (!parseResult.ok) return { allow: false, reason: parseResult.reason };
	const config = parseResult.value;

	// ── 1. "settings" block — same validation as .vscode/settings.json ─
	const settings = config["settings"];
	if (typeof settings === "object" && settings !== null) {
		const settingsResult = validateVSCodeSettings(JSON.stringify(settings));
		if (!settingsResult.allow) {
			return {
				allow: false,
				reason: `blocked: workspace settings override — ${settingsResult.reason.slice(BLOCK_PREFIX.length)}`,
			};
		}
	}

	// ── 2. "extensions" — auto-install / auto-accept flags ─────────────
	const extensions = config["extensions"];
	if (typeof extensions === "object" && extensions !== null) {
		const extBlock = extensions as Record<string, unknown>;
		// Auto-update / auto-install flags in extensions configuration
		if (
			extBlock["autoUpdate"] === true ||
			extBlock["autoAccept"] === true ||
			extBlock["autoInstall"] === true
		) {
			return {
				allow: false,
				reason: "blocked: workspace extensions block with auto-update/auto-install/auto-accept flags (silent extension installation)",
			};
		}
	}

	return { allow: true };
}

/**
 * Validate MCP config file writes (.mcp.json, mcp*.json).
 *
 * Dangerous patterns:
 *   - New server entries with non-localhost URLs (tool redirection)
 *   - disabled: false on servers (re-enabling disabled servers)
 *   - allowedTools arrays with wildcard permissions
 */
function validateMCPConfig(content: string): ConfigValidationResult {
	const parseResult = tryParseJSON(content);
	if (!parseResult.ok) return { allow: false, reason: parseResult.reason };
	const config = parseResult.value;

	// MCP configs use either "mcpServers" (standard) or "servers" (legacy) key
	const servers =
		(config["mcpServers"] as Record<string, unknown>) ??
		(config["servers"] as Record<string, unknown>);

	if (typeof servers !== "object" || servers === null) return { allow: true };

	for (const [serverName, serverConfig] of Object.entries(servers)) {
		if (typeof serverConfig !== "object" || serverConfig === null) continue;
		const sc = serverConfig as Record<string, unknown>;

		// ── Non-localhost URL → tool redirection ─────────────────────────
		const url = sc["url"];
		if (typeof url === "string" && url.length > 0 && !isLocalhost(url)) {
			return {
				allow: false,
				reason: `blocked: server "${serverName}" points to non-localhost URL "${url}" (tool redirection)`,
			};
		}

		// ── command field → stdio transport code execution vector ──────────
		// Arbitrary launchers or inline-exec flags can run attacker code.
		const MCP_COMMAND_ALLOWLIST = new Set(["node", "python", "python3"]);
		// Only interpreters whose behavior is determined by args, not by downloading
		// arbitrary packages. Intentionally excludes npx, uvx, and other package runners.
		const MCP_BLOCKED_ARG_FLAGS = new Set(["-e", "--eval", "-c", "-m"]);
		const cmd = sc["command"];
		if (typeof cmd === "string" && cmd.length > 0) {
			if (!MCP_COMMAND_ALLOWLIST.has(cmd)) {
				return {
					allow: false,
					reason: `blocked: server "${serverName}" uses command "${cmd}" (unknown command in MCP server config — only ${[...MCP_COMMAND_ALLOWLIST].join(", ")} are allowed)`,
				};
			}
			const args = sc["args"];
			if (Array.isArray(args) && args.some((arg) => typeof arg === "string" && MCP_BLOCKED_ARG_FLAGS.has(arg))) {
				return {
					allow: false,
					reason: `blocked: server "${serverName}" uses inline execution args for command "${cmd}"`,
				};
			}
		}

		// ── disabled: false → re-enabling a disabled server ──────────────
		if (sc["disabled"] === false) {
			return {
				allow: false,
				reason: `blocked: server "${serverName}" has disabled=false (disabled=false is redundant for new entries and suspicious for existing entries — omit the field entirely)`,
			};
		}

		// ── allowedTools with wildcard → permission expansion ────────────
		const allowedTools = sc["allowedTools"];
		if (Array.isArray(allowedTools) && allowedTools.includes("*")) {
			return {
				allow: false,
				reason: `blocked: server "${serverName}" allowedTools contains wildcard "*" (permission expansion)`,
			};
		}
	}

	return { allow: true };
}

/**
 * Validate .idea/workspace.xml writes (IntelliJ IDEA).
 *
 * Dangerous patterns (string search, no XML parser needed):
 *   - <component name="PropertiesComponent"> with dangerous key-value pairs
 *   - dynamic.classpath enabling external classpath
 *   - PROJECT_CLASSES_DIRS classpath hijacking
 */
function validateIdeaWorkspaceXML(content: string): ConfigValidationResult {
	// ── dynamic.classpath = true → code execution via dynamic loading ──
	// Matches XML like: <property name="dynamic.classpath" value="true"/>
	// where dynamic.classpath and "true" appear within the same XML element.
	// Matches both orders: name="dynamic.classpath" value="true" and value="true" name="dynamic.classpath"
	if (/(?:\bdynamic\.classpath\b[^>]*?value\s*=\s*"true")|(?:value\s*=\s*"true"[^>]*?\bdynamic\.classpath\b)/i.test(content)) {
		return {
			allow: false,
			reason: "blocked: dynamic.classpath=true enables dynamic classpath loading (code execution vector)",
		};
	}

	// ── PROJECT_CLASSES_DIRS → classpath hijacking ─────────────────────
	if (/\bPROJECT_CLASSES_DIRS\b/i.test(content)) {
		return {
			allow: false,
			reason: "blocked: PROJECT_CLASSES_DIRS change in workspace.xml (classpath hijacking)",
		};
	}

	// ── PropertiesComponent with known dangerous URLs ──────────────────
	// Check for suspicious URL/command patterns in PropertiesComponent entries
	const pcMatch = content.match(
		/<component\s+name="PropertiesComponent">([\s\S]*?)<\/component>/i,
	);
	if (pcMatch) {
		const pcBody = pcMatch[1];
		// Check for non-localhost URLs being set as properties (tool/schema redirection)
		// Negative lookahead also rejects subdomain-prefix bypass: localhost.evil.com
		// starts with "localhost." so the (?:\.|:|/|$) suffix catches it.
		const urlProps = pcBody.match(
			/\b(?:url|endpoint|server|host|schema)\s*=\s*"(?:https?|wss?):\/\/(?!localhost(?:\.|:|\/|$)|127\.0\.0\.1(?:\.|:|\/|$)|::1(?:\.|:|\/|$))[^"]+"/gi,
		);
		if (urlProps && urlProps.length > 0) {
			return {
				allow: false,
				reason: `blocked: PropertiesComponent contains non-localhost URL binding "${urlProps[0]}" (tool redirection)`,
			};
		}
	}

	return { allow: true };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Validate a potential config file write against known security-sensitive
 * mutations.
 *
 * @param pathParam - Absolute or relative path of the file being written
 * @param content   - Full content of the file being written
 * @returns Result indicating whether this write is allowed or blocked
 */
export function validateConfigWrite(
	pathParam: string,
	content: string,
): ConfigValidationResult {
	const fileType = classifyConfigPath(pathParam);

	// Not a known config file type — always allow
	if (!fileType) return { allow: true };

	switch (fileType) {
		case "cursorrules":
			return {
				allow: false,
				reason: "blocked: .cursorrules can contain prompt injection payloads (AIShellJack)",
			};

		case "copilot-instructions":
			return {
				allow: false,
				reason:
					"blocked: .github/copilot-instructions.md can contain prompt injection payloads",
			};

		case "vscode-settings":
			return validateVSCodeSettings(content);

		case "vscode-workspace":
			return validateVSCodeWorkspace(content);

		case "mcp":
			return validateMCPConfig(content);

		case "idea-workspace":
			return validateIdeaWorkspaceXML(content);
	}
}

/**
 * Protected config files must be validated from their full final content.
 * Incremental edit hunks are blocked so they cannot bypass validation.
 */
export function validateConfigEdit(pathParam: string): ConfigValidationResult {
	if (!classifyConfigPath(pathParam)) return { allow: true };
	return {
		allow: false,
		reason:
			"blocked: protected config files must be rewritten with write so full content can be validated",
	};
}
