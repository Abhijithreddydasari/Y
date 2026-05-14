// Replicates lib/api.ts's SSE parser logic against the live backend, so we
// can verify the CRLF fix without bringing Next or jsdom into the loop.
//
// Usage:  node scripts/test_sse_parser.mjs

// We need a real PNG with readable content so gemma4:e4b decides to teach
// (rather than just confess it sees nothing). Use the Python smoke generator
// that already produces a Newton's-law style whiteboard.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function newtonPng() {
  const dir = mkdtempSync(join(tmpdir(), "y-sse-"));
  const out = join(dir, "newton.png");
  const py = `from PIL import Image, ImageDraw, ImageFont
try: f = ImageFont.truetype('arial.ttf', 36)
except OSError: f = ImageFont.load_default()
img = Image.new('RGB', (900, 600), 'white')
d = ImageDraw.Draw(img)
d.text((80, 80), 'F = m * a, m = 2 kg, F = 10 N, a = ?', fill='#111', font=f)
img.save(r'${out.replaceAll("\\", "\\\\")}')`;
  execSync(`python -c "${py.replaceAll("\n", "; ").replaceAll('"', '\\"')}"`, {
    stdio: ["ignore", "ignore", "ignore"],
  });
  void writeFileSync; // imported but unused otherwise; keep import side-effects minimal
  return readFileSync(out);
}

function handleFrame(frame, counts) {
  let event = "message";
  const dataLines = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return;
  let payload;
  try { payload = JSON.parse(dataLines.join("\n")); } catch { return; }
  counts[event] = (counts[event] ?? 0) + 1;
  if (event === "primitive") console.log("  primitive:", payload);
  if (event === "error") console.log("  ERROR:", payload);
}

async function main() {
  const form = new FormData();
  form.append("image", new Blob([newtonPng()], { type: "image/png" }), "canvas.png");

  console.log("[POST] /lesson");
  const t0 = Date.now();
  const res = await fetch("http://127.0.0.1:8000/lesson", {
    method: "POST",
    body: form,
  });
  console.log("status:", res.status);
  if (!res.ok || !res.body) {
    console.error("FAIL: non-OK response");
    process.exit(1);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const counts = {};

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      handleFrame(frame, counts);
    }
  }
  if (buf.trim()) handleFrame(buf, counts);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[done] ${elapsed}s  counts:`, counts);
  const primitives = counts.primitive ?? 0;
  if (primitives === 0) {
    console.error("FAIL: 0 primitive events parsed");
    process.exit(2);
  }
  console.log(`PASS: parsed ${primitives} primitives`);
}

main().catch((e) => { console.error(e); process.exit(3); });
