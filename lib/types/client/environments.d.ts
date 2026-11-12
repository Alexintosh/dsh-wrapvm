import type { RemoteV02 } from './v02.ts';
import type { LocaleKey } from './locales.ts';
type Translate = (key: LocaleKey) => string;
/** Operations required by the inventory page. */
export interface EnvironmentsProps {
    remote: RemoteV02;
    t: Translate;
}
/** List environments without starting any of them. */
export declare function Environments({ remote, t }: EnvironmentsProps): import("react").JSX.Element;
export {};
//# sourceMappingURL=environments.d.ts.map