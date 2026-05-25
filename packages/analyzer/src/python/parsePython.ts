import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';

// Tree-sitter setup for Python. Same WASM strategy as `parseRust.ts`: avoid the
// native node-gyp dance and use `tree-sitter-wasms`. One initialized parser is
// reused across files.

const require = createRequire(import.meta.url);
const PY_WASM = require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm');

let parserPromise: Promise<Parser> | null = null;

async function getParser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      await Parser.init();
      const py = await Parser.Language.load(PY_WASM);
      const parser = new Parser();
      parser.setLanguage(py);
      return parser;
    })();
  }
  return parserPromise;
}

export async function parsePythonSource(code: string): Promise<Parser.Tree> {
  const parser = await getParser();
  return parser.parse(code);
}

export type PyNode = Parser.SyntaxNode;
