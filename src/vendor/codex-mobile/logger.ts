// Narrow local type replacement for the upstream logger module.
export type Logger = {
  debug(fields: unknown, message: string): void;
  info(fields: unknown, message: string): void;
  warn(fields: unknown, message: string): void;
};
