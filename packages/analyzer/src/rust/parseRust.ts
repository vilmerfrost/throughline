import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';

// Tree-sitter setup for Rust. We use the WASM binding (web-tree-sitter) plus the
// prebuilt `tree-sitter-rust.wasm` grammar rather than the native bindings: the
// native `tree-sitter` package has no prebuilt for current Node and needs a
// node-gyp toolchain to compile, while the WASM grammar is ABI-independent and
// loads everywhere the analyzer runs.

const require = createRequire(import.meta.url);
const RUST_WASM = require.resolve('tree-sitter-wasms/out/tree-sitter-rust.wasm');

let parserPromise: Promise<Parser> | null = null;

// One initialized parser, reused across files. tree-sitter parsing is synchronous
// once the grammar is loaded; only the initial WASM init is async.
async function getParser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      await Parser.init();
      const rust = await Parser.Language.load(RUST_WASM);
      const parser = new Parser();
      parser.setLanguage(rust);
      return parser;
    })();
  }
  return parserPromise;
}

// Parse a Rust source string into a tree. The root node is `source_file`.
export async function parseRustSource(code: string): Promise<Parser.Tree> {
  const parser = await getParser();
  return parser.parse(code);
}

export type RustNode = Parser.SyntaxNode;
