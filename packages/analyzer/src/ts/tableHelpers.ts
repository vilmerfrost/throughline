import path from 'node:path';
import {
  Node,
  SyntaxKind,
  type CallExpression,
  type FunctionDeclaration,
  type Identifier,
  type Project,
  type SourceFile,
  type Symbol as TsSymbol,
} from 'ts-morph';
import type { SourceRef, TableHelperAlias } from '@throughline/core';
import { classifySourceScope } from '../sourceScope.js';

interface HelperInfo {
  functionName: string;
  table: string;
  requiresTypedClient: boolean;
  source: SourceRef;
  sourceScope: TableHelperAlias['sourceScope'];
}

export interface TableAccess {
  rootCall: CallExpression;
  table: string;
  bypass: boolean;
  typedClientCall?: CallExpression;
  alias?: TableHelperAlias;
}

export function collectTableHelperAliases(
  project: Project,
  repoPath: string,
  knownTables: Set<string>,
  isTypedClient: (fromCall: CallExpression) => boolean,
  resolveTableName: (arg: Node | undefined) => { name?: string; bypass: boolean },
): Map<string, TableHelperAlias> {
  const aliases = new Map<string, TableHelperAlias>();
  for (const sf of project.getSourceFiles()) {
    for (const fn of sf.getFunctions()) {
      const info = tableHelperFromFunction(fn, repoPath, knownTables, isTypedClient, resolveTableName);
      if (info) aliases.set(info.functionName, info);
    }
  }
  return aliases;
}

export function findTableAccesses(
  sf: SourceFile,
  aliases: Map<string, TableHelperAlias>,
  resolveTableName: (arg: Node | undefined) => { name?: string; bypass: boolean },
): TableAccess[] {
  const out: TableAccess[] = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (Node.isPropertyAccessExpression(expr) && expr.getName() === 'from') {
      const table = resolveTableName(call.getArguments()[0]);
      if (table.name) out.push({ rootCall: call, table: table.name, bypass: table.bypass });
      continue;
    }

    if (Node.isIdentifier(expr)) {
      const alias = resolveAlias(expr, aliases);
      if (!alias) continue;
      out.push({ rootCall: call, table: alias.table, bypass: false, typedClientCall: call, alias });
    }
  }
  return out;
}

function resolveAlias(expr: Identifier, aliases: Map<string, TableHelperAlias>): TableHelperAlias | undefined {
  const direct = aliases.get(expr.getText());
  if (direct) return direct;

  const decls = symbolDeclarations(expr.getSymbol());
  for (const alias of aliases.values()) {
    if (
      decls.some(
        (decl) =>
          Node.isFunctionDeclaration(decl) &&
          decl.getName() === alias.functionName &&
          decl.getStartLineNumber() === alias.source.startLine,
      )
    ) {
      return alias;
    }
  }
  return undefined;
}

function tableHelperFromFunction(
  fn: FunctionDeclaration,
  repoPath: string,
  knownTables: Set<string>,
  isTypedClient: (fromCall: CallExpression) => boolean,
  resolveTableName: (arg: Node | undefined) => { name?: string; bypass: boolean },
): HelperInfo | undefined {
  const name = fn.getName();
  if (!name) return undefined;

  const returns = fn.getDescendantsOfKind(SyntaxKind.ReturnStatement);
  if (returns.length !== 1) return undefined;
  const expr = returns[0].getExpression();
  if (!expr || !Node.isCallExpression(expr)) return undefined;

  const callee = expr.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'from') return undefined;
  const table = resolveTableName(expr.getArguments()[0]);
  if (!table.name || table.bypass || !knownTables.has(table.name)) return undefined;

  const source = refFrom(fn, repoPath);
  return {
    functionName: name,
    table: table.name,
    requiresTypedClient: isTypedClient(expr),
    source,
    sourceScope: classifySourceScope(source.filePath),
  };
}

function refFrom(node: Node, repoPath: string): SourceRef {
  const sf = node.getSourceFile();
  const indent = sf.getFullText().slice(node.getStartLinePos(), node.getStart());
  const snippet = /^\s*$/.test(indent) ? indent + node.getText() : node.getText();
  return {
    language: 'typescript',
    filePath: path.relative(repoPath, sf.getFilePath()),
    startLine: node.getStartLineNumber(),
    endLine: node.getEndLineNumber(),
    snippet,
  };
}

function symbolDeclarations(sym: TsSymbol | undefined): Node[] {
  if (!sym) return [];
  const out: Node[] = [...(sym.getDeclarations() ?? [])];
  try {
    const aliased = sym.getAliasedSymbol();
    if (aliased) out.push(...(aliased.getDeclarations() ?? []));
  } catch {
    // Not an alias.
  }
  return out;
}
