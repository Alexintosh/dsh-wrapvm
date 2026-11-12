/**
 * Shared resource sampler.
 *
 * One sampler serves every view (settings panel, environments page, right
 * sidebar): subscribers share a single cadence, no component polls on its
 * own, and the sampler stops entirely while nobody is subscribed.
 *
 * Honesty rules: a failed measurement produces null fields with a fresh
 * `takenAt`, never zeros; a sample older than the staleness bound is handed
 * to new subscribers flagged `stale`; and unknown stays unknown.
 *
 * The measurement source is injected ({@link StatsSource}); production wires
 * it to `DockerEnvironmentBackend.stats` plus writable-layer sizes, tests
 * script it. Cancellation and disposal stop the timer and drop subscriptions.
 * @module
 */

import type { EnvironmentId, ResourceSample, TelemetrySampler } from './environments.ts'

/** One environment's measurement batch produced by the source. */
export interface StatsMeasurement {
  readonly memoryUsedBytes: number | null
  readonly memoryLimitBytes: number | null
  readonly cpuPercent: number | null
  readonly writableLayerBytes: number | null
  readonly volumeUsedBytes: number | null
}

/**
 * Measurement source port. Implementations must be bounded (one batched
 * engine call, not per-container fan-out) and honor cancellation.
 */
export interface StatsSource {
  /**
   * Measure a batch of environments once.
   * @param environmentIds - targets to measure.
   * @param signal - cancellation.
   * @returns measurements keyed by environment id; absent entries mean the
   * source could not observe that environment (nulls, not zeros).
   */
  measure(environmentIds: readonly EnvironmentId[], signal: AbortSignal): Promise<ReadonlyMap<EnvironmentId, StatsMeasurement>>
}

/** Sampler options. */
export interface ResourceSamplerOptions {
  /** Cadence between batches, in milliseconds. */
  readonly cadenceMs: number
  /** A cached sample older than this is flagged stale for new subscribers. */
  readonly stalenessMs: number
  /** Clock injection for tests. */
  readonly now?: () => number
  /** Delay injection for tests (defaults to timers/promises setTimeout). */
  readonly delay?: (ms: number, signal: AbortSignal) => Promise<void>
}

interface Subscription {
  environmentId: EnvironmentId
  listener: (sample: ResourceSample) => void
}

const defaultDelay = async (ms: number, signal: AbortSignal): Promise<void> => {
  const { setTimeout: timer } = await import('node:timers/promises')
  await timer(ms, undefined, { signal })
}

/**
 * The single shared {@link TelemetrySampler} implementation.
 */
export class ResourceSampler implements TelemetrySampler {
  private readonly subscriptions = new Map<number, Subscription>()
  private readonly samples = new Map<EnvironmentId, ResourceSample>()
  private nextToken = 1
  private running = false
  private lastPoll: Promise<void> = Promise.resolve()
  private pollCount = 0
  private controller: AbortController | undefined
  private disposed = false
  private readonly now: () => number
  private readonly delay: (ms: number, signal: AbortSignal) => Promise<void>

  constructor(
    private readonly source: StatsSource,
    private readonly options: ResourceSamplerOptions,
  ) {
    if (!Number.isFinite(options.cadenceMs) || options.cadenceMs < 1) throw new Error('wrapvm-isolate: sampler cadenceMs must be positive')
    if (!Number.isFinite(options.stalenessMs) || options.stalenessMs < options.cadenceMs) throw new Error('wrapvm-isolate: sampler stalenessMs must be at least the cadence')
    this.now = options.now ?? (() => Date.now())
    this.delay = options.delay ?? defaultDelay
  }

  /** Number of live subscriptions (views currently interested). */
  get subscriberCount(): number {
    return this.subscriptions.size
  }

  /** Number of measurement batches taken so far (tests, diagnostics). */
  get polls(): number {
    return this.pollCount
  }

  /**
   * Subscribe to samples for one environment. The cadence starts on the
   * first subscriber and stops when the last one leaves. A fresh cached
   * sample is delivered immediately when one exists.
   */
  subscribe(environmentId: EnvironmentId, listener: (sample: ResourceSample) => void): () => void {
    if (this.disposed) throw new Error('wrapvm-isolate: sampler is disposed')
    const token = this.nextToken++
    this.subscriptions.set(token, { environmentId, listener })
    const cached = this.samples.get(environmentId)
    if (cached !== undefined) {
      const age = this.now() - cached.takenAt
      listener(age > this.options.stalenessMs ? { ...cached, stale: true } : cached)
    }
    this.ensureRunning()
    return () => {
      this.subscriptions.delete(token)
      if (this.subscriptions.size === 0) this.stop()
    }
  }

  /** Latest cached sample, flagged stale when it exceeds the staleness bound. */
  latest(environmentId: EnvironmentId): ResourceSample | undefined {
    const cached = this.samples.get(environmentId)
    if (cached === undefined) return undefined
    return this.now() - cached.takenAt > this.options.stalenessMs ? { ...cached, stale: true } : cached
  }

  /** Stop polling and drop every subscription (idempotent). */
  dispose(): void {
    this.disposed = true
    this.stop()
    this.subscriptions.clear()
    this.samples.clear()
  }

  /** Wait until the currently running batch settles (tests, shutdown). */
  async drained(): Promise<void> {
    await this.lastPoll
  }

  private ensureRunning(): void {
    if (this.running || this.disposed || this.subscriptions.size === 0) return
    this.running = true
    this.controller = new AbortController()
    const signal = this.controller.signal
    const loop = async (): Promise<void> => {
      while (!signal.aborted && this.subscriptions.size > 0) {
        this.lastPoll = this.poll(signal)
        await this.lastPoll
        if (signal.aborted || this.subscriptions.size === 0) break
        try {
          await this.delay(this.options.cadenceMs, signal)
        } catch {
          break
        }
      }
      this.running = false
    }
    void loop()
  }

  private stop(): void {
    this.controller?.abort()
    this.controller = undefined
  }

  /** One bounded batch: a single source call for all subscribed environments. */
  private async poll(signal: AbortSignal): Promise<void> {
    this.pollCount += 1
    const ids = [...new Set([...this.subscriptions.values()].map(sub => sub.environmentId))]
    const takenAt = this.now()
    let measurements: ReadonlyMap<EnvironmentId, StatsMeasurement> = new Map()
    let failure: string | undefined
    try {
      measurements = await this.source.measure(ids, signal)
    } catch (error) {
      if (signal.aborted) return
      failure = error instanceof Error ? error.message : String(error)
    }
    for (const id of ids) {
      const measurement = measurements.get(id)
      const sample: ResourceSample = {
        takenAt,
        memoryUsedBytes: measurement?.memoryUsedBytes ?? null,
        memoryLimitBytes: measurement?.memoryLimitBytes ?? null,
        cpuPercent: measurement?.cpuPercent ?? null,
        writableLayerBytes: measurement?.writableLayerBytes ?? null,
        volumeUsedBytes: measurement?.volumeUsedBytes ?? null,
        ...(failure !== undefined ? { stale: true } : {}),
      }
      this.samples.set(id, sample)
      for (const sub of this.subscriptions.values()) {
        if (sub.environmentId === id) sub.listener(sample)
      }
    }
  }
}

/**
 * Adapter turning a Docker stats face into a {@link StatsSource}: one batched
 * `docker stats` call plus one writable-layer size lookup per container, all
 * bounded by the caller's signal. Volume usage is not observable through
 * `docker stats`, so it stays null (reported as unknown, never zero).
 */
export function createDockerStatsSource(
  stats: (containerIds: readonly string[], signal: AbortSignal) => Promise<Map<string, { memoryUsedBytes: number | null; memoryLimitBytes: number | null; cpuPercent: number | null }>>,
  writableLayerSize: (containerId: string, signal: AbortSignal) => Promise<number | null>,
  resolveContainerId: (environmentId: EnvironmentId) => string | undefined,
): StatsSource {
  return {
    async measure(environmentIds, signal) {
      const byContainer = new Map<string, EnvironmentId>()
      for (const id of environmentIds) {
        const containerId = resolveContainerId(id)
        if (containerId !== undefined) byContainer.set(containerId, id)
      }
      const out = new Map<EnvironmentId, StatsMeasurement>()
      if (byContainer.size === 0) return out
      const statsRows = await stats([...byContainer.keys()], signal)
      for (const [containerId, environmentId] of byContainer) {
        const row = statsRows.get(containerId)
        let writableLayerBytes: number | null = null
        try {
          writableLayerBytes = await writableLayerSize(containerId, signal)
        } catch {
          if (signal.aborted) throw signal.reason ?? new Error('aborted')
        }
        out.set(environmentId, {
          memoryUsedBytes: row?.memoryUsedBytes ?? null,
          memoryLimitBytes: row?.memoryLimitBytes ?? null,
          cpuPercent: row?.cpuPercent ?? null,
          writableLayerBytes,
          volumeUsedBytes: null,
        })
      }
      return out
    },
  }
}