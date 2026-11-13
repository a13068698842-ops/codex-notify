// Narrow local type replacement for the upstream domain module.
export type CodexServerRequest = { method: string; id: string | number; params: Record<string, unknown> };
