import { expect, it } from "vitest";
import { runProcess } from "../src/process.js";

it("the live smoke check accepts subtitles and rejects HTTP-200 failure notices", async () => {
  const run = (failed: boolean) => runProcess(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    process.env.PUBLIC_URL = 'https://autosub.test';
    process.env.INSTALL_TOKEN = 'test';
    process.argv = ['node', 'smoke', 'tt1'];
    globalThis.fetch = async (url, options) => {
      assert(options.signal);
      assert(options.headers['User-Agent'].includes('AutoSubSmoke'));
      const json = (body) => new Response(JSON.stringify(body));
      if (url.includes('/stream/')) return json({ streams: [{ url: 'https://autosub.test/test/play/p' }] });
      if (url.includes('/play/')) return new Response(null, { status: 302 });
      if (url.includes('/subtitles/')) return json({ subtitles: [{ url: 'https://autosub.test/test/file/j.srt' }] });
      return new Response('1\\n00:00:01,000 --> 00:00:02,000\\ncaption\\n', {
        headers: ${failed ? "{ 'x-autosub-state': 'failed' }" : "{ 'x-autosub-provider': 'test' }"},
      });
    };
    await import('./scripts/live-smoke.mjs');
  `]);
  expect(JSON.parse((await run(false)).stdout.toString()).provider).toBe("test");
  await expect(run(true)).rejects.toThrow(/exited 1/);
});
