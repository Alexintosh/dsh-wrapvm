import type { LocaleKey } from './locales.ts';
import type { ReadV02 } from './remote-adapter.ts';
/** Render inventory and subscribe to the host sampler without starting environments. */
export declare function ReadInventory({ remote, t }: {
    remote: ReadV02;
    t: (key: LocaleKey) => string;
}): import("react").JSX.Element;
//# sourceMappingURL=read-inventory.d.ts.map