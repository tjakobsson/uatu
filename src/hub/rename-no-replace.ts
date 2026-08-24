// A true no-replace directory rename, when the platform has one. POSIX
// rename() silently replaces an empty destination directory, and no
// pathname or (dev, ino) comparison can close that race — inode numbers
// are reusable the moment a directory is unlinked. Darwin exposes
// renamex_np(RENAME_EXCL) and Linux renameat2(RENAME_NOREPLACE), both of
// which make the kernel itself refuse an existing destination atomically.
//
// Loading is best-effort: a platform or libc without the symbol (musl
// without renameat2, some exotic environment) yields null and callers keep
// their claimed-placeholder fallback strategy.

import { dlopen, FFIType, ptr } from "bun:ffi";

// Returns 0 on success, non-zero on failure. errno does not cross the FFI
// boundary reliably, so callers disambiguate failures themselves.
export type NoReplaceRename = (from: string, to: string) => number;

const RENAME_EXCL_DARWIN = 0x00000004;
const RENAME_NOREPLACE_LINUX = 1;
const AT_FDCWD_LINUX = -100;

function nulTerminated(value: string): Uint8Array {
  return new TextEncoder().encode(`${value}\0`);
}

export function loadNoReplaceRename(): NoReplaceRename | null {
  try {
    if (process.platform === "darwin") {
      const lib = dlopen("libSystem.B.dylib", {
        renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      });
      return (from, to) =>
        lib.symbols.renamex_np(ptr(nulTerminated(from)), ptr(nulTerminated(to)), RENAME_EXCL_DARWIN) as number;
    }
    if (process.platform === "linux") {
      const lib = dlopen("libc.so.6", {
        renameat2: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      });
      return (from, to) =>
        lib.symbols.renameat2(
          AT_FDCWD_LINUX,
          ptr(nulTerminated(from)),
          AT_FDCWD_LINUX,
          ptr(nulTerminated(to)),
          RENAME_NOREPLACE_LINUX,
        ) as number;
    }
  } catch {
    // dlopen failed or the symbol is absent; the caller falls back.
  }
  return null;
}
