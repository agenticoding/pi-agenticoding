import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SettingItem,
	SettingsList,
	type SettingsListTheme,
	Text,
} from "@earendil-works/pi-tui";

export type HandoffAutomaticValue = "true" | "false";

type SettingsObject = Record<string, unknown>;
type SettingsSourceLabel = "global" | "project";
type SettingsInvalidReason = "invalid-json" | "non-object" | "read-error";
type AtomicWriteOperations = {
	writeFile: typeof writeFile;
	rename: typeof rename;
	rm: typeof rm;
};

export interface SettingsSourceState {
	label: SettingsSourceLabel;
	path: string;
	exists: boolean;
	invalid: boolean;
	invalidReason?: SettingsInvalidReason;
	readErrorCode?: string;
	settings: SettingsObject;
	automaticEnabled: unknown;
}

export interface HandoffSettingsState {
	global: SettingsSourceState;
	project: SettingsSourceState;
	merged: SettingsObject;
}

export interface HandoffAutomaticAvailability {
	automaticEnabled: boolean;
	source: "default" | "global" | "project" | "fallback";
}

export interface AgenticodingSettingsModel {
	state: HandoffSettingsState;
	effectiveAutomaticEnabled: boolean;
	effectiveSource: HandoffAutomaticAvailability["source"];
	projectOverride: boolean;
	projectOverrideWarning?: string;
	globalWriteBlocked: boolean;
	messages: string[];
	save: (value: boolean | HandoffAutomaticValue, ctx?: ExtensionContext) => Promise<boolean>;
}

const SUPPORTED_HANDOFF_AUTOMATIC_VALUES: HandoffAutomaticValue[] = ["true", "false"];
const defaultAtomicWriteOperations: AtomicWriteOperations = { writeFile, rename, rm };
let atomicWriteOperations: AtomicWriteOperations = defaultAtomicWriteOperations;

export function setSettingsAtomicWriteOperationsForTest(operations: Partial<AtomicWriteOperations> | null): void {
	atomicWriteOperations = operations ? { ...defaultAtomicWriteOperations, ...operations } : defaultAtomicWriteOperations;
}

export const MANUAL_AGENTICODING_SETTINGS_INSTRUCTIONS =
	"No interactive settings TUI is available. Edit ~/.pi/agent/settings.json and set handoff.automaticEnabled, for example { \"handoff\": { \"automaticEnabled\": true } } or false. Project .pi/settings.json can override the global value.";

function getGlobalSettingsPath(): string {
	return join(homedir(), ".pi", "agent", "settings.json");
}

function getProjectSettingsPath(cwd: string | undefined): string {
	return join(cwd ?? process.cwd(), ".pi", "settings.json");
}

async function writeFileAtomically(path: string, contents: string): Promise<void> {
	const directory = dirname(path);
	const tempPath = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
	try {
		await atomicWriteOperations.writeFile(tempPath, contents, "utf8");
		await atomicWriteOperations.rename(tempPath, path);
	} catch (error) {
		await atomicWriteOperations.rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
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
		if (key === "handoff" && !isPlainObject(value)) {
			continue;
		}
		if (isPlainObject(existing) && isPlainObject(value)) {
			setOwnSetting(result, key, mergeSettings(existing, value));
		} else {
			setOwnSetting(result, key, isPlainObject(value) ? cloneSettingsObject(value) : value);
		}
	}
	return result;
}

function extractAutomaticEnabled(settings: SettingsObject): unknown {
	const handoff = getOwnSetting(settings, "handoff");
	return isPlainObject(handoff) && hasOwnSetting(handoff, "automaticEnabled")
		? getOwnSetting(handoff, "automaticEnabled")
		: undefined;
}

function getLayeredAutomaticEnabled(state: HandoffSettingsState): { value: unknown; source: "default" | "global" | "project" } {
	if (state.project.automaticEnabled !== undefined) {
		return { value: state.project.automaticEnabled, source: "project" };
	}
	if (state.global.automaticEnabled !== undefined) {
		return { value: state.global.automaticEnabled, source: "global" };
	}
	return { value: undefined, source: "default" };
}

function isHandoffAutomaticValue(value: unknown): value is HandoffAutomaticValue {
	return value === "true" || value === "false";
}

function parseAutomaticValue(value: boolean | HandoffAutomaticValue): boolean {
	return value === true || value === "true";
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

function getErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
		? (error as { code: string }).code
		: undefined;
}

function describeInvalidSource(source: SettingsSourceState, consequence: string): string {
	const sourceName = source.label === "global" ? "global" : "project";
	if (source.invalidReason === "read-error") {
		const code = source.readErrorCode ? ` (${source.readErrorCode})` : "";
		return `Unable to read ${sourceName} settings at ${source.path}${code}; ${consequence}.`;
	}
	if (source.invalidReason === "non-object") {
		return `Invalid ${sourceName} settings JSON at ${source.path}; root must be an object; ${consequence}.`;
	}
	return `Invalid ${sourceName} settings JSON at ${source.path}; ${consequence}.`;
}

function describeSourceStateForDisplay(source: SettingsSourceState): string {
	if (!source.invalid) {
		return describeValue(source.automaticEnabled);
	}
	if (source.invalidReason === "read-error") {
		return source.readErrorCode ? `unreadable (${source.readErrorCode})` : "unreadable";
	}
	if (source.invalidReason === "non-object") {
		return "non-object JSON";
	}
	return "invalid JSON";
}

async function readSettingsSource(label: SettingsSourceLabel, path: string): Promise<SettingsSourceState> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		const code = getErrorCode(error);
		if (code === "ENOENT") {
			return { label, path, exists: false, invalid: false, settings: createSettingsObject(), automaticEnabled: undefined };
		}
		return { label, path, exists: true, invalid: true, invalidReason: "read-error", readErrorCode: code, settings: createSettingsObject(), automaticEnabled: undefined };
	}

	try {
		const parsed = JSON.parse(raw);
		if (!isPlainObject(parsed)) {
			return { label, path, exists: true, invalid: true, invalidReason: "non-object", settings: createSettingsObject(), automaticEnabled: undefined };
		}
		const settings = cloneSettingsObject(parsed);
		return { label, path, exists: true, invalid: false, settings, automaticEnabled: extractAutomaticEnabled(settings) };
	} catch {
		return { label, path, exists: true, invalid: true, invalidReason: "invalid-json", settings: createSettingsObject(), automaticEnabled: undefined };
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

function resolveFromState(state: HandoffSettingsState): HandoffAutomaticAvailability {
	if (state.global.invalid || state.project.invalid) {
		return { automaticEnabled: false, source: "fallback" };
	}

	const automatic = getLayeredAutomaticEnabled(state);
	if (automatic.value === undefined) {
		return { automaticEnabled: true, source: "default" };
	}
	if (typeof automatic.value === "boolean") {
		return { automaticEnabled: automatic.value, source: automatic.source };
	}
	return { automaticEnabled: false, source: "fallback" };
}

export async function resolveHandoffAutomaticAvailability(ctx: ExtensionContext): Promise<HandoffAutomaticAvailability> {
	const state = await readHandoffSettingsState(ctx.cwd);

	if (state.global.invalid) {
		notify(ctx, describeInvalidSource(state.global, "falling back to automatic handoff disabled for handoff.automaticEnabled"), "warning");
	}
	if (state.project.invalid) {
		notify(ctx, describeInvalidSource(state.project, "falling back to automatic handoff disabled for handoff.automaticEnabled"), "warning");
	}
	if (state.global.invalid || state.project.invalid) {
		return { automaticEnabled: false, source: "fallback" };
	}

	const automatic = getLayeredAutomaticEnabled(state);
	if (automatic.value === undefined) {
		return { automaticEnabled: true, source: "default" };
	}
	if (typeof automatic.value === "boolean") {
		return { automaticEnabled: automatic.value, source: automatic.source };
	}

	notify(
		ctx,
		`Unsupported handoff.automaticEnabled value ${formatSettingValue(automatic.value)}; supported values are true or false, falling back to automatic handoff disabled.`,
		"warning",
	);
	return { automaticEnabled: false, source: "fallback" };
}

export async function writeGlobalHandoffAutomaticEnabled(
	value: boolean | HandoffAutomaticValue,
	ctx?: ExtensionContext,
): Promise<boolean> {
	const booleanValue = parseAutomaticValue(value);
	const path = getGlobalSettingsPath();
	let settings = createSettingsObject();
	let raw: string | undefined;

	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		const code = getErrorCode(error);
		if (code !== "ENOENT") {
			notify(ctx, `Unable to read global settings JSON at ${path}; not writing handoff.automaticEnabled to avoid clobbering it.`, "error");
			return false;
		}
	}

	if (raw !== undefined) {
		try {
			const parsed = JSON.parse(raw);
			if (!isPlainObject(parsed)) {
				notify(ctx, `Invalid global settings JSON at ${path}; root must be an object, not writing handoff.automaticEnabled to avoid clobbering it.`, "error");
				return false;
			}
			settings = cloneSettingsObject(parsed);
		} catch {
			notify(ctx, `Invalid global settings JSON at ${path}; not writing handoff.automaticEnabled to avoid clobbering it.`, "error");
			return false;
		}
	}

	const existingHandoff = getOwnSetting(settings, "handoff");
	const handoff = isPlainObject(existingHandoff) ? cloneSettingsObject(existingHandoff) : createSettingsObject();
	setOwnSetting(handoff, "automaticEnabled", booleanValue);
	setOwnSetting(settings, "handoff", handoff);

	await mkdir(dirname(path), { recursive: true });
	await writeFileAtomically(path, JSON.stringify(settings, null, 2) + "\n");
	notify(ctx, `Saved global handoff.automaticEnabled = ${booleanValue}.`, "info");
	return true;
}

export async function buildAgenticodingSettingsModel(ctx: ExtensionContext): Promise<AgenticodingSettingsModel> {
	const state = await readHandoffSettingsState(ctx.cwd);
	const messages: string[] = [];
	let effective = resolveFromState(state);

	if (state.global.invalid) {
		messages.push(describeInvalidSource(state.global, "global TUI saves are blocked until it is fixed"));
	} else if (state.project.invalid) {
		messages.push(describeInvalidSource(state.project, "runtime falls back to automatic handoff disabled, but global TUI saves are still allowed"));
	} else {
		const automatic = getLayeredAutomaticEnabled(state);
		if (automatic.value !== undefined && typeof automatic.value !== "boolean") {
			messages.push(`Unsupported handoff.automaticEnabled value ${formatSettingValue(automatic.value)}; runtime falls back to automatic handoff disabled.`);
		}
	}

	const projectOverride = !state.project.invalid && state.project.automaticEnabled !== undefined;
	const projectOverrideWarning = projectOverride
		? `Project settings at ${state.project.path} define handoff.automaticEnabled and override/mask the global value. Saving here writes only ${state.global.path}; edit or remove the project setting manually before the global save affects this project.`
		: undefined;
	if (projectOverrideWarning) {
		messages.push(projectOverrideWarning);
	}

	return {
		state,
		effectiveAutomaticEnabled: effective.automaticEnabled,
		effectiveSource: effective.source,
		projectOverride,
		projectOverrideWarning,
		globalWriteBlocked: state.global.invalid,
		messages,
		save: (value, saveCtx) => writeGlobalHandoffAutomaticEnabled(value, saveCtx ?? ctx),
	};
}

function describeValue(value: unknown): string {
	return value === undefined ? "unset" : formatSettingValue(value);
}

function getGlobalEditableHandoffAutomaticValue(model: AgenticodingSettingsModel): HandoffAutomaticValue {
	return typeof model.state.global.automaticEnabled === "boolean"
		? (model.state.global.automaticEnabled ? "true" : "false")
		: "true";
}

export function getAgenticodingSettingsDisplayLines(model: AgenticodingSettingsModel): string[] {
	const lines = [
		`Resolved handoff.automaticEnabled: ${model.effectiveAutomaticEnabled} (${model.effectiveSource})`,
		`Supported values: true, false. Default: true (automatic handoff enabled).`,
		`When false, automatic agent-initiated handoff is blocked; explicit /handoff <direction> still works.`,
		`Prompt guidance updates on future fresh agent turns; direct tool calls are guarded at execution time.`,
		`After successful handoff compaction, Pi auto-sends Proceed.; this continuation is fixed, not configurable.`,
		`Global settings: ${model.state.global.path} (${describeSourceStateForDisplay(model.state.global)})`,
		`Project settings: ${model.state.project.path} (${describeSourceStateForDisplay(model.state.project)})`,
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
		id: "handoff.automaticEnabled",
		label: "Automatic handoff availability (global save)",
		currentValue: getGlobalEditableHandoffAutomaticValue(model),
		values: SUPPORTED_HANDOFF_AUTOMATIC_VALUES,
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
			if (id !== "handoff.automaticEnabled" || !isHandoffAutomaticValue(newValue)) return;
			void (async () => {
				try {
					const saved = await model.save(newValue, ctx);
					model = await buildAgenticodingSettingsModel(ctx);
					settingsList.updateValue("handoff.automaticEnabled", getGlobalEditableHandoffAutomaticValue(model));
					if (saved && model.projectOverrideWarning) {
						notify(ctx, model.projectOverrideWarning, "warning");
					}
					refreshSummary();
					tui.requestRender();
				} catch (err) {
					notify(ctx, `Failed to save handoff.automaticEnabled: ${err instanceof Error ? err.message : String(err)}`, "error");
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
		description: "Configure pi-agenticoding automatic handoff availability",
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
