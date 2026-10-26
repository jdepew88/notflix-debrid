import { describe, expect, it } from "vitest";
import { parseVtt, sessionPlaybackUrl, trackLabel, type EngineSessionView } from "./playback-client";
import { isHlsSource } from "./cast-media";

describe("parseVtt", () => {
  it("parses FFmpeg WebVTT output (hours optional, tags stripped)", () => {
    const cues = parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n<i>Hello</i>\n\n01:00:10.250 --> 01:00:12.000 align:start\nLine one\nLine two\n");
    expect(cues).toEqual([
      { start: 1, end: 2.5, text: "Hello" },
      { start: 3610.25, end: 3612, text: "Line one\nLine two" },
    ]);
  });
});

describe("engine sessions in the player", () => {
  it("are recognised as HLS so HLS.js (not native HLS) handles them", () => {
    expect(isHlsSource("/api/playback/0fc0f21012c0c67ae4251154/manifest?generation=2")).toBe(true);
    expect(isHlsSource("/api/playback/0fc0f21012c0c67ae4251154/stream")).toBe(false);
  });

  it("build playback URLs per output", () => {
    const s = { id: "abc", output: "hls", generation: 3 } as EngineSessionView;
    expect(sessionPlaybackUrl(s)).toBe("/api/playback/abc/manifest?generation=3");
    expect(sessionPlaybackUrl({ ...s, output: "progressive" })).toBe("/api/playback/abc/stream");
  });

  it("label tracks without codec jargon for the language", () => {
    expect(trackLabel({ index: 1, codec: "eac3", language: "eng", channels: 6 }, "audio")).toBe("English · E-AC-3 · 5.1");
    expect(trackLabel({ index: 3, codec: "hdmv_pgs_subtitle", language: "spa", kind: "image", forced: true }, "subtitle")).toBe("Spanish · Forced · (image)");
  });
});
