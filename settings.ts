import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SettingItem,
	SettingsList,
	type SettingsListTheme,
	Text,
} from "@earendil-works/pi-tui";

export type HandoffResumeBehavior = "wait" | "proceed";

type SettingsObject = Record<string, unknown>;
type SettingsSourceLabel = "global" | "project";

export interface SettingsSourceState {
	label: SettingsSourceLabel;
	path: string;
	exists: boolean;
	invalid: boolean;
	settings: SettingsObject;
	resumeBehavior: unknown;
}

export interface HandoffSettingsState {
	global: SettingsSourceState;
	project: SettingsSourceState;
	merged: SettingsObject;
}

export interface AgenticodingSettingsModel {
	state: HandoffSettingsState;
	effectiveBehavior: HandoffResumeBehavior;
	effectiveSource: "default" | "global" | "project" | "fallback";
	projectOverride: boolean;
	projectOverrideWarning?: string;
	globalWriteBlocked: boolean;
	messages: string[];
	save: (value: HandoffResumeBehavior, ctx?: ExtensionContext) => Promise<boolean>;
}

const SUPPORTED_HANDOFF_RESUME_BEHAVIORS: HandoffResumeBehavior[] = ["wait", "proceed"];

export const MANUAL_AGENTICODING_SETTINGS_INSTRUCTIONS =
	"No interactive settings TUI is available. Edit ~/.pi/agent/settings.json and set { \"handoff\": { \"resumeBehavior\": \"wait\" } } or \"proceed\". Project .pi/settings.json can override the global value.";

function getGlobalSettingsPath(): string {
	return join(homedir(), ".pi", "agent", "settings.json");
}

function getProjectSettingsPath(cwd: string | undefined): string {
	return join(cwd ?? process.cwd(), ".pi", "settings.json");
}

function isPlainObject(value: unknown): value is SettingsObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createSettingsObject(): SettingsObject {
	return Object.create(null) as SettingsObject;
}

function hasOwnSetting(settings: SettingsObject, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(settings, key);
}

function getOwnSetting(settings: SettingsObject, key: string): unknown {
	return hasOwnSetting(settings, key) ? settings[key] : undefined;
}

function setOwnSetting(settings: SettingsObject, key: string, value: unknown): void {
	Object.defineProperty(settings, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true,
	});
}

function cloneSettingsObject(settings: SettingsObject): SettingsObject {
	const result = createSettingsObject();
	for (const [key, value] of Object.entries(settings)) {
		setOwnSetting(result, key, isPlainObject(value) ? cloneSettingsObject(value) : value);
	}
	return result;
}

function mergeSettings(base: SettingsObject, override: SettingsObject): SettingsObject {
	const result = cloneSettingsObject(base);
	for (const [key, value] of Object.entries(override)) {
		const existing = getOwnSetting(result, key);
		if (isPlainObject(existing) && isPlainObject(value)) {
			setOwnSetting(result, key, mergeSettings(existing, value));
		} else {
			setOwnSetting(result, key, isPlainObject(value) ? cloneSettingsObject(value) : value);
		}
	}
	return result;
}

function extractResumeBehavior(settings: SettingsObject): unknown {
	const handoff = getOwnSetting(settings, "handoff");
	return isPlainObject(handoff) && hasOwnSetting(handoff, "resumeBehavior")
		? getOwnSetting(handoff, "resumeBehavior")
		: undefined;
}

function isHandoffResumeBehavior(value: unknown): value is HandoffResumeBehavior {
	return value === "wait" || value === "proceed";
}

function notify(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" | "error"): void {
	if (ctx?.hasUI) {
		ctx.ui.notify(message, level);
	}
}

function formatSettingValue(value: unknown): string {
	if (typeof value === "string") return `"${value}"`;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

async function readSettingsSource(label: SettingsSourceLabel, path: string): Promise<SettingsSourceState> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") {
			return { label, path, exists: false, invalid: false, settings: createSettingsObject(), resumeBehavior: undefined };
		}
		return { label, path, exists: true, invalid: true, settings: createSettingsObject(), resumeBehavior: undefined };
	}

	try {
		const parsed = JSON.parse(raw);
		if (!isPlainObject(parsed)) {
			return { label, path, exists: true, invalid: true, settings: createSettingsObject(), resumeBehavior: undefined };
		}
		const settings = cloneSettingsObject(parsed);
		return { label, path, exists: true, invalid: false, settings, resumeBehavior: extractResumeBehavior(settings) };
	} catch {
		return { label, path, exists: true, invalid: true, settings: createSettingsObject(), resumeBehavior: undefined };
	}
}

export async function readHandoffSettingsState(cwd?: string): Promise<HandoffSettingsState> {
	const global = await readSettingsSource("global", getGlobalSettingsPath());
	const project = await readSettingsSource("project", getProjectSettingsPath(cwd));
	return {
		global,
		project,
		merged: mergeSettings(global.settings, project.settings),
	};
}

export async function resolveHandoffResumeBehavior(ctx: ExtensionContext): Promise<HandoffResumeBehavior> {
	const state = await readHandoffSettingsState(ctx.cwd);

	if (state.global.invalid) {
		notify(ctx, `Invalid global settings JSON at ${state.global.path}; falling back to wait for handoff.resumeBehavior.`, "warning");
	}
	if (state.project.invalid) {
		notify(ctx, `Invalid project settings JSON at ${state.project.path}; falling back to wait for handoff.resumeBehavior.`, "warning");
	}
	if (state.global.invalid || state.project.invalid) {
		return "wait";
	}

	const resumeBehavior = extractResumeBehavior(state.merged);
	if (resumeBehavior === undefined) {
		return "wait";
	}
	if (isHandoffResumeBehavior(resumeBehavior)) {
		return resumeBehavior;
	}

	notify(
		ctx,
		`Unsupported handoff.resumeBehavior value ${formatSettingValue(resumeBehavior)}; supported values are "wait" or "proceed", falling back to wait.`,
		"warning",
	);
	return "wait";
}

export async function writeGlobalHandoffResumeBehavior(
	value: HandoffResumeBehavior,
	ctx?: ExtensionContext,
): Promise<boolean> {
	const path = getGlobalSettingsPath();
	let settings = createSettingsObject();
	let raw: string | undefined;

	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code !== "ENOENT") {
			notify(ctx, `Unable to read global settings JSON at ${path}; not writing handoff.resumeBehavior to avoid clobbering it.`, "error");
			return false;
		}
	}

	if (raw !== undefined) {
		try {
			const parsed = JSON.parse(raw);
			if (!isPlainObject(parsed)) {
				notify(ctx, `Invalid global settings JSON at ${path}; root must be an object, not writing handoff.resumeBehavior to avoid clobbering it.`, "error");
				return false;
			}
			settings = cloneSettingsObject(parsed);
		} catch {
			notify(ctx, `Invalid global settings JSON at ${path}; not writing handoff.resumeBehavior to avoid clobbering it.`, "error");
			return false;
		}
	}

	const existingHandoff = getOwnSetting(settings, "handoff");
	const handoff = isPlainObject(existingHandoff) ? cloneSettingsObject(existingHandoff) : createSettingsObject();
	setOwnSetting(handoff, "resumeBehavior", value);
	setOwnSetting(settings, "handoff", handoff);

	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(settings, null, 2) + "\n", "utf8");
	notify(ctx, `Saved global handoff.resumeBehavior = "${value}".`, "info");
	return true;
}

export async function buildAgenticodingSettingsModel(ctx: ExtensionContext): Promise<AgenticodingSettingsModel> {
	const state = await readHandoffSettingsState(ctx.cwd);
	const messages: string[] = [];
	let effectiveBehavior: HandoffResumeBehavior = "wait";
	let effectiveSource: AgenticodingSettingsModel["effectiveSource"] = "default";

	if (state.global.invalid) {
		messages.push(`Invalid global settings JSON at ${state.global.path}; global TUI saves are blocked until it is fixed.`);
		effectiveSource = "fallback";
	} else if (state.project.invalid) {
		messages.push(`Invalid project settings JSON at ${state.project.path}; runtime falls back to wait, but global TUI saves are still allowed.`);
		effectiveSource = "fallback";
	} else {
		const mergedValue = extractResumeBehavior(state.merged);
		if (isHandoffResumeBehavior(mergedValue)) {
			effectiveBehavior = mergedValue;
			effectiveSource = state.project.resumeBehavior !== undefined ? "project" : "global";
		} else if (mergedValue !== undefined) {
			messages.push(`Unsupported handoff.resumeBehavior value ${formatSettingValue(mergedValue)}; runtime falls back to wait.`);
			effectiveSource = "fallback";
		}
	}

	const projectOverride = !state.project.invalid && state.project.resumeBehavior !== undefined;
	const projectOverrideWarning = projectOverride
		? `Project settings at ${state.project.path} define handoff.resumeBehavior and override/mask the global value. Saving here writes only ${state.global.path}; edit or remove the project setting manually before the global save affects this project.`
		: undefined;
	if (projectOverrideWarning) {
		messages.push(projectOverrideWarning);
	}

	return {
		state,
		effectiveBehavior,
		effectiveSource,
		projectOverride,
		projectOverrideWarning,
		globalWriteBlocked: state.global.invalid,
		messages,
		save: (value, saveCtx) => writeGlobalHandoffResumeBehavior(value, saveCtx ?? ctx),
	};
}

function describeValue(value: unknown): string {
	return value === undefined ? "unset" : formatSettingValue(value);
}

function getGlobalEditableHandoffResumeBehavior(model: AgenticodingSettingsModel): HandoffResumeBehavior {
	return isHandoffResumeBehavior(model.state.global.resumeBehavior) ? model.state.global.resumeBehavior : "wait";
}

export function getAgenticodingSettingsDisplayLines(model: AgenticodingSettingsModel): string[] {
	const lines = [
		`Resolved handoff.resumeBehavior: ${model.effectiveBehavior} (${model.effectiveSource})`,
		`Supported values: wait, proceed. Default: wait (no automatic continuation).`,
		`Proceed sends exactly one \"Proceed.\" message after compaction.`,
		`Global settings: ${model.state.global.path} (${model.state.global.invalid ? "invalid JSON" : describeValue(model.state.global.resumeBehavior)})`,
		`Project settings: ${model.state.project.path} (${model.state.project.invalid ? "invalid JSON" : describeValue(model.state.project.resumeBehavior)})`,
		`TUI saves are global-only; project settings override global settings at runtime.`,
	];
	for (const message of model.messages) {
		lines.push(`Warning: ${message}`);
	}
	return lines;
}

function getSafeSettingsListTheme(): SettingsListTheme {
	try {
		return getSettingsListTheme();
	} catch {
		return {
			label: (text) => text,
			value: (text) => text,
			description: (text) => text,
			cursor: ">",
			hint: (text) => text,
		};
	}
}

export function createAgenticodingSettingsComponent(
	initialModel: AgenticodingSettingsModel,
	ctx: ExtensionContext,
	tui: { requestRender: () => void },
	theme: { fg: (name: string, text: string) => string; bold: (text: string) => string },
	done: (value: "closed") => void,
) {
	let model = initialModel;
	const container = new Container();
	const summary = new Text("", 1, 0);
	const items: SettingItem[] = [{
		id: "handoff.resumeBehavior",
		label: "Handoff resume behavior (global save)",
		currentValue: getGlobalEditableHandoffResumeBehavior(model),
		values: SUPPORTED_HANDOFF_RESUME_BEHAVIORS,
	}];

	const refreshSummary = () => {
		const lines = getAgenticodingSettingsDisplayLines(model).map((line) => {
			if (line.startsWith("Warning:")) return theme.fg("warning", line);
			if (line.startsWith("Resolved")) return theme.fg("accent", line);
			return theme.fg("muted", line);
		});
		summary.setText(lines.join("\n"));
	};
	refreshSummary();

	container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
	container.addChild(new Text(theme.fg("accent", theme.bold(" Agenticoding Settings ")), 1, 0));
	container.addChild(summary);

	const settingsList = new SettingsList(
		items,
		4,
		getSafeSettingsListTheme(),
		(id, newValue) => {
			if (id !== "handoff.resumeBehavior" || !isHandoffResumeBehavior(newValue)) return;
			void (async () => {
				try {
					const saved = await model.save(newValue, ctx);
					model = await buildAgenticodingSettingsModel(ctx);
					settingsList.updateValue("handoff.resumeBehavior", getGlobalEditableHandoffResumeBehavior(model));
					if (saved && model.projectOverrideWarning) {
						notify(ctx, model.projectOverrideWarning, "warning");
					}
					refreshSummary();
					tui.requestRender();
				} catch (err) {
					notify(ctx, `Failed to save handoff.resumeBehavior: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			})();
		},
		() => done("closed"),
		{ enableSearch: false },
	);
	container.addChild(settingsList);
	container.addChild(new Text(theme.fg("dim", " ↑↓ navigate • enter change • esc close "), 1, 0));
	container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

	return {
		render: (width: number) => container.render(width),
		invalidate: () => {
			container.invalidate();
			refreshSummary();
		},
		handleInput: (data: string) => {
			settingsList.handleInput?.(data);
			tui.requestRender();
		},
	};
}

function showManualSettingsInstructions(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.hasUI) {
		ctx.ui.notify(MANUAL_AGENTICODING_SETTINGS_INSTRUCTIONS, "info");
		return;
	}

	pi.sendMessage({
		customType: "agenticoding-settings",
		content: MANUAL_AGENTICODING_SETTINGS_INSTRUCTIONS,
		display: true,
	});
}

export function registerAgenticodingSettingsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("agenticoding-settings", {
		description: "Configure pi-agenticoding handoff resume behavior",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
				showManualSettingsInstructions(pi, ctx);
				return;
			}

			const model = await buildAgenticodingSettingsModel(ctx);
			const result = await ctx.ui.custom<"closed">((tui, theme, _kb, done) =>
				createAgenticodingSettingsComponent(model, ctx, tui, theme, done),
			);
			if (result === undefined) {
				showManualSettingsInstructions(pi, ctx);
			}
		},
	});
}
