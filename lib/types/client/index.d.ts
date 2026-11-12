/** Register the wrapvm settings section and its generated Remote contribution. */
import type { Context } from '@deepseek-ai/cordis';
import { type LocaleKey } from './locales.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** Wrapvm settings copy. */
        wrapvm_isolate: LocaleKey;
    }
}
/** Loader identity. */
export declare const name = "wrapvmIsolate";
/** Required browser services. */
export declare const inject: string[];
/**
 * Mount the Remote descriptors before registering the settings controls.
 * @param ctx - client plugin context.
 */
export declare function apply(ctx: Context): Promise<void>;
//# sourceMappingURL=index.d.ts.map