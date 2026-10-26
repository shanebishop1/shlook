import { close, constants, fstat, read } from "node:fs";
import { lstat, open, readdir, readlink, realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join, resolve } from "node:path";
import { getSystemErrorName } from "node:util";

export interface InputHandle {
  readonly fd: number;
  stat(): Promise<Stats>;
  read(
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

const inputOpenFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

// Node cannot adopt an openat fd as a FileHandle. Keep ownership explicit and
// never reopen it by pathname; all metadata and reads use this same descriptor.
function ownedDescriptor(fd: number): InputHandle {
  let closed = false;
  function active(): number {
    if (closed) throw new Error("publish input descriptor is closed");
    return fd;
  }
  return {
    fd,
    stat: () =>
      new Promise((accept, reject) => {
        fstat(active(), (error, metadata) => (error ? reject(error) : accept(metadata)));
      }),
    read: (bytes, offset, length, position) =>
      new Promise((accept, reject) => {
        read(active(), bytes, offset, length, position, (error, bytesRead) =>
          error ? reject(error) : accept({ bytesRead }),
        );
      }),
    close: () =>
      new Promise((accept, reject) => {
        const descriptor = active();
        closed = true;
        close(descriptor, (error) => (error ? reject(error) : accept()));
      }),
  };
}

async function darwinFilesystem() {
  // Lazy: Linux keeps its existing procfs implementation and never loads FFI.
  // Koffi ships macOS arm64/x64 binaries; no install script/compiler is needed.
  const { default: koffi } = await import("koffi");
  const libc = koffi.load("/usr/lib/libSystem.B.dylib");
  // No O_CREAT calls: the optional mode argument must never be needed.
  const openat = libc.func("int openat(int dirfd, const char *path, int flags)");
  // Preserve the variadic ABI: on Apple arm64 the buffer is passed on the stack,
  // not in the third argument register of a non-variadic function.
  const fcntl = libc.func("int fcntl(int fd, int command, ...)");
  // Match Darwin dirent.h's constructor AND reader aliases. fdopendir primes
  // DIR's buffer, so the legacy x64 constructor supplies 32-bit inode records
  // even if the next call uses readdir$INODE64. arm64 needs no symbol suffix.
  const inodeSuffix = process.arch === "x64" ? "$INODE64" : "";
  const fdopendir = libc.func(`fdopendir${inodeSuffix}`, "void *", ["int"]);
  const next = libc.func(`readdir${inodeSuffix}`, "void *", ["void *"]);
  // Unlike fdopendir/readdir, closedir has no inode-width alias on either ISA.
  const closedir = libc.func("int closedir(void *directory)");
  const closeFd = libc.func("int close(int fd)");

  function failure(operation: string): Error {
    const errno = koffi.errno();
    const code = getSystemErrorName(-errno);
    return Object.assign(new Error(`${operation}: ${code} for publish input`), { code });
  }

  function openChild(fd: number, name: string, flags = inputOpenFlags): number {
    const child = openat(fd, name, flags | 0x1000000); // Darwin O_CLOEXEC
    if (child < 0) throw failure("openat");
    return child;
  }

  return {
    openChild: (handle: InputHandle, name: string) => ownedDescriptor(openChild(handle.fd, name)),
    canonical(handle: InputHandle): string {
      // F_GETPATH and MAXPATHLEN from Darwin sys/fcntl.h and sys/param.h.
      const buffer = Buffer.alloc(1024);
      if (fcntl(handle.fd, 50, "void *", buffer) < 0) throw failure("F_GETPATH");
      const end = buffer.indexOf(0);
      if (end < 1) throw new Error("invalid publish input descriptor path");
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        buffer.subarray(0, end),
      );
    },
    entries(handle: InputHandle): string[] {
      // A fresh open description avoids disturbing the held directory's offset.
      const fd = openChild(handle.fd, ".", inputOpenFlags | constants.O_DIRECTORY);
      const directory = fdopendir(fd);
      if (directory === null) {
        const error = failure("fdopendir");
        closeFd(fd);
        throw error;
      }
      try {
        const names: string[] = [];
        for (;;) {
          koffi.errno(0);
          const entry = next(directory);
          if (entry === null) {
            if (koffi.errno() !== 0) throw failure("readdir");
            break;
          }
          // Only read the fixed header, then the bounded name. Copy before the
          // next readdir call invalidates libc's borrowed dirent storage.
          const recordLength = koffi.decode(entry, 16, "uint16_t") as number;
          const length = koffi.decode(entry, 18, "uint16_t") as number;
          if (length < 1 || length >= 1024 || 21 + length + 1 > recordLength) {
            throw new Error("unsafe directory entry length");
          }
          if (koffi.decode(entry, 21 + length, "uint8_t") !== 0) {
            throw new Error("unterminated directory entry name");
          }
          const bytes = Buffer.from(koffi.view(koffi.address(entry) + 21n, length));
          const name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
          if (name !== "." && name !== "..") names.push(name);
        }
        return names;
      } finally {
        closedir(directory); // owns and closes fd, including on decoding failure
      }
    },
  };
}

let darwin: ReturnType<typeof darwinFilesystem> | undefined;
function nativeFilesystem() {
  return (darwin ??= darwinFilesystem());
}

async function descriptorPath(handle: InputHandle): Promise<string> {
  const opened = await handle.stat();
  const path = `/proc/self/fd/${handle.fd}`;
  const throughDescriptor = await stat(path);
  if (throughDescriptor.dev !== opened.dev || throughDescriptor.ino !== opened.ino) {
    throw new Error("no verified file-descriptor filesystem is available");
  }
  return path;
}

export const publishFilesystem = {
  async inputPath(absolute: string): Promise<string> {
    if (process.platform !== "darwin") return absolute;
    // Only these root-owned, fixed OS aliases are allowed. Do not realpath the
    // user path: arbitrary symlink ancestors must still fail the component walk.
    const name = absolute.split("/")[1];
    if (!["var", "tmp", "etc"].includes(name)) return absolute;
    const alias = `/${name}`;
    const metadata = await lstat(alias);
    if (
      metadata.isSymbolicLink() &&
      metadata.uid === 0 &&
      (await readlink(alias)) === `private/${name}`
    ) {
      return `/private${absolute}`;
    }
    return absolute;
  },
  openRoot: (root: string) => open(root, inputOpenFlags | constants.O_DIRECTORY),
  async openChild(handle: InputHandle, name: string): Promise<InputHandle> {
    if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
      throw new Error("publish input contains an unsafe path component");
    }
    if (process.platform === "darwin") return (await nativeFilesystem()).openChild(handle, name);
    return open(join(await descriptorPath(handle), name), inputOpenFlags);
  },
  async canonical(handle: InputHandle): Promise<string> {
    const canonical =
      process.platform === "darwin"
        ? (await nativeFilesystem()).canonical(handle)
        : await realpath(await descriptorPath(handle));
    if (resolve(canonical) !== canonical) throw new Error("invalid publish input descriptor path");
    return canonical;
  },
  async entries(handle: InputHandle): Promise<string[]> {
    if (process.platform === "darwin") return (await nativeFilesystem()).entries(handle);
    return readdir(await descriptorPath(handle));
  },
};
