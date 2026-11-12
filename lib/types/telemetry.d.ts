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
import type { EnvironmentId, ResourceSample, TelemetrySampler } from './environments.ts';
/** One environment's measurement batch produced by the source. */
export interface StatsMeasurement {
    readonly memoryUsedBytes: number | null;
    readonly memoryLimitBytes: number | null;
    readonly cpuPercent: number | null;
    readonly writableLayerBytes: number | null;
    readonly volumeUsedBytes: number | null;
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
    measure(environmentIds: readonly EnvironmentId[], signal: AbortSignal): Promise<ReadonlyMap<EnvironmentId, StatsMeasurement>>;
}
/** Sampler options. */
export interface ResourceSamplerOptions {
    /** Cadence between batches, in milliseconds. */
    readonly cadenceMs: number;
    /** A cached sample older than this is flagged stale for new subscribers. */
    readonly stalenessMs: number;
    /** Clock injection for tests. */
    readonly now?: () => number;
    /** Delay injection for tests (defaults to timers/promises setTimeout). */
    readonly delay?: (ms: number, signal: AbortSignal) => Promise<void>;
}
/**
 * The single shared {@link TelemetrySampler} implementation.
 */
export declare class ResourceSampler implements TelemetrySampler {
    private readonly source;
    private readonly options;
    private readonly subscriptions;
    private readonly samples;
    private nextToken;
    private running;
    private lastPoll;
    private pollCount;
    private controller;
    private disposed;
    private readonly now;
    private readonly delay;
    constructor(source: StatsSource, options: ResourceSamplerOptions);
    /** Number of live subscriptions (views currently interested). */
    get subscriberCount(): number;
    /** Number of measurement batches taken so far (tests, diagnostics). */
    get polls(): number;
    /**
     * Subscribe to samples for one environment. The cadence starts on the
     * first subscriber and stops when the last one leaves. A fresh cached
     * sample is delivered immediately when one exists.
     */
    subscribe(environmentId: EnvironmentId, listener: (sample: ResourceSample) => void): () => void;
    /** Latest cached sample, flagged stale when it exceeds the staleness bound. */
    latest(environmentId: EnvironmentId): ResourceSample | undefined;
    /** Stop polling and drop every subscription (idempotent). */
    dispose(): void;
    /** Wait until the currently running batch settles (tests, shutdown). */
    drained(): Promise<void>;
    private ensureRunning;
    private stop;
    /** One bounded batch: a single source call for all subscribed environments. */
    private poll;
}
/**
 * Adapter turning a Docker stats face into a {@link StatsSource}: one batched
 * `docker stats` call plus one writable-layer size lookup per container, all
 * bounded by the caller's signal. Volume usage is not observable through
 * `docker stats`, so it stays null (reported as unknown, never zero).
 */
export declare function createDockerStatsSource(stats: (containerIds: readonly string[], signal: AbortSignal) => Promise<Map<string, {
    memoryUsedBytes: number | null;
    memoryLimitBytes: number | null;
    cpuPercent: number | null;
}>>, writableLayerSize: (containerId: string, signal: AbortSignal) => Promise<number | null>, resolveContainerId: (environmentId: EnvironmentId) => string | undefined): StatsSource;
//# sourceMappingURL=telemetry.d.ts.map