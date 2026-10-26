import { describe, expect, it } from "vitest";
import { parseStreamTraits, playbackScore, rankStreamsForPlayback } from "./source-ranking";

const best = { maxResolution: 2160, quality: "best" as const, hevcSupported: true };

describe("parseStreamTraits", () => {
  it("reads Torrentio cached/uncached markers, resolution, size and codecs", () => {
    const t = parseStreamTraits("[RD+] Torrentio 4k Movie.2023.2160p.WEB-DL.DDP5.1.HDR.x265 💾 18.2 GB 👤 140");
    expect(t).toMatchObject({ cached: true, uncached: false, resolution: 2160, videoCodec: "hevc", hdr: true, webSource: true, audio: "eac3", seeders: 140 });
    expect(t.sizeGb).toBeCloseTo(18.2);
    expect(parseStreamTraits("[RD download] Torrentio 1080p x264").uncached).toBe(true);
  });

  it("flags CAM/TS releases", () => {
    expect(parseStreamTraits("Movie 2024 HDCAM x264").lowQualitySource).toBe("cam");
    expect(parseStreamTraits("Movie 2024 1080p HDTS").lowQualitySource).toBe("ts");
  });
});

describe("rankStreamsForPlayback", () => {
  const streams = [
    { name: "[RD download] Torrentio", title: "Movie.2160p.BluRay.REMUX.HEVC 💾 58 GB" },
    { name: "[RD+] Torrentio", title: "Movie.1080p.WEB-DL.x264.AAC 💾 2.1 GB" },
    { name: "[RD+] Torrentio", title: "Movie.2160p.WEB-DL.HDR.x265 💾 16 GB" },
    { name: "[RD+] Torrentio", title: "Movie.HDCAM.x264 💾 1.4 GB" },
    { name: "[RD+] Torrentio", title: "Movie.2160p.BluRay.REMUX.HEVC.TrueHD 💾 62 GB" },
  ];

  it("prefers cached, high resolution, sensibly sized releases; never an uncached one first", () => {
    const order = rankStreamsForPlayback(streams, best);
    expect(order[0]).toBe(2); // cached 4K web encode
    expect(order.indexOf(0)).toBe(streams.length - 1); // uncached last
    expect(order.indexOf(3)).toBeGreaterThan(order.indexOf(1)); // CAM below real releases
  });

  it("respects the maximum resolution and data-saver preference", () => {
    expect(rankStreamsForPlayback(streams, { maxResolution: 1080, quality: "best" })[0]).toBe(1);
    expect(rankStreamsForPlayback(streams, { maxResolution: 2160, quality: "data-saver" })[0]).toBe(1);
  });

  it("penalises large remuxes for balanced quality", () => {
    const remux = parseStreamTraits("[RD+] 2160p REMUX 💾 60 GB");
    const encode = parseStreamTraits("[RD+] 2160p WEB-DL x265 💾 15 GB");
    expect(playbackScore(encode, { maxResolution: 2160, quality: "balanced" })).toBeGreaterThan(
      playbackScore(remux, { maxResolution: 2160, quality: "balanced" })
    );
  });
});
