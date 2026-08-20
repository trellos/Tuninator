/**
 * The engine-isolation invariant, enforced rather than documented.
 *
 * `src/engine/**` is compiled into three very different hosts — an AudioWorklet
 * (no DOM, no `window`, no module loader beyond what the worklet scope gives
 * it), a Node eval harness, and Vitest. The only reason the offline eval is
 * trustworthy is that all three run the *same* code, which stops being true the
 * moment a file in here reaches for something host-specific.
 *
 * So: no imports outside `src/engine/` except the types-only `src/types.ts`, no
 * DOM or Node globals, no clock reads, and no top-level side effects.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ENGINE_DIR = join(REPO_ROOT, "src", "engine");

function engineFiles(dir = ENGINE_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...engineFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

const FILES = engineFiles();

/** Every module specifier in a source file, from the AST rather than a grep. */
function importSpecifiers(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0] as ts.Node)
    ) {
      out.push((node.arguments[0] as ts.StringLiteral).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Parsed once; every check below walks the same trees. */
const SOURCES = new Map<string, ts.SourceFile>(
  FILES.map((file) => {
    const text = readFileSync(file, "utf8");
    return [file, ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true)];
  })
);

describe("engine isolation", () => {
  it("finds the engine sources", () => {
    expect(FILES.length).toBeGreaterThan(5);
  });

  it("imports nothing outside src/engine except src/types.ts", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const spec of importSpecifiers(SOURCES.get(file) as ts.SourceFile)) {
        if (!spec.startsWith(".")) {
          offenders.push(`${relative(REPO_ROOT, file)} -> ${spec} (bare specifier)`);
          continue;
        }
        const resolved = join(file, "..", spec);
        const inEngine = resolved.startsWith(ENGINE_DIR);
        const isPublicTypes = resolved === join(REPO_ROOT, "src", "types.js");
        if (!inEngine && !isPublicTypes) {
          offenders.push(`${relative(REPO_ROOT, file)} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("imports src/types.ts as types only", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      const re = /^\s*import\s+(?!type\b)[^;]*?from\s*["']([^"']*types\.js)["']/gm;
      if (re.test(source)) offenders.push(relative(REPO_ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  it("touches no host globals", () => {
    // `Date`/`performance` are clock reads; the rest are host objects that do
    // not exist in at least one of the three environments the engine runs in.
    //
    // Checked against the AST rather than the text, because a local named
    // `window` (a Float32Array of window coefficients) or a method named
    // `process` is not a global access, and a grep cannot tell the difference.
    const banned = new Set([
      "window", "document", "navigator", "self", "globalThis", "process",
      "AudioContext", "AudioWorkletNode", "MessagePort", "postMessage",
      "setTimeout", "setInterval", "queueMicrotask", "requestAnimationFrame",
      "Date", "performance", "console", "require", "fetch", "localStorage",
    ]);

    const offenders: string[] = [];
    for (const file of FILES) {
      const sf = SOURCES.get(file) as ts.SourceFile;

      // Anything this file itself declares or names is by definition not a
      // global reference.
      const declared = new Set<string>();
      const collect = (node: ts.Node): void => {
        const named = node as ts.Node & { name?: ts.Node };
        if (named.name && ts.isIdentifier(named.name)) declared.add(named.name.text);
        ts.forEachChild(node, collect);
      };
      collect(sf);

      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && banned.has(node.text) && !declared.has(node.text)) {
          // A property access (`foo.window`) or a property name is not a global.
          const parent = node.parent;
          const isMember =
            parent !== undefined &&
            ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
              (ts.isQualifiedName(parent) && parent.right === node) ||
              (ts.isPropertySignature(parent) && parent.name === node) ||
              (ts.isPropertyAssignment(parent) && parent.name === node));
          if (!isMember) {
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            offenders.push(`${relative(REPO_ROOT, file)}:${line}: ${node.text}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(offenders).toEqual([]);
  });

  it("has no top-level side effects", () => {
    // Anything at column 0 that is not a declaration, an import/export, a
    // comment or a closing brace is executing at module-evaluation time.
    const allowed =
      /^(import|export|const|let|var|function|class|type|interface|enum|declare|abstract|async|\/|\*|\}|\)|\]|;|$)/;
    const offenders: string[] = [];
    for (const file of FILES) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (line.length === 0 || /^\s/.test(line)) return;
        if (allowed.test(line)) return;
        offenders.push(`${relative(REPO_ROOT, file)}:${i + 1}: ${line.slice(0, 60)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
