import {dirname, join} from 'node:path';
import type {CommandSandbox} from '@futryn/contracts';
import {SECRET_FILE_EXCEPTIONS, SECRET_FILE_RULES} from '@futryn/security';
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
  /** Canonical workspace root. */
  workspace: string;
  /** Futryn's state directory; never readable or writable. */
  state?: string;
  /** Private per-runtime directory holding the command's HOME and TMPDIR. */
  scratch: string;
  /** The real home directory; hidden except the workspace and toolchains. */
  home: string;
  /** Toolchain directories under home that stay readable (from PATH). */
  toolchains: string[];
  /** When set, secret-named project files are hidden too. */
  secrets?: SecretPatterns;
  /** Exact files that are never readable or writable, even inside an exposed toolchain directory. */
  denied?: string[];
  /** Localhost bind/connect without network approval (default true); helper services turn it off. */
  loopback?: boolean;
  /** Directories whose entries may be stat-ed (existence/type) but never opened or listed. */
  metadataOnly?: string[];
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

/** Every ancestor directory of `path` below the file-system root, nearest first, excluding `path`. */
function gitAncestors(path: string): string[] {
  const result: string[] = [];
  for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) result.push(dir);
  return result;
}

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
      ...this.processRules(),
      ...this.terminalRules(),
      ...this.readRules(),
      ...this.writeRules(sandbox),
      ...this.protectedPathRules(),
      ...this.networkRules(sandbox),
    ].join('\n');
  }

  /**
   * Processes, signals and system services. There is no blanket `mach-lookup`: LaunchServices,
   * AppleEvents and the pasteboard (e.g. `open -a`) could otherwise start programs outside the sandbox.
   */
  private processRules(): string[] {
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
      `(allow mach-lookup ${globalNames(BASE_MACH_SERVICES)} (local-name "com.apple.cfprefsd.agent"))`,
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

  /** Read the system broadly, but not user directories except the workspace and toolchains. */
  private readRules(): string[] {
    const {workspace, home, toolchains, scratch, metadataOnly = []} = this.options;
    return [
      '(allow file-read*)',
      `(deny file-read* (subpath "/Users") ${subpath(home)} (subpath "/Volumes"))`,
      `(allow file-read-metadata (literal "/Users") (path-ancestors ${quote(workspace)}))`,
      `(allow file-read* ${subpath(workspace)} ${toolchains.map(subpath).join(' ')} ${subpath(scratch)})`,
      // Codex forbids only WRITING `.git`: a workspace nested in another repository must be able to
      // read that repository's `.git` (next build, git status). Writes stay denied (writeRules).
      ...gitAncestors(workspace).map(dir => `(allow file-read* ${subpath(join(dir, '.git'))})`),
      // Tools such as rustup stat their home directory; metadata of the ancestors only, never contents.
      ...metadataOnly.map(dir => `(allow file-read-metadata ${subpath(dir)})`),
      ...toolchains.map(dir => `(allow file-read-metadata (path-ancestors ${quote(dir)}))`),
    ];
  }

  /** Private temp/home always; the workspace and /private/tmp only in workspace-write; never `.git`. */
  private writeRules(sandbox: CommandSandbox): string[] {
    const {workspace, scratch} = this.options;
    const rules = [
      `(allow file-write* ${subpath(join(scratch, 'tmp'))} ${subpath(join(scratch, 'home'))} (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`,
    ];
    if (sandbox.mode === 'workspace-write') {
      rules.push(`(allow file-write* ${subpath(workspace)} (subpath "/private/tmp"))`);
      rules.push(`(deny file-write* (regex #"^${escapeRegex(workspace)}/(.*/)?\\.[gG][iI][tT](/|$)"))`);
    }
    return rules;
  }

  /**
   * Futryn state and optional secret names, denied last so they win. `.git/config` stays readable
   * because git cannot run without it (as in Codex); URL credentials are redacted from output instead.
   */
  private protectedPathRules(): string[] {
    const {workspace, state, secrets, denied} = this.options;
    const ws = escapeRegex(workspace);
    const rules = [
      `(deny file-read* file-write* (regex #"^${ws}/(.*/)?\\.(futryn|hannes)(/|$)") (regex #"^${ws}/(.*/)?\\.(futryn|hannes)-patch-"))`,
    ];
    if (state) rules.push(`(deny file-read* file-write* ${subpath(state)})`);
    if (denied?.length)
      rules.push(`(deny file-read* file-write* ${denied.map(path => `(literal ${quote(path)})`).join(' ')})`);
    if (secrets) {
      // Inside the project only: system files such as /etc/ssl/cert.pem stay readable.
      const names = secrets.deny.map(r => `(regex #"${r}")`).join(' ');
      const exceptions = secrets.except.map(r => `(require-not (regex #"${r}"))`).join(' ');
      rules.push(`(deny file-read* file-write* (require-all (regex #"^${ws}/") (require-any ${names}) ${exceptions}))`);
    }
    return rules;
  }

  /**
   * Without approval only the local machine is reachable: binding any local address (a dev server
   * listens on 0.0.0.0 by default) and traffic to and from localhost, exactly the three rules Codex
   * emits for `allow_local_binding` (`sandboxing/src/seatbelt.rs`, pinned 090be4df). Inbound is
   * limited to localhost, so a bound port is not reachable from other hosts. External network still
   * needs the approved `network` permission.
   */
  private networkRules(sandbox: CommandSandbox): string[] {
    if (!sandbox.network && this.options.loopback === false) return ['(deny network*)'];
    if (!sandbox.network)
      return [
        '(deny network*)',
        '(allow network-bind (local ip "*:*"))',
        '(allow network-inbound (local ip "localhost:*"))',
        '(allow network-outbound (remote ip "localhost:*"))',
      ];
    return [
      '(allow network*)',
      '(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))',
      `(allow mach-lookup ${globalNames(NETWORK_MACH_SERVICES)})`,
    ];
  }
}
