/// <reference types="node" />

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

// ── Types ────────────────────────────────────────────────────────────

export type ConfigValidationResult =
	| { allow: true }
	| { allow: false; reason: string };

/** Internal categorisation of config file types. */
type ConfigFileType =
	| "vscode-settings"
	| "cursorrules"
	| "copilot-instructions"
	| "mcp"
	| "vscode-workspace"
	| "idea-workspace";

// ── URL helpers ──────────────────────────────────────────────────

/** True if the URL points to a local (loopback) address. */
function isLocalhost(url: string): boolean {
	// Unix socket paths (unix:// or /var/run/...) are always local
	if (url.startsWith("unix:") || url.startsWith("/")) return true;

	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.toLowerCase();
		return (
			hostname === "localhost" ||
			hostname === "127.0.0.1" ||
			hostname === "::1" ||
			hostname === "::ffff:127.0.0.1" ||
			hostname === "::ffff:7f00:1" ||
			hostname === "[::ffff:127.0.0.1]" ||
			hostname === "[::ffff:7f00:1]" ||
			hostname === "0.0.0.0"
		);
	} catch {
		// Not a valid URL — treat as non-local
		return false;
	}
}

// ── Path classification ─────────────────────────────────────────────

/** Classify a file path into a config file type, or null if not protected. */
function classifyConfigPath(filePath: string): ConfigFileType | null {
	// Normalise separators so checks work cross-platform (macOS/Linux use /,
	// Windows uses \).
	const normalized = path.normalize(filePath).replace(/\\/g, "/");
	const basename = path.basename(normalized);

	// .cursorrules — plaintext, entire file is the attack vector (AIShellJack)
	if (basename === ".cursorrules") return "cursorrules";

	// .github/copilot-instructions.md — embedded instructions
	if (normalized.includes(".github/copilot-instructions.md")) return "copilot-instructions";

	// .vscode/settings.json — structured JSON settings
	if (normalized.includes(".vscode/settings.json")) return "vscode-settings";

	// .vscode/*.code-workspace — multi-root workspace
	if (basename.endsWith(".code-workspace") && normalized.includes(".vscode/")) return "vscode-workspace";

	// MCP config: .mcp.json, mcp.json, mcp.servers.json, etc.
	if (/^\.?mcp[\w.-]*\.json$/i.test(basename)) return "mcp";

	// .idea/workspace.xml — IntelliJ IDEA workspace
	if (normalized.includes(".idea/workspace.xml")) return "idea-workspace";

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
			return { ok: true, value: {} };
		}
		return { ok: true, value: parsed as Record<string, unknown> };
	} catch {
		return { ok: false, reason: "blocked: invalid JSON in protected config file — cannot validate" };
	}
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
	if (
		config["chat.tools.autoApprove"] === true ||
		config["chat.tools.autoApprove"] === "on"
	) {
		return {
			allow: false,
			reason:
				'blocked: chat.tools.autoApprove enables automatic tool approval without human review (CVE-2025-53773)',
		};
	}

	// ── 2. *validate.executablePath — custom validation executable ─────
	for (const key of Object.keys(config)) {
		if (
			key.includes("validate.executablePath") &&
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
	if (
		typeof config["git.path"] === "string" &&
		config["git.path"].length > 0
	) {
		return {
			allow: false,
			reason: "blocked: git.path overrides git executable path (executable hijacking)",
		};
	}

	// ── 4. terminal.integrated.shell.* — shell executable hijacking ────
	for (const key of Object.keys(config)) {
		if (key.startsWith("terminal.integrated.shell.")) {
			return {
				allow: false,
				reason: `blocked: ${key} sets custom shell path (executable hijacking)`,
			};
		}
	}

	// ── 5. files.associations — script extension → executable handler ──
	const associations = config["files.associations"];
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
				reason: `blocked: workspace settings override — ${settingsResult.reason.slice("blocked: ".length)}`,
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
	if (/\bdynamic\.classpath\b[^>]*?"true"/i.test(content)) {
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
		const urlProps = pcBody.match(
			/\b(?:url|endpoint|server|host|schema)\s*=\s*"https?:\/\/(?!localhost|127\.0\.0\.1|::1)[^"]+"/gi,
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
