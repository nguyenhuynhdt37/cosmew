import {existsSync, readFileSync, realpathSync, statSync} from 'node:fs';
import {dirname, extname, isAbsolute, join, relative} from 'node:path';

/**
 * Language servers Cosmew can use (ADR 0043, ADR 0124): built-in presets plus optional user-declared
 * servers from `~/.cosmew/config.toml` `[lsp.<id>]`. Nothing is downloaded or installed: a server is
 * the project's own `node_modules/.bin` entry (JS/TS/Python) or an absolute program on PATH outside
 * the workspace, and it always runs inside the command sandbox (read-only, no network).
 */
export interface ServerSpec {
  id: string;
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

/** User-level custom LSP server entry declared under `[lsp.<id>]` in `~/.cosmew/config.toml` (ADR 0124). */
export interface CustomLspServerConfig {
  id: string;
  extensions: string[];
  roots: string[];
  command: string;
  args: string[];
  languageId?: string;
}

function isInsideWorkspace(target: string, workspaceRoot: string): boolean {
  let canonicalWorkspace = workspaceRoot;
  let canonicalTarget = target;
  try {
    canonicalWorkspace = realpathSync.native(workspaceRoot);
  } catch {
    /* keep logical root */
  }
  try {
    canonicalTarget = realpathSync.native(target);
  } catch {
    /* keep raw path */
  }
  for (const [root, candidate] of [
    [workspaceRoot, target],
    [canonicalWorkspace, canonicalTarget],
  ] as const) {
    const rel = relative(root, candidate);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return true;
  }
  return false;
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
  if (!name || /[/\\]/.test(name)) return null;
  const found = Bun.which(name);
  if (!found || !isAbsolute(found)) return null;
  if (isInsideWorkspace(found, workspaceRoot)) return null;
  return found;
}

/** Resolve either a bare PATH program or an explicit absolute binary, always outside the workspace. */
export function trustedServerProgram(program: string, workspaceRoot: string): string | null {
  if (!program || /[\x00-\x1f\x7f]/.test(program)) return null;
  if (isAbsolute(program)) {
    try {
      if (!statSync(program).isFile()) return null;
    } catch {
      return null;
    }
    return isInsideWorkspace(program, workspaceRoot) ? null : program;
  }
  return trustedPathProgram(program, workspaceRoot);
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
  {
    id: 'cpp',
    extensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'],
    roots: ['compile_commands.json', 'CMakeLists.txt', 'meson.build', 'Makefile'],
    languageId: ext => (ext === '.c' || ext === '.h' ? 'c' : 'cpp'),
    commands(_root, workspace) {
      const clangd = trustedPathProgram('clangd', workspace);
      return clangd ? [[clangd]] : [];
    },
    install: 'brew install llvm (or apt install clangd)',
  },
  {
    id: 'java',
    extensions: ['.java'],
    roots: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'],
    languageId: () => 'java',
    commands(_root, workspace) {
      const jdtls = trustedPathProgram('jdtls', workspace);
      return jdtls ? [[jdtls]] : [];
    },
    install: 'brew install jdtls (or install Eclipse JDT Language Server)',
  },
  {
    id: 'csharp',
    extensions: ['.cs'],
    roots: ['global.json', 'Directory.Build.props', 'Directory.Packages.props'],
    languageId: () => 'csharp',
    commands(_root, workspace) {
      const out: string[][] = [];
      const csharpLs = trustedPathProgram('csharp-ls', workspace);
      if (csharpLs) out.push([csharpLs]);
      const omnisharp = trustedPathProgram('OmniSharp', workspace) ?? trustedPathProgram('omnisharp', workspace);
      if (omnisharp) out.push([omnisharp, '--languageserver']);
      return out;
    },
    install: 'dotnet tool install --global csharp-ls',
  },
  {
    id: 'php',
    extensions: ['.php'],
    roots: ['composer.json'],
    languageId: () => 'php',
    commands(_root, workspace) {
      const intelephense = trustedPathProgram('intelephense', workspace);
      return intelephense ? [[intelephense, '--stdio']] : [];
    },
    install: 'npm i -g intelephense',
  },
  {
    id: 'ruby',
    extensions: ['.rb', '.rake', '.gemspec'],
    roots: ['Gemfile', 'Rakefile', '.ruby-version'],
    languageId: () => 'ruby',
    commands(_root, workspace) {
      const out: string[][] = [];
      const rubyLsp = trustedPathProgram('ruby-lsp', workspace);
      if (rubyLsp) out.push([rubyLsp]);
      const solargraph = trustedPathProgram('solargraph', workspace);
      if (solargraph) out.push([solargraph, 'stdio']);
      return out;
    },
    install: 'gem install ruby-lsp (or gem install solargraph)',
  },
  {
    id: 'swift',
    extensions: ['.swift'],
    roots: ['Package.swift'],
    languageId: () => 'swift',
    commands(_root, workspace) {
      const sourcekit = trustedPathProgram('sourcekit-lsp', workspace);
      return sourcekit ? [[sourcekit]] : [];
    },
    install: 'Install Xcode Command Line Tools or Swift toolchain (includes sourcekit-lsp)',
  },
  {
    id: 'kotlin',
    extensions: ['.kt', '.kts'],
    roots: ['build.gradle.kts', 'build.gradle', 'settings.gradle.kts'],
    languageId: () => 'kotlin',
    commands(_root, workspace) {
      const kls = trustedPathProgram('kotlin-language-server', workspace);
      return kls ? [[kls]] : [];
    },
    install: 'brew install kotlin-language-server',
  },
  {
    id: 'yaml',
    extensions: ['.yaml', '.yml'],
    roots: ['.git', 'package.json'],
    languageId: () => 'yaml',
    commands(_root, workspace) {
      const yls = trustedPathProgram('yaml-language-server', workspace);
      return yls ? [[yls, '--stdio']] : [];
    },
    install: 'npm i -g yaml-language-server',
  },
  {
    id: 'json',
    extensions: ['.json', '.jsonc'],
    roots: ['package.json', 'tsconfig.json'],
    languageId: ext => (ext === '.jsonc' ? 'jsonc' : 'json'),
    commands(_root, workspace) {
      const jls = trustedPathProgram('vscode-json-language-server', workspace);
      return jls ? [[jls, '--stdio']] : [];
    },
    install: 'npm i -g vscode-langservers-extracted',
  },
];

/** Combine user-declared `[lsp.<id>]` specs (user config only) with built-in presets; user overrides matching ids. */
export function buildServerSpecs(custom: readonly CustomLspServerConfig[] = []): readonly ServerSpec[] {
  if (!custom.length) return SERVERS;
  const userSpecs: ServerSpec[] = custom.map(entry => ({
    id: entry.id,
    extensions: entry.extensions.map(ext => ext.toLowerCase()),
    roots: [...entry.roots],
    languageId: () => entry.languageId ?? entry.id,
    commands(_root, workspace) {
      const bin = trustedServerProgram(entry.command, workspace);
      return bin ? [[bin, ...entry.args]] : [];
    },
    install: `Install "${entry.command}" outside the workspace or update [lsp.${entry.id}] in ~/.cosmew/config.toml`,
  }));
  const overridden = new Set(userSpecs.map(spec => spec.id));
  return [...userSpecs, ...SERVERS.filter(spec => !overridden.has(spec.id))];
}

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
