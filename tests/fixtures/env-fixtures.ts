/**
 * Shared fixtures for the Phase-3 environment-manager suites: a scripted
 * engine runner (no live Docker), a fake filesystem mount-policy context with
 * symlink resolution, and canned inspect payloads.
 */
import type { EngineRunner, EngineRunResult } from '../../src/docker-backend.ts'
import type { MountPolicyContext } from '../../src/mount-policy.ts'
import { asEnvironmentId, type EnvironmentDescriptor, type EnvironmentId } from '../../src/environments.ts'

export const env1 = asEnvironmentId('env-1')
export const env2 = asEnvironmentId('env-2')

/** Engine test double: records every argv and answers from the responder. */
export function fakeEngine(responder: (argv: readonly string[]) => EngineRunResult) {
  const calls: string[][] = []
  const runner: EngineRunner = async (argv, signal) => {
    signal.throwIfAborted()
    calls.push([...argv])
    return responder(argv)
  }
  return { runner, calls }
}

export const ok: EngineRunResult = { exitCode: 0, stdout: '', stderr: '' }

export const fail = (stderr = 'boom'): EngineRunResult => ({ exitCode: 1, stdout: '', stderr })

/** True when every needle appears in argv. */
export function argvHas(argv: readonly string[], ...needles: readonly string[]): boolean {
  return needles.every(needle => argv.includes(needle))
}

/** Find recorded calls whose argv starts with the given subcommand words. */
export function callsLike(calls: readonly (readonly string[])[], ...prefix: readonly string[]): string[][] {
  return calls.filter(argv => prefix.every((word, index) => argv[index + 1] === word))
}

/** Canned `docker inspect --format {{json .}}` payload. */
export function inspectJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Id: 'container-1',
    Image: 'sha256:aaaabbbbccccdddd',
    State: { Status: 'running' },
    Config: {
      Image: 'ghcr.io/tobi/wrapvm:desktop',
      Labels: { 'dsh.wrapvm.environment': '1', 'dsh.wrapvm.environment-id': 'env-1' },
    },
    HostConfig: { Memory: 4 * 2 ** 30, NanoCpus: 2e9 },
    NetworkSettings: {
      Networks: { 'dsh-wrapvm-env-1': { NetworkID: 'net-1' } },
      Ports: {
        '6080/tcp': [{ HostIp: '127.0.0.1', HostPort: '55000' }],
        '9223/tcp': [{ HostIp: '127.0.0.1', HostPort: '55001' }],
      },
    },
    ...overrides,
  })
}

/**
 * Mount-policy context over a scripted filesystem: `existing` lists the paths
 * that exist, `symlinks` maps a path to its link target (resolved for the
 * longest matching prefix, recursively).
 */
export function fakeMountContext(options: {
  approvedRoots?: readonly string[]
  existing?: readonly string[]
  symlinks?: Readonly<Record<string, string>>
  homedir?: string
  extraBlockedSubtrees?: readonly string[]
} = {}): MountPolicyContext {
  const homedir = options.homedir ?? '/Users/tester'
  const existing = new Set(options.existing ?? [
    '/', '/Users', '/Users/tester', '/Users/tester/projects', '/Users/tester/shared',
    '/etc', '/private', '/private/etc', '/home', '/var',
  ])
  const symlinks = new Map(Object.entries(options.symlinks ?? {}))
  const realpath = (path: string): string => {
    const parts = path.split('/').filter(Boolean)
    const walked: string[] = []
    for (const [index, part] of parts.entries()) {
      walked.push(part)
      const prefix = `/${walked.join('/')}`
      const link = symlinks.get(prefix)
      if (link !== undefined) {
        const rest = parts.slice(index + 1)
        return realpath(rest.length > 0 ? `${link}/${rest.join('/')}` : link)
      }
    }
    return path
  }
  return {
    realpath,
    exists: path => existing.has(path),
    homedir,
    approvedRoots: options.approvedRoots ?? [],
    ...(options.extraBlockedSubtrees !== undefined ? { extraBlockedSubtrees: options.extraBlockedSubtrees } : {}),
  }
}

/** A complete inventory descriptor for tests. */
export function descriptorFor(id: EnvironmentId, overrides: Partial<EnvironmentDescriptor> = {}): EnvironmentDescriptor {
  return {
    id,
    backend: 'docker',
    containerId: 'container-1',
    ownership: 'plugin',
    image: 'ghcr.io/tobi/wrapvm:desktop',
    digest: 'sha256:aaaabbbbccccdddd',
    createdAt: 100,
    mounts: [],
    limits: { cpuMillis: 2_000, memoryBytes: 4 * 2 ** 30 },
    internetAccess: true,
    displayName: 'Test environment',
    volumeName: `dsh-wrapvm-${id}-data`,
    networkName: `dsh-wrapvm-${id}`,
    ports: { viewerPort: 55000, cdpPort: 55001 },
    desiredPhase: 'running',
    ...overrides,
  }
}