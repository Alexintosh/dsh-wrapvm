import type { LocaleKey } from './locales.ts';
import type { Limits } from './v02.ts';
/** Format resource measurements without treating an absent measurement as zero. */
export declare function formatBytes(value: number | null | undefined): string;
/** Parse human units, rejecting fractional bytes and invalid host limits. */
export declare function parseResourceLimits(cpu: string, memory: string, diskBytes?: number | null): Limits | null;
/** Render paired CPU and memory fields used by create and edit dialogs. */
export declare function ResourceFields({ cpu, memory, onCpu, onMemory, t }: {
    cpu: string;
    memory: string;
    onCpu: (value: string) => void;
    onMemory: (value: string) => void;
    t: (key: LocaleKey) => string;
}): import("react").JSX.Element;
//# sourceMappingURL=resource-fields.d.ts.map