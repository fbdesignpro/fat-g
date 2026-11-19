// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// One invoke call from start to finish: sender check → payload validation → handler → envelope.
// Pure (no Electron) and generic over the spec, so tests drive it with a synthetic contract.
//
// It never throws. A handler that throws inside `ipcMain.handle` makes Electron print the raw
// error — stack included — and forward its message to the page, where a path such as
// C:\Users\<name>\… would cross the bridge. Here the page gets a code; the details stay in main.
//
// What the log keeps depends on the build (M12, C77, C79). A packaged build logs kinds only: the
// channel, a fault's code and field name, an error's class and code — never an error's message or
// stack, nor a value from the request, because a file system error's message holds a path and with
// it the user's name. A development run's log stays on the developer's machine, so it has it all.
import { z } from 'zod';
import type { InvokeChannel, WindowKind } from '@shared/ipc/channels';
import type { InvokeRequest, InvokeResponse, InvokeSpec } from '@shared/ipc/contract';
import { ipcFail, ipcOk, type IpcResult } from '@shared/ipc/result';
import type { TrustedOrigins } from '../app/origins';
import { errorKind } from '../storage/error-kind';
import { checkSender, type SenderFacts } from './sender-policy';

export interface InvokeContext {
  /** Kind of the calling window — fixed when its handlers were attached, never taken from the page. */
  readonly windowKind: WindowKind;
}

export type Handler<Request, Response> = (request: Request, context: InvokeContext) => Response | Promise<Response>;

/** One handler per invoke channel. A mapped type, so a channel without a handler fails to compile. */
export type InvokeHandlers = { readonly [C in InvokeChannel]: Handler<InvokeRequest<C>, InvokeResponse<C>> };

export interface InvokeCall {
  readonly windowKind: WindowKind;
  readonly sender: SenderFacts;
  /** The raw payload, exactly as it arrived. */
  readonly request: unknown;
}

export interface DispatchDeps {
  readonly origins: TrustedOrigins;
  /** `console` in the app. Refusals are warnings; handler failures are errors. */
  readonly log: Pick<Console, 'warn' | 'error'>;
  /** `kinds` in a packaged build, `full` in a development run (`app.isPackaged`). */
  readonly detail: 'kinds' | 'full';
}

/** A validated payload can still name a provider that is not registered in this build. */
export class InvalidIpcRequest extends Error {}

export async function dispatchInvoke<Request, Response>(
  channel: string,
  spec: InvokeSpec<Request>,
  handler: Handler<Request, Response>,
  call: InvokeCall,
  deps: DispatchDeps,
): Promise<IpcResult<Response>> {
  const check = checkSender(call.sender, call.windowKind, spec.from, deps.origins);
  if (!check.ok) {
    deps.log.warn(`[ipc] refused ${channel} from the ${call.windowKind} window: ${check.reason}`);
    return ipcFail('forbidden');
  }

  const parsed = spec.request.safeParse(call.request);
  if (!parsed.success) {
    const summary = `[ipc] bad request on ${channel} from the ${call.windowKind} window: ${faultSummary(spec.request, parsed.error.issues)}`;
    if (deps.detail === 'full') deps.log.warn(summary, parsed.error.issues);
    else deps.log.warn(summary);
    return ipcFail('bad-request');
  }

  try {
    return ipcOk(await handler(parsed.data, { windowKind: call.windowKind }));
  } catch (error) {
    if (error instanceof InvalidIpcRequest) {
      deps.log.warn(`[ipc] bad request on ${channel} from the ${call.windowKind} window`);
      return ipcFail('bad-request');
    }
    const summary = `[ipc] ${channel} handler failed (${errorKind(error)})`;
    if (deps.detail === 'full') deps.log.error(summary, error);
    else deps.log.error(summary);
    return ipcFail('internal');
  }
}

/**
 * Each fault as `code at field`. The field is the first segment of the fault's path, and only when
 * it is a field the request's strict object declares — never a record key, an array index or a
 * value, which come from the page. A fault on the whole request, such as unknown keys, has none.
 */
export function faultSummary(schema: z.ZodType, issues: readonly z.core.$ZodIssue[]): string {
  const fields: ReadonlySet<string> = schema instanceof z.ZodObject ? new Set(Object.keys(schema.shape)) : new Set();
  return issues
    .map((issue) => {
      const head = issue.path[0];
      return typeof head === 'string' && fields.has(head) ? `${issue.code} at ${head}` : issue.code;
    })
    .join(', ');
}
