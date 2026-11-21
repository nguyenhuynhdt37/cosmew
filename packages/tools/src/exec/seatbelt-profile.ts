import {isAbsolute, join, relative} from 'node:path';
import type {CommandSandbox} from '@cosmew/contracts';
import {SECRET_FILE_EXCEPTIONS, SECRET_FILE_RULES, SENSITIVE_HOME_PATHS} from '@cosmew/security';
import type {NativeSandbox} from './native-sandbox';

/**
 * macOS Seatbelt sandbox (ADR 0035), modelled on Codex `sandboxing/src/seatbelt.rs` and its
 * `.sbpl` policies (pinned 75fc67e8). Rules are evaluated in order and the last match wins, so the
 * profile is built from broad allowances first and specific denials last.
 */

/** Regex fragments that match the secret-file name table of the read tool, ignoring case. */
export interface SecretPatterns {
  deny: string[];
  except: string[];
}

export interface SeatbeltOptions {
  /** Only discovered skill directories. Outside-workspace resources are read-only. */
  skillDirectories?: readonly string[];
  /** User skill resources stay read-only even when home is the workspace. */
  readOnlySkillDirectories?: readonly string[];
  /** Canonical workspace root. */
  workspace: string;
  /** Cosmew's state directory; never readable or writable. */
  state?: string;
  /** Private per-runtime directory holding the command's HOME and TMPDIR. */
  scratch: string;
  /** The real home directory: its credential directories and secret-named files are hidden (ADR 0061). */
  home: string;
  /** When set, secret-named project files are hidden too. */
  secrets?: SecretPatterns;
  /** Exact files that are never readable or writable, even inside an exposed toolchain directory. */
  denied?: string[];
  /** Localhost bind/connect (default true); helper services turn it off. */
  loopback?: boolean;
}

/** SBPL regex for an absolute glob (`*` = within a segment, `**` = across segments); matches the path and everything below it. */
export function globToSbplRegex(glob: string): string {
  const body = glob
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map(part =>
      part === '**/'
        ? '(.*/)?'
        : part === '**'
          ? '.*'
          : part === '*'
            ? '[^/]*'
            : part === '?'
              ? '[^/]'
              : escapeRegex(part),
    )
    .join('');
  return `^${body}(/.*)?$`;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive regex for a literal text, e.g. `.env` → `[.][eE][nN][vV]`. */
const caseInsensitive = (text: string) =>
  [...text].map(ch => (/[a-z]/i.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : escapeRegex(ch))).join('');

const quote = (text: string) => JSON.stringify(text);
const subpath = (path: string) => `(subpath ${quote(path)})`;

export function secretPatterns(): SecretPatterns {
  const deny = SECRET_FILE_RULES.map(rule => {
    const name = caseInsensitive(rule.value);
    if (rule.match === 'exact') return `/${name}$`;
    if (rule.match === 'prefix') return `/${name}[^/]${rule.value.endsWith('.') ? '+' : '*'}$`;
    return `${name}$`;
  });
  const except = SECRET_FILE_EXCEPTIONS.map(name => `/${caseInsensitive(name)}$`);
  return {deny, except};
}

/** Codex `seatbelt_base_policy.sbpl` sysctl allow-list. */
const SYSCTL_NAMES = [
  'hw.activecpu',
  'hw.busfrequency_compat',
  'hw.byteorder',
  'hw.cacheconfig',
  'hw.cachelinesize_compat',
  'hw.cpufamily',
  'hw.cpufrequency_compat',
  'hw.cputype',
  'hw.l1dcachesize_compat',
  'hw.l1icachesize_compat',
  'hw.l2cachesize_compat',
  'hw.l3cachesize_compat',
  'hw.logicalcpu_max',
  'hw.machine',
  'hw.model',
  'hw.memsize',
  'hw.ncpu',
  'hw.nperflevels',
  'hw.packages',
  'hw.pagesize_compat',
  'hw.pagesize',
  'hw.physicalcpu',
  'hw.physicalcpu_max',
  'hw.logicalcpu',
  'hw.cpufrequency',
  'hw.tbfrequency_compat',
  'hw.vectorunit',
  'machdep.cpu.brand_string',
  'kern.argmax',
  'kern.hostname',
  'kern.maxfilesperproc',
  'kern.maxproc',
  'kern.osproductversion',
  'kern.osrelease',
  'kern.ostype',
  'kern.osvariant_status',
  'kern.osversion',
  'kern.secure_kernel',
  'kern.sysv.semmns',
  'kern.usrstack64',
  'kern.version',
  'sysctl.proc_cputype',
  'vm.loadavg',
];
const SYSCTL_PREFIXES = [
  'hw.optional.arm.',
  'hw.optional.armv8_',
  'hw.perflevel',
  'kern.proc.pgrp.',
  'kern.proc.pid.',
  'net.routetable.',
];

/**
 * Mach services every command may use (Codex base + preferences policy, plus dirhelper for temp
 * dirs). `com.apple.FSEvents` is not in Codex's pinned policy; file watchers (Turbopack, Vite,
 * watchman) die with "unable to start FSEvent stream" without it. The service reports file-system
 * events of paths the process may already read; it grants no read or write itself (ADR 0053).
 */
const BASE_MACH_SERVICES = [
  'com.apple.FSEvents',
  'com.apple.system.opendirectoryd.libinfo',
  'com.apple.bsd.dirhelper',
  'com.apple.PowerManagement.control',
  'com.apple.cfprefsd.daemon',
  'com.apple.cfprefsd.agent',
];

/** Mach services needed for networking (Codex `seatbelt_network_policy.sbpl`); only with approval. */
const NETWORK_MACH_SERVICES = [
  'com.apple.bsd.dirhelper',
  'com.apple.system.opendirectoryd.membership',
  'com.apple.SecurityServer',
  'com.apple.networkd',
  'com.apple.ocspd',
  'com.apple.trustd.agent',
  'com.apple.SystemConfiguration.DNSConfiguration',
  'com.apple.SystemConfiguration.configd',
  'com.apple.dnssd.service',
];

const globalNames = (services: string[]) => services.map(name => `(global-name ${quote(name)})`).join(' ');

export class SeatbeltSandbox implements NativeSandbox {
  readonly name = 'macos-seatbelt' as const;
  readonly containsDescendants = false;

  constructor(private readonly options: SeatbeltOptions) {}

  wrap(argv: string[], sandbox: CommandSandbox): string[] {
    return ['/usr/bin/sandbox-exec', '-p', this.profile(sandbox), ...argv];
  }

  profile(sandbox: CommandSandbox): string {
    return [
      '(version 1)',
      '(deny default)',
      ...this.processRules(sandbox),
      ...this.terminalRules(),
      '(allow file-read*)',
      ...this.writeRules(sandbox),
      ...this.protectedPathRules(sandbox),
      ...this.networkRules(sandbox),
    ].join('\n');
  }

  /**
   * Processes, signals and system services. There is no blanket `mach-lookup`: LaunchServices,
   * AppleEvents and the pasteboard (e.g. `open -a`) could otherwise start programs outside the sandbox.
   */
  private processRules(sandbox: CommandSandbox): string[] {
    const sysctls = [
      ...SYSCTL_NAMES.map(name => `(sysctl-name ${quote(name)})`),
      ...SYSCTL_PREFIXES.map(prefix => `(sysctl-name-prefix ${quote(prefix)})`),
    ].join(' ');
    return [
      '(allow process-exec process-fork)',
      '(allow signal (target same-sandbox))',
      '(allow process-info* (target same-sandbox))',
      `(allow sysctl-read ${sysctls})`,
      '(allow sysctl-write (sysctl-name "kern.grade_cputype"))',
      '(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))',
      // TLS trust and proxy configuration need these Mach services; they carry no network access of their own.
      `(allow mach-lookup ${globalNames(sandbox.proxyUrl ? [...BASE_MACH_SERVICES, ...NETWORK_MACH_SERVICES] : BASE_MACH_SERVICES)} (local-name "com.apple.cfprefsd.agent"))`,
      '(allow ipc-posix-sem)',
      '(allow ipc-posix-shm-read-data ipc-posix-shm-write-create ipc-posix-shm-write-unlink (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$"))',
      '(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs."))',
      '(allow user-preference-read)',
    ];
  }

  /** Only the session's own PTY (sandbox extension) and /dev/tty; ioctl works on inherited fds. */
  private terminalRules(): string[] {
    return [
      '(allow pseudo-tty)',
      '(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))',
      '(allow file-read* file-write* (require-all (regex #"^/dev/ttys[0-9]+") (extension "com.apple.sandbox.pty")))',
      '(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))',
    ];
  }

  /**
   * Private temp/home always; in workspace-write also the workspace and `additionalDirectories`
   * (never their `.git`). There is no other writable location (ADR 0061).
   */
  private writeRules(sandbox: CommandSandbox): string[] {
    const {workspace, scratch} = this.options;
    const rules = [
      `(allow file-write* ${subpath(join(scratch, 'tmp'))} ${subpath(join(scratch, 'home'))} (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`,
    ];
    if (sandbox.mode === 'workspace-write') {
      const roots = this.writableRoots(sandbox);
      rules.push(`(allow file-write* ${roots.map(subpath).join(' ')})`);
      // Codex forbids only WRITING `.git`; reading it stays allowed (git status, next build).
      for (const root of roots)
        rules.push(`(deny file-write* (regex #"^${escapeRegex(root)}/(.*/)?\\.[gG][iI][tT](/|$)"))`);
    }
    void workspace;
    return rules;
  }

  private writableRoots(sandbox: CommandSandbox): string[] {
    return [...new Set([this.options.workspace, ...(sandbox.writableRoots ?? [])])];
  }

  private skillRules(): string[] {
    return (this.options.skillDirectories ?? []).flatMap(directory => [
      `(allow file-read-metadata (path-ancestors ${quote(directory)}))`,
      `(allow file-read* ${subpath(directory)})`,
      ...(this.options.readOnlySkillDirectories?.includes(directory) ||
      relative(this.options.workspace, directory).startsWith('..') ||
      isAbsolute(relative(this.options.workspace, directory))
        ? [`(deny file-write* ${subpath(directory)})`]
        : []),
    ]);
  }

  /**
   * Denied last so they win: Cosmew state and settings inside any writable root, the sensitive
   * home list, secret-named files under home (and in the project when hidden), the user's deny
   * rules. `.git/config` stays readable because git cannot run without it (as in Codex); URL
   * credentials are redacted from output instead.
   */
  private protectedPathRules(sandbox: CommandSandbox): string[] {
    const {workspace, state, secrets, denied, home} = this.options;
    const ws = escapeRegex(workspace);
    const rules: string[] = [];
    for (const root of this.writableRoots(sandbox)) {
      const r = escapeRegex(root);
      rules.push(
        `(deny file-read* file-write* (regex #"^${r}/(.*/)?\\.(futryn|hannes)(/|$)") (regex #"^${r}/(.*/)?\\.(futryn|hannes)-patch-"))`,
      );
    }
    rules.push(...this.skillRules());
    if (state) {
      const skillExceptions = (this.options.skillDirectories ?? []).filter(directory =>
        directory.startsWith(join(state, 'skills') + '/'),
      );
      if (skillExceptions.length) {
        rules.push(`(deny file-write* ${subpath(state)})`);
        rules.push(
          `(deny file-read* (require-all ${subpath(state)} ${skillExceptions.map(directory => `(require-not ${subpath(directory)})`).join(' ')}))`,
        );
      } else rules.push(`(deny file-read* file-write* ${subpath(state)})`);
    }
    // The default sensitive list. A workspace that lives inside one of these (a repository under
    // ~/.claude, say) is the user's explicit choice and stays reachable.
    const sensitive = SENSITIVE_HOME_PATHS.map(path => join(home, path)).filter(
      path => !(workspace === path || workspace.startsWith(path + '/')),
    );
    rules.push(`(deny file-read* file-write* ${sensitive.map(subpath).join(' ')})`);
    if (denied?.length)
      rules.push(`(deny file-read* file-write* ${denied.map(path => `(literal ${quote(path)})`).join(' ')})`);
    // Secret-named files (.env, *.pem, id_rsa, .npmrc ...) anywhere under home except the project:
    // dev tools read the project's own `.env` themselves, so that one is hidden only on request.
    const names = secretPatterns();
    const homeRegex = escapeRegex(home);
    const exceptions = names.except.map(r => `(require-not (regex #"${r}"))`).join(' ');
    rules.push(
      `(deny file-read* file-write* (require-all (regex #"^${homeRegex}/") (require-not ${subpath(workspace)}) (require-any ${names.deny.map(r => `(regex #"${r}")`).join(' ')}) ${exceptions}))`,
    );
    if (secrets) {
      const projectNames = secrets.deny.map(r => `(regex #"${r}")`).join(' ');
      const projectExceptions = secrets.except.map(r => `(require-not (regex #"${r}"))`).join(' ');
      rules.push(
        `(deny file-read* file-write* (require-all (regex #"^${ws}/") (require-any ${projectNames}) ${projectExceptions}))`,
      );
    }
    const denyRead = sandbox.denyRead ?? [];
    if (denyRead.length)
      rules.push(
        `(deny file-read* file-write* ${denyRead.map(glob => `(regex #"${globToSbplRegex(glob)}")`).join(' ')})`,
      );
    const denyWrite = sandbox.denyWrite ?? [];
    if (denyWrite.length)
      rules.push(`(deny file-write* ${denyWrite.map(glob => `(regex #"${globToSbplRegex(glob)}")`).join(' ')})`);
    return rules;
  }

  /**
   * Only the local machine is reachable: binding any local address (a dev server listens on
   * 0.0.0.0 by default) and traffic to and from localhost, exactly the three rules Codex emits for
   * `allow_local_binding` (`sandboxing/src/seatbelt.rs`, pinned 090be4df). Inbound is limited to
   * localhost, so a bound port is not reachable from other hosts. The Cosmew proxy listens on
   * loopback, so a command reaches external hosts only through it (ADR 0061); there is no rule that
   * opens the network.
   */
  private networkRules(_sandbox: CommandSandbox): string[] {
    if (this.options.loopback === false) return ['(deny network*)'];
    return [
      '(deny network*)',
      '(allow network-bind (local ip "*:*"))',
      '(allow network-inbound (local ip "localhost:*"))',
      '(allow network-outbound (remote ip "localhost:*"))',
    ];
  }
}
