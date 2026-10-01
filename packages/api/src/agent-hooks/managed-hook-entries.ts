import { readFileSync } from 'node:fs';
import type { HealthResult } from './health.js';

/**
 * Clowder-managed lifecycle entries inside hook configs that users and other tools share
 * (~/.claude/settings.json, ~/.codex/hooks.json, ~/.gemini/hooks.json). Sync may only touch
 * entries it can prove are Clowder's; everything else is preserved in place (#1566).
 */

type JsonObject = Record<string, unknown>;

export const MANAGED_EVENT_SCRIPTS = {
  SessionStart: 'session-start-recall.sh',
  Stop: 'session-stop-check.sh',
} as const;

export type ManagedHookEvent = keyof typeof MANAGED_EVENT_SCRIPTS;
export type ManagedHookCommands = Readonly<Record<ManagedHookEvent, string>>;

export interface ManagedHookScope {
  targetRoot: string;
  commands: ManagedHookCommands;
}

const MANAGED_EVENTS = Object.keys(MANAGED_EVENT_SCRIPTS) as ManagedHookEvent[];
/** Trailing arguments Clowder renderers have emitted (`--codex-json` since 1413e6d57). */
const KNOWN_ARGS = new Map<string, readonly string[]>([
  [MANAGED_EVENT_SCRIPTS.SessionStart, ['']],
  [MANAGED_EVENT_SCRIPTS.Stop, ['', '--codex-json']],
]);

interface ParsedManagedCommand {
  script: string;
  usesBash: boolean;
  arg: string;
  /** False when the spelling cannot run as written (single-quoted $HOME, quoted ~). */
  runnable: boolean;
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function splitCommand(command: string): { usesBash: boolean; path: string; quote: string; tail: string } | null {
  const trimmed = command.trim();
  const bash = /^bash\s+/.exec(trimmed);
  const rest = bash ? trimmed.slice(bash[0].length) : trimmed;
  const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : '';
  if (quote) {
    const end = rest.indexOf(quote, 1);
    return end < 0 ? null : { usesBash: Boolean(bash), path: rest.slice(1, end), quote, tail: rest.slice(end + 1) };
  }
  const match = /^(\S+)([\s\S]*)$/.exec(rest);
  return match ? { usesBash: Boolean(bash), path: match[1], quote, tail: match[2] } : null;
}

/**
 * Recognises only spellings Clowder renderers or documented templates have produced:
 * `[bash ]<path>[ <known-arg>]`, where <path> (optionally quoted) is exactly
 * `<home>/.claude/hooks/<managed script>` and <home> is the target root, `$HOME` or `${HOME}` or `~`.
 * Paths are compared textually, never resolved, so traversal, subdirectories, unknown
 * arguments and compound commands stay third-party.
 */
function parseManagedCommand(command: unknown, targetRoot: string): ParsedManagedCommand | null {
  if (typeof command !== 'string') return null;
  const split = splitCommand(command);
  if (!split || (split.tail !== '' && !/^\s/.test(split.tail))) return null;
  const path = split.path.replace(/\\/g, '/');
  const script = path.slice(path.lastIndexOf('/') + 1);
  const arg = split.tail.trim();
  if (!KNOWN_ARGS.get(script)?.includes(arg)) return null;
  const root = targetRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable spelling, not a JS template
  const home = [root, '$HOME', '${HOME}', '~'].find((prefix) => path === `${prefix}/.claude/hooks/${script}`);
  if (home === undefined) return null;
  const runnable = home === root || (home === '~' ? split.quote === '' : split.quote !== "'");
  return { script, usesBash: split.usesBash, arg, runnable };
}

interface ManagedHandlerRef {
  groupIndex: number;
  handlerIndex: number;
  usesBash: boolean;
  /** Semantically equal to the rendered command; equivalent spellings are left as-is. */
  current: boolean;
}

type LocatedHandlers =
  | { ok: true; byEvent: Record<ManagedHookEvent, ManagedHandlerRef[]> }
  | { ok: false; reason: string };

function locateManagedHandlers(document: unknown, scope: ManagedHookScope): LocatedHandlers {
  if (!isJsonObject(document)) return { ok: false, reason: 'hook config root must be a JSON object' };
  const hooks = document.hooks;
  if (hooks !== undefined && !isJsonObject(hooks)) return { ok: false, reason: '"hooks" must be a JSON object' };
  const byEvent = {} as Record<ManagedHookEvent, ManagedHandlerRef[]>;
  for (const event of MANAGED_EVENTS) {
    const entries = hooks?.[event];
    if (entries !== undefined && !Array.isArray(entries))
      return { ok: false, reason: `"hooks.${event}" must be an array` };
    const desired = parseManagedCommand(scope.commands[event], scope.targetRoot);
    const refs: ManagedHandlerRef[] = [];
    (entries ?? []).forEach((group: unknown, groupIndex: number) => {
      if (!isJsonObject(group) || !Array.isArray(group.hooks)) return;
      group.hooks.forEach((handler: unknown, handlerIndex: number) => {
        if (!isJsonObject(handler) || handler.type !== 'command') return;
        const parsed = parseManagedCommand(handler.command, scope.targetRoot);
        if (parsed?.script !== MANAGED_EVENT_SCRIPTS[event]) return;
        const current = parsed.usesBash && parsed.runnable && parsed.arg === desired?.arg;
        refs.push({ groupIndex, handlerIndex, usesBash: parsed.usesBash, current });
      });
    });
    byEvent[event] = refs;
  }
  return { ok: true, byEvent };
}

export type ManagedHookMergeResult =
  | { kind: 'unchanged' }
  | { kind: 'updated'; document: JsonObject }
  | { kind: 'refused'; reason: string };

function duplicateReason(events: ManagedHookEvent[]): string {
  return `duplicate Clowder-managed ${events.join('/')} hook entries; remove the extras manually`;
}

/**
 * Updates recognised entries in place and appends missing ones after existing groups, so
 * no third-party handler changes position (Codex keys hook trust/enabled state by position).
 * Duplicates are removed only when `removeDuplicates` is set (Claude has no positional state).
 */
export function mergeManagedHooks(
  document: unknown,
  options: ManagedHookScope & { removeDuplicates: boolean },
): ManagedHookMergeResult {
  const draft: unknown = structuredClone(document);
  const located = locateManagedHandlers(draft, options);
  if (!located.ok) return { kind: 'refused', reason: located.reason };
  const duplicated = MANAGED_EVENTS.filter((event) => located.byEvent[event].length > 1);
  if (duplicated.length > 0 && !options.removeDuplicates)
    return { kind: 'refused', reason: duplicateReason(duplicated) };

  const doc = draft as JsonObject;
  let changed = false;
  for (const event of MANAGED_EVENTS) {
    doc.hooks ??= {};
    const hooksRoot = doc.hooks as JsonObject;
    hooksRoot[event] ??= [];
    const entries = hooksRoot[event] as JsonObject[];
    const [first, ...extras] = located.byEvent[event];
    if (!first) {
      entries.push({ hooks: [{ type: 'command', command: options.commands[event] }] });
      changed = true;
      continue;
    }
    for (const ref of extras.reverse()) {
      const handlers = entries[ref.groupIndex].hooks as unknown[];
      handlers.splice(ref.handlerIndex, 1);
      if (handlers.length === 0) entries.splice(ref.groupIndex, 1);
      changed = true;
    }
    if (!first.current) {
      (entries[first.groupIndex].hooks as JsonObject[])[first.handlerIndex].command = options.commands[event];
      changed = true;
    }
  }
  return changed ? { kind: 'updated', document: doc } : { kind: 'unchanged' };
}

export interface ManagedHookInspection {
  invalid?: string;
  missing: ManagedHookEvent[];
  outdated: ManagedHookEvent[];
  duplicated: ManagedHookEvent[];
  missingBash: boolean;
}

export function inspectManagedHooks(document: unknown, scope: ManagedHookScope): ManagedHookInspection {
  const located = locateManagedHandlers(document, scope);
  if (!located.ok) return { invalid: located.reason, missing: [], outdated: [], duplicated: [], missingBash: false };
  const refs = (event: ManagedHookEvent) => located.byEvent[event];
  return {
    missing: MANAGED_EVENTS.filter((event) => refs(event).length === 0),
    outdated: MANAGED_EVENTS.filter((event) => refs(event).some((ref) => !ref.current)),
    duplicated: MANAGED_EVENTS.filter((event) => refs(event).length > 1),
    missingBash: MANAGED_EVENTS.some((event) => refs(event).some((ref) => !ref.usesBash)),
  };
}

export function readHookDocument(path: string): { ok: true; document: unknown } | { ok: false; reason: string } {
  try {
    return { ok: true, document: JSON.parse(readFileSync(path, 'utf-8')) };
  } catch (error) {
    return { ok: false, reason: `cannot read hook config: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Health of an existing shared hook JSON file; third-party content never makes it unhealthy. */
export function managedHookFileHealth(name: string, targetPath: string, scope: ManagedHookScope): HealthResult {
  const read = readHookDocument(targetPath);
  const inspection = read.ok ? inspectManagedHooks(read.document, scope) : undefined;
  const invalid = read.ok ? inspection?.invalid : read.reason;
  if (invalid !== undefined || !inspection) {
    return { name, drifted: false, status: 'error', targetPath, reason: invalid ?? 'unreadable hook config' };
  }
  const fields = (events: ManagedHookEvent[]) => events.map((event) => `hooks.${event}`);
  if (inspection.duplicated.length > 0 || inspection.outdated.length > 0) {
    const events = inspection.duplicated.length > 0 ? inspection.duplicated : inspection.outdated;
    const reason =
      inspection.duplicated.length > 0
        ? duplicateReason(events)
        : `Clowder-managed ${events.join('/')} hook command is outdated`;
    return {
      name,
      drifted: true,
      status: 'stale',
      targetPath,
      reason,
      diff: { kind: 'json', message: reason, fields: fields(events) },
    };
  }
  if (inspection.missing.length > 0) {
    const reason = `Clowder-managed ${inspection.missing.join('/')} hook entries are missing`;
    return {
      name,
      drifted: true,
      status: 'missing',
      targetPath,
      reason,
      diff: { kind: 'json', message: reason, fields: fields(inspection.missing) },
    };
  }
  return { name, drifted: false, status: 'configured', targetPath, reason: 'configured' };
}
