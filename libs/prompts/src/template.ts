import { PromptTemplateError, PromptVariableError } from './errors.js';

/**
 * The deliberately small template language of §17: `{{var}}` and one level of
 * `{{#if var}}…{{else}}…{{/if}}`. Nothing else. A richer language would invite logic into
 * prompt files; anything more complex belongs in code that builds the variable's value.
 *
 * Rendering is a single pass over a parsed tree, so a value that itself contains `{{` is never
 * re-interpreted. It is caught afterwards by the leftover check instead.
 */
export type TemplateNode =
  | { kind: 'text'; text: string }
  | { kind: 'var'; name: string }
  | { kind: 'if'; name: string; then: TemplateNode[]; else: TemplateNode[] };

export type PromptValue = string | number | boolean;
export type PromptVars = Readonly<Record<string, PromptValue>>;

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const TAG = new RegExp(`\\{\\{(?:#if (${IDENT})|(else)|(/if)|(${IDENT}))\\}\\}`, 'g');
/** A block tag alone on its line is removed with its line break, so YAML stays readable. */
const STANDALONE_BLOCK = new RegExp(
  `^[ \\t]*(\\{\\{(?:#if ${IDENT}|else|/if)\\}\\})[ \\t]*\\r?\\n`,
  'gm',
);

interface OpenIf {
  node: Extract<TemplateNode, { kind: 'if' }>;
  inElse: boolean;
}

/** Parse a template, rejecting nested, unbalanced or malformed tags. */
export function parseTemplate(promptId: string, source: string): TemplateNode[] {
  const text = source.replace(STANDALONE_BLOCK, '$1');
  const root: TemplateNode[] = [];
  let open: OpenIf | undefined;
  let last = 0;
  const target = (): TemplateNode[] =>
    open === undefined ? root : open.inElse ? open.node.else : open.node.then;

  for (const m of text.matchAll(TAG)) {
    pushText(target(), text.slice(last, m.index));
    last = m.index + m[0].length;
    const [, ifName, elseTag, endTag, varName] = m;
    if (ifName !== undefined) {
      if (open !== undefined) {
        throw new PromptTemplateError(promptId, `nested {{#if ${ifName}}} is not supported`);
      }
      const node: OpenIf['node'] = { kind: 'if', name: ifName, then: [], else: [] };
      root.push(node);
      open = { node, inElse: false };
    } else if (elseTag !== undefined) {
      if (open === undefined || open.inElse) {
        throw new PromptTemplateError(promptId, '{{else}} without a matching {{#if}}');
      }
      open.inElse = true;
    } else if (endTag !== undefined) {
      if (open === undefined) throw new PromptTemplateError(promptId, '{{/if}} without {{#if}}');
      open = undefined;
    } else if (varName !== undefined) {
      target().push({ kind: 'var', name: varName });
    }
  }
  pushText(target(), text.slice(last));
  if (open !== undefined) {
    throw new PromptTemplateError(promptId, `{{#if ${open.node.name}}} is never closed`);
  }
  assertNoLeftover(promptId, root, 'template');
  return root;
}

function pushText(nodes: TemplateNode[], text: string): void {
  if (text.length > 0) nodes.push({ kind: 'text', text });
}

/** Every variable a parsed template references, in first-use order. */
export function templateVariables(nodes: readonly TemplateNode[]): string[] {
  const seen = new Set<string>();
  const walk = (list: readonly TemplateNode[]): void => {
    for (const n of list) {
      if (n.kind === 'var') seen.add(n.name);
      if (n.kind === 'if') {
        seen.add(n.name);
        walk(n.then);
        walk(n.else);
      }
    }
  };
  walk(nodes);
  return [...seen];
}

/**
 * Render a parsed template. The caller has already checked that `vars` holds exactly the
 * declared variables; this still refuses an absent one rather than printing `undefined`.
 */
export function renderTemplate(
  promptId: string,
  nodes: readonly TemplateNode[],
  vars: PromptVars,
): string {
  let out = '';
  for (const n of nodes) {
    if (n.kind === 'text') out += n.text;
    else if (n.kind === 'var') out += interpolate(promptId, n.name, vars);
    else
      out += renderTemplate(
        promptId,
        truthy(lookup(promptId, n.name, vars)) ? n.then : n.else,
        vars,
      );
  }
  return out;
}

function lookup(promptId: string, name: string, vars: PromptVars): PromptValue {
  const value = Object.hasOwn(vars, name) ? vars[name] : undefined;
  if (value === undefined) {
    throw new PromptVariableError(promptId, [name], `missing variable: ${name}`);
  }
  return value;
}

function interpolate(promptId: string, name: string, vars: PromptVars): string {
  const value = lookup(promptId, name, vars);
  if (typeof value === 'boolean') {
    throw new PromptVariableError(
      promptId,
      [name],
      `variable ${name} is a boolean; use it in {{#if ${name}}}, not as text`,
    );
  }
  return String(value);
}

/** Empty string, `false` and `0` are falsy; everything else is truthy. */
function truthy(value: PromptValue): boolean {
  return typeof value === 'string' ? value.length > 0 : Boolean(value);
}

/** Leftover `{{` in text means a malformed tag, or a value that smuggled braces in. */
export function assertNoLeftover(
  promptId: string,
  nodes: readonly TemplateNode[] | string,
  where: string,
): void {
  const text = typeof nodes === 'string' ? nodes : textOf(nodes);
  const at = text.indexOf('{{');
  if (at >= 0) {
    const snippet = text.slice(at, at + 30).replace(/\n/g, '\\n');
    throw new PromptTemplateError(promptId, `${where} contains an unrendered "{{": ${snippet}`);
  }
}

function textOf(nodes: readonly TemplateNode[]): string {
  return nodes
    .map((n) =>
      n.kind === 'text' ? n.text : n.kind === 'if' ? textOf(n.then) + textOf(n.else) : '',
    )
    .join('\n');
}
