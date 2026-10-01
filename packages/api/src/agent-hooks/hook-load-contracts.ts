/**
 * Whether a CLI will load a hook config at all. Codex and Claude Code drop every hook (Codex:
 * the whole hooks.json) when a single entry violates their schema, so Clowder may merge into a
 * shared file, or report its hooks as configured, only when every entry is within the contract
 * verified for that CLI version. Fields and event names a CLI ignores are accepted (#1566).
 */

type JsonObject = Record<string, unknown>;

interface Check {
  ok: (value: unknown) => boolean;
  expect: string;
}

interface HandlerSpec {
  required: Readonly<Record<string, Check>>;
  optional: Readonly<Record<string, Check>>;
}

export interface HookLoadContract {
  /** CLI and version the contract was verified against; shown in refusal reasons. */
  name: string;
  /** When set, any other top-level key makes the CLI reject the file. */
  rootKeys?: readonly string[];
  rootFields?: Readonly<Record<string, Check>>;
  /** When set, only these events are parsed; the CLI ignores other event names. */
  events?: readonly string[];
  matcher: Check;
  groupHooksRequired: boolean;
  common: Readonly<Record<string, Check>>;
  handlers: Readonly<Record<string, HandlerSpec>>;
  /** Spec for handler types not listed in `handlers`; absent means unknown types are rejected. */
  otherHandlers?: HandlerSpec;
  /** Health reason when managed entries are in place but CLI loading is not verified. */
  configuredNote?: string;
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const check = (ok: (value: unknown) => boolean, expect: string): Check => ({ ok, expect });
const str = check((v) => typeof v === 'string', 'a string');
const bool = check((v) => typeof v === 'boolean', 'a boolean');
const num = check((v) => typeof v === 'number' && Number.isFinite(v), 'a number');
const positive = check((v) => typeof v === 'number' && Number.isFinite(v) && v > 0, 'a positive number');
const nonNegInt = check((v) => Number.isSafeInteger(v) && (v as number) >= 0, 'a non-negative integer');
const object = check(isJsonObject, 'an object');
const strArray = check((v) => Array.isArray(v) && v.every((item) => typeof item === 'string'), 'an array of strings');
const strRecord = check(
  (v) => isJsonObject(v) && Object.values(v).every((item) => typeof item === 'string'),
  'an object of strings',
);
const nullable = (inner: Check) => check((v) => v === null || inner.ok(v), `${inner.expect} or null`);
const oneOf = (...values: string[]) =>
  check((v) => typeof v === 'string' && values.includes(v), `one of ${values.join(', ')}`);
const hasNull = (v: unknown): boolean =>
  v === null || (typeof v === 'object' && Object.values(v as JsonObject).some((item) => hasNull(item)));
const tomlObject = check((v) => isJsonObject(v) && !hasNull(v), 'an object without null values');
const handler = (required: HandlerSpec['required'], optional: HandlerSpec['optional'] = {}): HandlerSpec => ({
  required,
  optional,
});

/** codex-rs/config/src/hook_config.rs at rust-v0.159.3 (HooksFile, MatcherGroup, HookHandlerConfig). */
const CODEX: HookLoadContract = {
  name: 'Codex CLI 0.159.3',
  rootKeys: ['description', 'hooks'],
  rootFields: { description: nullable(str) },
  events: [
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'PreCompact',
    'PostCompact',
    'SessionStart',
    'SessionEnd',
    'UserPromptSubmit',
    'SubagentStart',
    'SubagentStop',
    'Stop',
    'Interrupt',
  ],
  matcher: nullable(str),
  groupHooksRequired: false,
  common: {},
  handlers: {
    command: handler(
      { command: str },
      {
        commandWindows: nullable(str),
        command_windows: nullable(str),
        timeout: nullable(nonNegInt),
        async: bool,
        statusMessage: nullable(str),
        additionalContextLimit: nullable(nonNegInt),
      },
    ),
    mcp_tool: handler(
      { server: str, tool: str },
      { input: tomlObject, timeout: nullable(nonNegInt), statusMessage: nullable(str) },
    ),
    prompt: handler({}),
    agent: handler({}),
  },
};

/** Claude Code hooks reference plus black-box loading checks against 2.1.286. */
const CLAUDE: HookLoadContract = {
  name: 'Claude Code 2.1.286',
  matcher: str,
  groupHooksRequired: true,
  common: { if: str, timeout: positive, statusMessage: str, once: bool },
  handlers: {
    command: handler(
      { command: str },
      { args: strArray, shell: oneOf('bash', 'powershell'), async: bool, asyncRewake: bool },
    ),
    http: handler({ url: str }, { headers: strRecord, allowedEnvVars: strArray }),
    mcp_tool: handler({ server: str, tool: str }, { input: object }),
    prompt: handler({ prompt: str }, { model: str }),
    agent: handler({ prompt: str }, { model: str }),
  },
};

/**
 * No Gemini CLI loading contract is verified (0.42.0 does not read ~/.gemini/hooks.json; #1565),
 * so only the structure every hook CLI shares is required.
 */
const SHARED: HookLoadContract = {
  name: 'shared hook structure (Gemini loading unverified)',
  matcher: str,
  groupHooksRequired: true,
  common: { timeout: num },
  handlers: { command: handler({ command: str }) },
  otherHandlers: handler({}),
  configuredNote: 'managed entries present; Gemini CLI loading of this file is not verified (#1565)',
};

export const HOOK_LOAD_CONTRACTS = { codex: CODEX, claude: CLAUDE, gemini: SHARED } as const;

function handlerProblem(value: unknown, at: string, contract: HookLoadContract): string | undefined {
  if (!isJsonObject(value) || typeof value.type !== 'string') return `${at} must be an object with a string "type"`;
  const spec = contract.handlers[value.type] ?? contract.otherHandlers;
  if (!spec) return `${at}.type "${value.type}" is not a handler type it loads`;
  for (const [field, rule] of Object.entries(spec.required)) {
    if (!rule.ok(value[field])) return `${at}.${field} is required and must be ${rule.expect}`;
  }
  for (const [field, rule] of Object.entries({ ...contract.common, ...spec.optional })) {
    if (value[field] !== undefined && !rule.ok(value[field])) return `${at}.${field} must be ${rule.expect}`;
  }
  return undefined;
}

function groupProblem(value: unknown, at: string, contract: HookLoadContract): string | undefined {
  if (!isJsonObject(value)) return `${at} must be an object`;
  if (value.matcher !== undefined && !contract.matcher.ok(value.matcher)) {
    return `${at}.matcher must be ${contract.matcher.expect}`;
  }
  if (value.hooks === undefined) return contract.groupHooksRequired ? `${at}.hooks is required` : undefined;
  if (!Array.isArray(value.hooks)) return `${at}.hooks must be an array`;
  for (const [index, entry] of value.hooks.entries()) {
    const problem = handlerProblem(entry, `${at}.hooks[${index}]`, contract);
    if (problem) return problem;
  }
  return undefined;
}

function rootProblem(document: JsonObject, contract: HookLoadContract): string | undefined {
  const unknownRoot = contract.rootKeys && Object.keys(document).find((key) => !contract.rootKeys?.includes(key));
  if (unknownRoot) return `unknown top-level key "${unknownRoot}"`;
  for (const [field, rule] of Object.entries(contract.rootFields ?? {})) {
    if (document[field] !== undefined && !rule.ok(document[field])) return `"${field}" must be ${rule.expect}`;
  }
  return undefined;
}

/** Returns why the CLI would not load `document`, or undefined when every entry is in contract. */
export function hookLoadProblem(document: JsonObject, contract: HookLoadContract): string | undefined {
  const problem = rootProblem(document, contract);
  if (problem) return problem;
  const hooks = document.hooks;
  if (hooks === undefined) return undefined;
  if (!isJsonObject(hooks)) return '"hooks" must be a JSON object';
  for (const [event, groups] of Object.entries(hooks)) {
    if (contract.events && !contract.events.includes(event)) continue;
    if (!Array.isArray(groups)) return `hooks.${event} must be an array`;
    for (const [index, group] of groups.entries()) {
      const problem = groupProblem(group, `hooks.${event}[${index}]`, contract);
      if (problem) return problem;
    }
  }
  return undefined;
}
