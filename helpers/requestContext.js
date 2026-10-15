import { AsyncLocalStorage } from "node:async_hooks";

// Per-request context shared with helpers that don't receive `req`
// (for example Decrypt), without threading it through every call.
export const requestContext = new AsyncLocalStorage();

export const getRequestContext = () => requestContext.getStore() || null;
