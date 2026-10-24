// Hand-encoded GNU extension records with short decoded values and NUL padding.
// The declared extension size, not an overlong filename, is the attack boundary.
function header(name: string, type: string, size: number, link = ""): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100);
  block.write("0000644\0", 100, 8);
  block.write("0000000\0", 108, 8);
  block.write("0000000\0", 116, 8);
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  block.write("00000000000\0", 136, 12);
  block.fill(32, 148, 156);
  block.write(type, 156, 1);
  block.write(link, 157, 100);
  block.write("ustar\0", 257, 6);
  block.write("00", 263, 2);
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

export function gnuExtensionHeader(type: "L" | "K", size: number): Buffer {
  return header("././@LongLink", type, size);
}

export function gnuExtensionArchive(type: "L" | "K", size: number): Buffer {
  const body = Buffer.alloc(size);
  body.write(type === "L" ? "short\0" : "short-target\0");
  const payload = type === "L" ? Buffer.from("abc") : Buffer.alloc(0);
  return Buffer.concat([
    gnuExtensionHeader(type, size), body, Buffer.alloc((512 - size % 512) % 512),
    header(type === "L" ? "ignored" : "short", type === "L" ? "0" : "2", payload.length, type === "K" ? "ignored" : ""),
    payload, Buffer.alloc((512 - payload.length % 512) % 512), Buffer.alloc(1024),
  ]);
}
