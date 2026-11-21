import {existsSync, readFileSync, statSync} from 'node:fs';
import {dirname, extname, isAbsolute, join, relative} from 'node:path';

/**
 * Language servers Cosmew can use (ADR 0043): four languages, one table row each, after OpenCode
 * v1.19.5 `packages/opencode/src/lsp/server.ts` (read 2026-11-17). Nothing is downloaded or
 * installed: a server is the project's own `node_modules/.bin` entry or an absolute program on
 * PATH outside the workspace, and it always runs inside the command sandbox (read-only, no network).
 */
export interface ServerSpec {
  id: 'typescript' | 'python' | 'go' | 'rust';
  extensions: string[];
  /** Files that mark a project root, nearest first. */
  roots: string[];
  /** LSP languageId per extension. */
  languageId(extension: string): string;
  /** Candidate command lines, in preference order; `bin:` = project node_modules/.bin, `path:` = PATH. */
  commands(rootAbsolute: string, workspaceRoot: string): string[][];
  /** How to install it, shown when nothing is found. */
  install: string;
}

const nodeBin = (root: string, workspace: string, name: string): string | null => {
  for (let dir = root; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', '.bin', name);
    if (existsSync(candidate)) return candidate;
    if (dir === workspace || dir === dirname(dir) || relative(workspace, dir).startsWith('..')) return null;
  }
};

/** An absolute program on PATH that is not inside the workspace (a repository cannot plant it). */
export function trustedPathProgram(name: string, workspaceRoot: string): string | null {
  const found = Bun.which(name);
  if (!found || !isAbsolute(found)) return null;
  const rel = relative(workspaceRoot, found);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? null : found;
}

function typescriptMajor(root: string, workspace: string): number | null {
  for (let dir = root; ; dir = dirname(dir)) {
    const manifest = join(dir, 'node_modules', 'typescript', 'package.json');
    if (existsSync(manifest)) {
      try {
        return Number(
          String((JSON.parse(readFileSync(manifest, 'utf8')) as {version?: unknown}).version).split('.')[0],
        );
      } catch {
        return null;
      }
    }
    if (dir === workspace || dir === dirname(dir)) return null;
  }
}

export const SERVERS: readonly ServerSpec[] = [
  {
    id: 'typescript',
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    roots: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    languageId: ext =>
      ext === '.tsx'
        ? 'typescriptreact'
        : ext === '.jsx'
          ? 'javascriptreact'
          : /\.[mc]?js$/.test(ext)
            ? 'javascript'
            : 'typescript',
    commands(root, workspace) {
      const out: string[][] = [];
      // TypeScript 7 (native) ships its own language server: `tsc --lsp --stdio`.
      const tsc = nodeBin(root, workspace, 'tsc');
      if (tsc && (typescriptMajor(root, workspace) ?? 0) >= 7) out.push([tsc, '--lsp', '--stdio']);
      const local = nodeBin(root, workspace, 'typescript-language-server');
      if (local) out.push([local, '--stdio']);
      const global = trustedPathProgram('typescript-language-server', workspace);
      if (global) out.push([global, '--stdio']);
      return out;
    },
    install: 'npm i -D typescript-language-server typescript (or TypeScript >= 7, which provides `tsc --lsp`)',
  },
  {
    id: 'python',
    extensions: ['.py', '.pyi'],
    roots: ['pyproject.toml', 'pyrightconfig.json', 'setup.py', 'setup.cfg', 'requirements.txt'],
    languageId: () => 'python',
    commands(root, workspace) {
      const out: string[][] = [];
      for (const name of ['basedpyright-langserver', 'pyright-langserver']) {
        const local = nodeBin(root, workspace, name);
        if (local) out.push([local, '--stdio']);
        const global = trustedPathProgram(name, workspace);
        if (global) out.push([global, '--stdio']);
      }
      return out;
    },
    install: 'pip install basedpyright (or npm i -g pyright)',
  },
  {
    id: 'go',
    extensions: ['.go'],
    roots: ['go.mod', 'go.work'],
    languageId: () => 'go',
    commands(_root, workspace) {
      const gopls = trustedPathProgram('gopls', workspace);
      return gopls ? [[gopls]] : [];
    },
    install: 'go install golang.org/x/tools/gopls@latest',
  },
  {
    id: 'rust',
    extensions: ['.rs'],
    roots: ['Cargo.toml'],
    languageId: () => 'rust',
    commands(_root, workspace) {
      const ra = trustedPathProgram('rust-analyzer', workspace);
      return ra ? [[ra]] : [];
    },
    install: 'rustup component add rust-analyzer',
  },
];

export function specFor(path: string, servers: readonly ServerSpec[] = SERVERS): ServerSpec | null {
  const ext = extname(path).toLowerCase();
  return servers.find(spec => spec.extensions.includes(ext)) ?? null;
}

/** Nearest directory (from the file up to the workspace root) holding one of the spec's root markers. */
export function projectRoot(fileAbsolute: string, workspaceRoot: string, spec: ServerSpec): string {
  for (let dir = dirname(fileAbsolute); ; dir = dirname(dir)) {
    if (spec.roots.some(marker => existsSync(join(dir, marker)) && statSync(join(dir, marker)).isFile())) return dir;
    if (dir === workspaceRoot || dir === dirname(dir) || relative(workspaceRoot, dir).startsWith('..'))
      return workspaceRoot;
  }
}
