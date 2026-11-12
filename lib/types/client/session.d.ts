import type { RemoteV02 } from './v02.ts';
import type { LocaleKey } from './locales.ts';
/** Conversation controls and their remote operations. */
export interface SessionDesktopProps {
    sessionKey: string;
    remote: RemoteV02;
    t: (key: LocaleKey) => string;
}
/** Select an environment for the current conversation. */
export declare function SessionDesktop({ sessionKey, remote, t }: SessionDesktopProps): import("react").JSX.Element;
//# sourceMappingURL=session.d.ts.map