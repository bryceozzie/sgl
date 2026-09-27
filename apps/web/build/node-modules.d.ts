/**
 * The little of Node that `help-plugin.ts` uses to read `apps/web/help/`.
 * `@types/node` is not part of this app's toolchain (see `vite.config.ts`),
 * and adding it would bring Node's globals into the browser code's types, so
 * these three modules are declared here, for the build scripts only.
 */

declare module 'node:fs' {
  interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
  }
  export function readdirSync(path: string, options: { readonly withFileTypes: true }): Dirent[];
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function relative(from: string, to: string): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: URL | string): string;
}
