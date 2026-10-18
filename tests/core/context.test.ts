import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { ignoreClosedPipe } from "../../src/core/context.js";

function streamError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code, errno: -32, syscall: "write" });
}

describe("ignoreClosedPipe", () => {
  it("ignores an EPIPE when the reader closes the stream", () => {
    const stream = new EventEmitter();
    ignoreClosedPipe(stream);

    expect(() => stream.emit("error", streamError("EPIPE"))).not.toThrow();
  });

  it("throws any other stream error", () => {
    const stream = new EventEmitter();
    ignoreClosedPipe(stream);

    expect(() => stream.emit("error", streamError("EIO"))).toThrow("write EIO");
  });
});
