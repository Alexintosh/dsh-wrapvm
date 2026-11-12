import type { RemoteV02 } from './v02.ts';
import type { LocaleKey } from './locales.ts';
type Translate = (key: LocaleKey) => string;
/** Props for an ephemeral, revision-checked desktop. */
export interface ViewerProps {
    sessionKey: string;
    remote: Pick<RemoteV02, 'v02WatchSession' | 'v02ViewerUrl'>;
    t: Translate;
}
/** Render a viewer only while its session subscription remains current. */
export declare function VmViewer({ sessionKey, remote, t }: ViewerProps): import("react").JSX.Element;
export {};
//# sourceMappingURL=viewer.d.ts.map