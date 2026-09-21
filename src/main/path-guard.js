// Path-validation guard for native file I/O (SHELL-02).
//
// Deliberately free of any `electron` import, and of any `node:fs*` import,
// so the traversal/NUL-byte checks can be unit-tested under plain Node/vitest
// without launching an Electron process or touching the filesystem. `text-file.js`
// and `dialogs.js` are this module's only intended consumers, mirroring
// `image-fetch.js`'s exclusive-consumer relationship with `url-guard.js`.
//
// Unlike `protocol.js`'s `app://` traversal guard, this module has NO single
// root to confine to -- the user can open a file anywhere on disk, including a
// UNC share (`\\server\share\...`). Its job is therefore narrower and, in one
// respect, inverted from a typical "reject anything unusual" guard: it rejects
// traversal (`..` segments) and NUL-byte injection only, and it deliberately
// does NOT reject on path length or UNC form -- a UNC path and a path over 260
// characters must both be PERMITTED (04-CONTEXT.md, criterion 2).
//
// File-vs-directory validation (`stats.isFile()`) is NOT this module's job --
// that happens in text-file.js after a real `fs.stat` call, because that
// requires a filesystem round trip this pure module must not perform.
//
// Do NOT call `path.normalize`/`path.resolve` or add a length check here:
// normalizing before the segment check would silently collapse a `..\..\`
// pair and defeat the traversal check, and any length check would violate
// the UNC/long-path requirement above.

const NUL_BYTE = String.fromCharCode(0)

/**
 * True only when `candidatePath` is safe to hand to a filesystem call --
 * i.e. it is a non-empty string, contains no NUL byte, and contains no
 * literal `..` path segment (checked pre-normalization, on both `/` and `\`
 * separators). UNC paths and paths over 260 characters are explicitly
 * permitted; this function fails closed on any non-string/empty input.
 */
export function isSafeFilePath (candidatePath) {
  if (typeof candidatePath !== 'string' || candidatePath.length === 0) return false

  // Embedded NUL byte -- a classic filter-bypass/truncation vector at the OS
  // level (a NUL-terminated path can be silently truncated by native APIs).
  if (candidatePath.includes(NUL_BYTE)) return false

  // Split on both separators so a traversal segment is caught regardless of
  // which slash style the string uses (or mixes). This is a segment check,
  // not a resolve -- see header comment for why normalize/resolve are unsafe
  // to use here.
  const segments = candidatePath.split(/[\\/]+/)
  if (segments.some((segment) => segment === '..')) return false

  return true
}
