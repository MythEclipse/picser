// Minimal declaration to satisfy TypeScript when consumer libs expect 'minimatch' types.
// This is intentionally minimal; if stricter typing is desired we can replace with
// a full declaration or add proper @types/minimatch when available.

declare module "minimatch" {
  interface IOptions {
    matchBase?: boolean | undefined;
    dot?: boolean | undefined;
    flipNegate?: boolean | undefined;
  }

  function minimatch(path: string, pattern: string, options?: IOptions): boolean;
  namespace minimatch {}
  export = minimatch;
}
