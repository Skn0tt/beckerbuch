// EventEmitter helpers shared between the bridge (emit) and the
// public waitForRequest / waitForResponse helpers (subscribe).

import type { EventEmitter } from "node:events";

import { matchPattern } from "./matcher";
import type { ProxyRequest } from "./request";
import type { ProxyResponse } from "./response";

export type ProxyEvent =
  | "request"
  | "response"
  | "requestfinished"
  | "requestfailed";

export type WaitMatcher<T> = string | RegExp | ((value: T) => boolean);

export interface WaitOptions {
  /** Milliseconds before the wait rejects. Default 30_000. */
  timeout?: number;
}

export function safeEmit<T>(
  events: EventEmitter,
  name: ProxyEvent,
  payload: T,
): void {
  try {
    events.emit(name, payload);
  } catch (err) {
    logBridgeError(name, err);
  }
}

export function logBridgeError(name: ProxyEvent | string, err: unknown): void {
  if (process.env.PROXY_LOG_UNMATCHED === "1") {
    console.warn(`[proxy] ${name} bridge threw: ${(err as Error).message}`);
  }
}

export function waitFor<T extends ProxyRequest | ProxyResponse>(
  events: EventEmitter,
  name: ProxyEvent,
  matcher: WaitMatcher<T>,
  opts: WaitOptions | undefined,
  urlOf: (value: T) => string = (v) => v.url(),
): Promise<T> {
  const timeout = opts?.timeout ?? 30_000;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      events.off(name, onValue);
      reject(
        new Error(
          `Timed out ${timeout}ms waiting for ${name} matching ${describeMatcher(
            matcher as WaitMatcher<never>,
          )}`,
        ),
      );
    }, timeout);

    const onValue = (value: T) => {
      let isMatch: boolean;
      try {
        isMatch =
          typeof matcher === "function"
            ? matcher(value)
            : typeof matcher === "string"
              ? matchPattern(matcher, urlOf(value))
              : matcher.test(urlOf(value));
      } catch {
        isMatch = false;
      }
      if (!isMatch) return;
      clearTimeout(timer);
      events.off(name, onValue);
      resolve(value);
    };
    events.on(name, onValue as (...args: unknown[]) => void);
  });
}

function describeMatcher(matcher: WaitMatcher<never>): string {
  if (typeof matcher === "string") return JSON.stringify(matcher);
  if (matcher instanceof RegExp) return String(matcher);
  return "<predicate>";
}
