/** Settings access to the conversation desktop. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { RemoteV02 } from './v02.ts';
type Props = PropsRuntime<'settings.section'> & PropsLocale<'wrapvm_isolate'> & InjectFace<{
    readRemote: RemoteV02 | null;
}>;
/** Use the same conversation controller as the desktop sidebar. */
export declare function WrapvmSection({ t, useSessions, readRemote }: Props): import("react").JSX.Element;
export {};
//# sourceMappingURL=panel.d.ts.map