/**
 * Realistic scripted Docker engine for the backend-review suite.
 *
 * Unlike the generic canned responder, this fixture models the engine
 * behaviors the review found the backend was assuming away:
 * - `docker ps`/`docker stats` return TRUNCATED ids unless `--no-trunc` is
 *   passed, so id matching only works when the backend asks for full ids;
 * - `docker volume create` SILENTLY reuses an existing same-name volume
 *   (exit 0, requested labels never applied), so success is not ownership;
 * - `docker network create` refuses an existing name with "already exists";
 * - inspect/rm/rmi-style lookups resolve full ids, names, and unique prefixes
 *   and report realistic "No such …" / "not found" failures otherwise;
 * - `network rm` refuses while endpoints are attached; `volume rm` refuses
 *   while a container mounts the volume;
 * - any command the suite did not script THROWS: fixtures never answer an
 *   unexpected command with generic success.
 */
import type { EngineRunner, EngineRunResult } from '../../src/docker-backend.ts'

export const ok = (stdout = ''): EngineRunResult => ({ exitCode: 0, stdout, stderr: '' })
export const fail = (exitCode: number, stderr: string): EngineRunResult => ({ exitCode, stdout: '', stderr })

export interface FakeMount {
  readonly Type: string
  readonly Name?: string
  readonly Source?: string
  readonly Destination?: string
  readonly readonly?: boolean
  readonly RW?: boolean
}

export interface FakeContainer {
  readonly id: string
  readonly name: string
  readonly image: string
  readonly imageId: string
  status: string
  readonly labels: Record<string, string>
  readonly networks: Record<string, { NetworkID: string }>
  readonly mounts: FakeMount[]
  readonly ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null>
  readonly memory?: number
  readonly nanoCpus?: number
  readonly hostConfig?: Record<string, unknown>
  readonly entrypoint?: string[] | null
  readonly cmd?: string[] | null
  readonly env?: string[] | null
  readonly user?: string
  readonly configuredPorts?: Record<string, Array<{ HostIp: string; HostPort: string }> | null>
}

export interface FakeNetwork {
  name: string
  id: string
  labels: Record<string, string>
  internal: boolean
}

export interface FakeVolume {
  name: string
  driver: string
  createdAt: string
  labels: Record<string, string>
}

export interface FakeEngineState {
  containers: FakeContainer[]
  networks: FakeNetwork[]
  volumes: FakeVolume[]
}

export interface FakeEngineOptions {
  /** Guest exec responder. An unscripted `exec` throws when absent. */
  readonly exec?: (argv: readonly string[]) => EngineRunResult
  /**
   * `volume create` silently reuses an existing same-name volume (real Docker
   * behavior, the default here). False models a daemon that refuses the name.
   */
  readonly silentVolumeReuse?: boolean
  /** Failure injection: answer before the model runs; undefined falls through. */
  readonly intercept?: (argv: readonly string[]) => EngineRunResult | undefined
}

/** Deterministic 64-hex ids with unique 12-char prefixes (like real ids). */
function newId(counter: { next: number }): string {
  const head = counter.next.toString(16).padStart(4, '0')
  counter.next += 1
  return (head + 'd2c3b4a59687f0e1').repeat(4)
}

function splitFirst(text: string, separator: string): [string, string | undefined] {
  const index = text.indexOf(separator)
  if (index < 0) return [text, undefined]
  return [text.slice(0, index), text.slice(index + separator.length)]
}

/** Split the validated mount options; the backend rejects ambiguous values. */
function splitMountOptions(value: string): string[] {
  return value.split(',')
}

function flagValues(argv: readonly string[], flag: string): string[] {
  const out: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag) {
      const value = argv[index + 1]
      if (value !== undefined) out.push(value)
    }
  }
  return out
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  return flagValues(argv, flag)[0]
}

/** Positional arguments: words after the subcommand that are not flag values. */
function positionals(argv: readonly string[], subIndex: number, flagsWithValues: readonly string[]): string[] {
  const out: string[] = []
  for (let index = subIndex + 1; index < argv.length; index += 1) {
    const word = argv[index]!
    if (word.startsWith('-')) continue
    const previous = argv[index - 1]
    if (previous !== undefined && flagsWithValues.includes(previous)) continue
    out.push(word)
  }
  return out
}

export interface FakeEngine {
  readonly runner: EngineRunner
  readonly calls: string[][]
  readonly state: FakeEngineState
  /** Full ids of containers created through this engine, in order. */
  readonly createdContainerIds: string[]
}

export function fakeDockerEngine(state: FakeEngineState, options: FakeEngineOptions = {}): FakeEngine {
  const calls: string[][] = []
  const ids = { next: 0x1000 }
  const createdContainerIds: string[] = []
  const silentVolumeReuse = options.silentVolumeReuse ?? true

  const findContainer = (ref: string): FakeContainer | undefined => {
    const exact = state.containers.filter(c => c.id === ref || c.name === ref || c.id.startsWith(ref))
    return exact.length === 1 ? exact[0] : undefined
  }

  const dispatch = (argv: readonly string[]): EngineRunResult => {
    const sub = argv[1] ?? ''
    switch (sub) {
      case 'version':
        return ok('27.4.0\n')

      case 'ps': {
        const noTrunc = argv.includes('--no-trunc')
        const format = flagValue(argv, '--format') ?? '{{.ID}}'
        let rows = [...state.containers]
        for (const filter of flagValues(argv, '--filter')) {
          const [kind, value] = splitFirst(filter, '=')
          if (kind === 'label' && value !== undefined) {
            const [key, wanted] = splitFirst(value, '=')
            rows = rows.filter(c => (wanted === undefined ? key in c.labels : c.labels[key] === wanted))
          } else if (kind === 'id' && value !== undefined) {
            rows = rows.filter(c => c.id.startsWith(value) || c.name === value)
          }
        }
        const lines = rows.map((c) => {
          const shown = noTrunc ? c.id : c.id.slice(0, 12)
          if (format === '{{json .}}') return JSON.stringify({ ID: shown, State: c.status, Image: c.image })
          if (format === '{{.ID}}') return shown
          if (format === '{{.Size}}') return '12.5MB (virtual 1.1GB)'
          throw new Error(`unexpected ps format ${format}`)
        })
        return ok(lines.join('\n') + (lines.length > 0 ? '\n' : ''))
      }

      case 'inspect': {
        const ref = argv.at(-1) ?? ''
        const container = findContainer(ref)
        if (container === undefined) return fail(1, `Error: No such object: ${ref}`)
        return ok(JSON.stringify({
          Id: container.id,
          Image: container.imageId,
          State: { Status: container.status },
          Config: { Image: container.image, Labels: container.labels, Entrypoint: container.entrypoint === undefined ? ['/entrypoint'] : container.entrypoint, Cmd: container.cmd === undefined ? null : container.cmd, Env: container.env === undefined ? ['HOME=/home/user'] : container.env, User: container.user ?? '' },
          HostConfig: { Memory: container.memory, NanoCpus: container.nanoCpus, MemorySwap: container.memory,
            PidsLimit: 512, Privileged: false, CapDrop: ['ALL'], CapAdd: ['CHOWN', 'FOWNER', 'SETUID', 'SETGID', 'KILL'],
            SecurityOpt: ['no-new-privileges:true'], PidMode: '', IpcMode: 'private', UsernsMode: '', Devices: [],
            DeviceRequests: null, DeviceCgroupRules: null, UTSMode: '', CgroupnsMode: 'private', NetworkMode: Object.keys(container.networks)[0],
            PortBindings: container.configuredPorts ?? container.ports, ...container.hostConfig },
          NetworkSettings: { Networks: container.networks, Ports: container.status === 'created' ? {} : container.ports },
          Mounts: container.mounts.map(mount => ({ ...mount, RW: mount.RW ?? !mount.readonly })),
        }))
      }

      case 'image': {
        if (argv[2] !== 'inspect') throw new Error(`unexpected image action: ${argv.join(' ')}`)
        return ok(JSON.stringify({ Id: argv.at(-1), Config: { Entrypoint: ['/entrypoint'], Cmd: null, Env: ['HOME=/home/user'], User: '' } }))
      }

      case 'network': {
        const action = argv[2]
        if (action === 'inspect') {
          const ref = argv.at(-1) ?? ''
          const network = state.networks.find(n => n.name === ref || n.id === ref || n.id.startsWith(ref))
          if (network === undefined) return fail(1, `Error response from daemon: network (${ref}) not found`)
          return ok(JSON.stringify({ Name: network.name, Id: network.id, Driver: 'bridge', Internal: network.internal, Labels: network.labels }))
        }
        if (action === 'create') {
          const name = positionals(argv, 2, ['--label', '--driver']).at(-1) ?? ''
          if (state.networks.some(n => n.name === name)) {
            return fail(1, `Error response from daemon: network with name ${name} already exists`)
          }
          const labels: Record<string, string> = {}
          for (const pair of flagValues(argv, '--label')) {
            const [key, value] = splitFirst(pair, '=')
            labels[key] = value ?? ''
          }
          const network: FakeNetwork = { name, id: newId(ids), labels, internal: argv.includes('--internal') }
          state.networks.push(network)
          return ok(network.id + '\n')
        }
        if (action === 'rm') {
          const ref = argv.at(-1) ?? ''
          const index = state.networks.findIndex(n => n.name === ref || n.id === ref)
          if (index < 0) return fail(1, `Error response from daemon: network ${ref} not found`)
          const network = state.networks[index]
          if (network === undefined) return fail(1, `Error response from daemon: network ${ref} not found`)
          if (state.containers.some(c => network.name in c.networks)) {
            return fail(1, `Error response from daemon: failed to remove network ${network.name}: active endpoints`)
          }
          state.networks.splice(index, 1)
          return ok(network.name + '\n')
        }
        throw new Error(`unexpected network action: ${argv.join(' ')}`)
      }

      case 'volume': {
        const action = argv[2]
        if (action === 'inspect') {
          const ref = argv.at(-1) ?? ''
          const volume = state.volumes.find(v => v.name === ref)
          if (volume === undefined) return fail(1, `Error response from daemon: get ${ref}: no such volume`)
          return ok(JSON.stringify({ Name: volume.name, Driver: volume.driver, CreatedAt: volume.createdAt, Labels: volume.labels }))
        }
        if (action === 'create') {
          const name = positionals(argv, 2, ['--label', '--driver']).at(-1) ?? ''
          const existing = state.volumes.find(v => v.name === name)
          if (existing !== undefined) {
            if (silentVolumeReuse) return ok(existing.name + '\n')
            return fail(1, `Error response from daemon: volume with name ${name} already exists`)
          }
          const labels: Record<string, string> = {}
          for (const pair of flagValues(argv, '--label')) {
            const [key, value] = splitFirst(pair, '=')
            labels[key] = value ?? ''
          }
          const volume: FakeVolume = { name, driver: 'local', createdAt: '2026-11-11T10:00:00Z', labels }
          state.volumes.push(volume)
          return ok(volume.name + '\n')
        }
        if (action === 'rm') {
          const ref = argv.at(-1) ?? ''
          const index = state.volumes.findIndex(v => v.name === ref)
          if (index < 0) return fail(1, `Error response from daemon: remove ${ref}: no such volume`)
          const volume = state.volumes[index]
          if (volume === undefined) return fail(1, `Error response from daemon: remove ${ref}: no such volume`)
          if (state.containers.some(c => c.mounts.some(m => m.Type === 'volume' && m.Name === volume.name))) {
            return fail(1, `Error response from daemon: remove ${volume.name}: volume is in use`)
          }
          state.volumes.splice(index, 1)
          return ok(volume.name + '\n')
        }
        throw new Error(`unexpected volume action: ${argv.join(' ')}`)
      }

      case 'create': {
        const name = flagValue(argv, '--name') ?? ''
        if (state.containers.some(c => c.name === name)) {
          return fail(125, `Error response from daemon: Conflict. The container name "/${name}" is already in use`)
        }
        const labels: Record<string, string> = {}
        for (const pair of flagValues(argv, '--label')) {
          const [key, value] = splitFirst(pair, '=')
          labels[key] = value ?? ''
        }
        const networks: Record<string, { NetworkID: string }> = {}
        const networkName = flagValue(argv, '--network')
        if (networkName !== undefined) {
          const network = state.networks.find(n => n.name === networkName)
          networks[networkName] = { NetworkID: network?.id ?? 'unknown-network' }
        }
        const mounts: FakeMount[] = []
        for (const spec of flagValues(argv, '--volume')) {
          const [source, destination] = spec.split(':')
          const volume = state.volumes.find(v => v.name === source)
          mounts.push({ Type: 'volume', Name: source, Source: volume?.name ?? source, Destination: destination })
        }
        for (const spec of flagValues(argv, '--mount')) {
          const entries: Record<string, string | boolean> = {}
          for (const option of splitMountOptions(spec)) {
            const [key, value] = splitFirst(option, '=')
            entries[key] = value ?? true
          }
          mounts.push({
            Type: String(entries['type'] ?? ''),
            Source: entries['src'] !== undefined ? String(entries['src']) : entries['source'] !== undefined ? String(entries['source']) : undefined,
            Destination: entries['dst'] !== undefined ? String(entries['dst']) : entries['target'] !== undefined ? String(entries['target']) : undefined,
            readonly: entries['readonly'] === true || entries['ro'] === true,
          })
        }
        const ports: FakeContainer['ports'] = {}
        let ephemeral = 49_153
        const configuredPorts: FakeContainer['ports'] = {}
        for (const spec of flagValues(argv, '-p')) {
          const parts = spec.split(':')
          const hostIp = parts[0] ?? ''
          const hostPort = parts[1] ?? ''
          const guestPort = parts[2] ?? parts[1] ?? ''
          configuredPorts[`${guestPort}/tcp`] = [{ HostIp: hostIp, HostPort: hostPort }]
          ports[`${guestPort}/tcp`] = [{ HostIp: hostIp, HostPort: hostPort === '' ? String(ephemeral++) : hostPort }]
        }
        const image = positionals(argv, 1, ['--name', '--label', '--network', '--volume', '--mount', '-p', '--cpus', '--memory', '--memory-swap', '--pids-limit', '--security-opt', '--cap-drop', '--cap-add', '--restart']).at(-1) ?? ''
        const container: FakeContainer = {
          id: newId(ids),
          name,
          image,
          imageId: 'sha256:aaaabbbbccccdddd',
          status: 'created',
          labels,
          networks,
          mounts,
          ports,
          configuredPorts,
          memory: Number(flagValue(argv, '--memory')),
          nanoCpus: Number(flagValue(argv, '--cpus')) * 1e9,
        }
        state.containers.push(container)
        createdContainerIds.push(container.id)
        return ok(container.id + '\n')
      }

      case 'start': case 'stop': case 'pause': case 'unpause': case 'rm': {
        const refs = positionals(argv, 1, [])
        const ref = refs.at(-1) ?? ''
        const container = findContainer(ref)
        if (container === undefined) return fail(1, `Error response from daemon: No such container: ${ref}`)
        if (sub === 'rm') {
          state.containers = state.containers.filter(c => c.id !== container.id)
        } else {
          container.status = sub === 'start' ? 'running' : sub === 'stop' ? 'exited' : sub === 'pause' ? 'paused' : 'running'
          if (sub === 'start') for (const [name, attachment] of Object.entries(container.networks)) {
            if (attachment.NetworkID === '') attachment.NetworkID = state.networks.find(network => network.name === name)?.id ?? ''
          }
        }
        return ok(container.name + '\n')
      }

      case 'update': {
        const ref = positionals(argv, 1, ['--cpus', '--memory', '--memory-swap']).at(-1) ?? ''
        const container = findContainer(ref)
        if (container === undefined) return fail(1, `Error response from daemon: No such container: ${ref}`)
        const memory = flagValue(argv, '--memory')
        if (memory !== undefined) container.memory = Number(memory)
        const cpus = flagValue(argv, '--cpus')
        if (cpus !== undefined) container.nanoCpus = Number(cpus) * 1e9
        return ok(container.name + '\n')
      }

      case 'exec': {
        if (options.exec === undefined) throw new Error(`unscripted guest exec: ${argv.join(' ')}`)
        return options.exec(argv)
      }

      case 'stats': {
        const noTrunc = argv.includes('--no-trunc')
        const requested = positionals(argv, 1, ['--format'])
        const lines = requested
          .map(ref => findContainer(ref))
          .filter((c): c is FakeContainer => c !== undefined)
          .map(c => JSON.stringify({
            ID: noTrunc ? c.id : c.id.slice(0, 12),
            MemUsage: '1GiB / 4GiB',
            CPUPerc: '7.50%',
          }))
        return ok(lines.join('\n') + (lines.length > 0 ? '\n' : ''))
      }

      default:
        throw new Error(`unexpected engine command: ${argv.join(' ')}`)
    }
  }

  const runner: EngineRunner = async (argv, signal) => {
    signal.throwIfAborted()
    calls.push([...argv])
    const injected = options.intercept?.(argv)
    if (injected !== undefined) return injected
    return dispatch(argv)
  }
  return { runner, calls, state, createdContainerIds }
}

/** Owned-labels helper matching the backend's ownership scheme. */
export function ownedLabels(environmentId: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'dsh.wrapvm.environment': '1', 'dsh.wrapvm.environment-id': environmentId, ...extra }
}

/** A complete owned container row for the fake state. */
export function ownedContainer(overrides: Partial<FakeContainer> & { id: string; name: string; environmentId: string }): FakeContainer {
  const { id, name, environmentId, ...rest } = overrides
  return {
    id,
    name,
    image: 'ghcr.io/tobi/wrapvm:desktop',
    imageId: 'sha256:aaaabbbbccccdddd',
    status: 'running',
    labels: ownedLabels(environmentId),
    networks: { [`dsh-wrapvm-${environmentId}`]: { NetworkID: 'net-' + environmentId } },
    mounts: [{ Type: 'volume', Name: `dsh-wrapvm-${environmentId}-data`, Destination: '/home/user/workspace' }],
    ports: {
      '6080/tcp': [{ HostIp: '127.0.0.1', HostPort: '55000' }],
      '9223/tcp': [{ HostIp: '127.0.0.1', HostPort: '55001' }],
    },
    memory: 2 * 2 ** 30,
    nanoCpus: 1.5e9,
    ...rest,
  }
}
