/** Slot registrations for the v0.2 UI, activated after the Remote face is available. */
import type { Context } from '@deepseek-ai/cordis';
import type { RemoteV02 } from './v02.ts';
import type { ReadV02 } from './remote-adapter.ts';
/** Register and dispose the inventory and desktop seats with their context. */
export declare function registerV02Ui(ctx: Context, remote: ReadV02 | null, full: RemoteV02 | null): void;
//# sourceMappingURL=register-v02.d.ts.map