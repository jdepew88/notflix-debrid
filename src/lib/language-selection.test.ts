import { describe, expect, it } from "vitest";
import {
  candidateScore,
  languageHintScore,
  parseLanguageHints,
  rankStreamsForPlayback,
  verifiedLanguageScore,
} from "./source-ranking";
import { normalizeProfilePreferences, orderedAudioLanguages, DEFAULT_PROFILE_PREFERENCES } from "./profile-preferences";

const en = { maxResolution: 2160, quality: "best" as const, audioLanguages: ["en"] };

describe("release-name language hints", () => {
  it("reads flags and ISO tags from the tail of a release name", () => {
    const h = parseLanguageHints("[RD+] Movie.2023.2160p.WEB-DL.x265 🇷🇺 💾 12 GB");
    expect(h.codes).toEqual(["ru"]);
    expect(h.likelyNonEnglishOnly).toBe(true);
    expect(parseLanguageHints("Movie 2023 1080p MULTi x264 💾 8 GB").multi).toBe(true);
    expect(parseLanguageHints("Movie 2023 1080p Dual Audio RUS ENG").likelyNonEnglishOnly).toBe(false);
  });

  it("does not read the title as a language tag", () => {
    // "It" (2017) must not become Italian, and the English title proves nothing about audio.
    const h = parseLanguageHints("It.2017.1080p.BluRay.x264 💾 9 GB");
    expect(h.codes).toEqual([]);
    expect(languageHintScore(h, ["en"])).toBe(0);
  });

  it("verified data dominates hints; unknown is not treated as wrong", () => {
    expect(verifiedLanguageScore(["en"], 0, ["en"])).toBe(700);
    expect(verifiedLanguageScore(["ru", "fr"], 0, ["en", "fr"])).toBe(450);
    expect(verifiedLanguageScore(["ru"], 0, ["en"])).toBe(-600);
    expect(verifiedLanguageScore([], 1, ["en"])).toBe(-40);
  });
});

describe("language-aware automatic source selection", () => {
  const A = "[RD+] Movie.2023.2160p.WEB-DL.x265 RUS 💾 14 GB";
  const B = "[RD+] Movie.2023.2160p.WEB-DL.x265 MULTi 💾 16 GB";
  const C = "[RD+] Movie.2023.1080p.WEB-DL.x264 💾 4 GB";

  it("pre-probe: a Russian-only hint drops below an unknown 1080p; MULTi leads", () => {
    const order = rankStreamsForPlayback([{ title: A }, { title: B }, { title: C }], en);
    expect(order[0]).toBe(1);
    expect(order[order.length - 1]).toBe(0);
  });

  it("post-probe: 4K with verified English+French beats 4K Russian-only and 1080p English", () => {
    const sA = candidateScore(A, en, { audioLanguages: ["ru"], untaggedAudioTracks: 0 });
    const sB = candidateScore(B, en, { audioLanguages: ["en", "fr"], untaggedAudioTracks: 0 });
    const sC = candidateScore(C, en, { audioLanguages: ["en"], untaggedAudioTracks: 0 });
    expect(sB).toBeGreaterThan(sC);
    expect(sC).toBeGreaterThan(sA);
  });

  it("a 1080p release with confirmed English beats a 4K release with only Russian", () => {
    const fourK = candidateScore("[RD+] Movie 2160p REMUX 💾 50 GB", en, { audioLanguages: ["ru"], untaggedAudioTracks: 0 });
    const hd = candidateScore("[RD+] Movie 1080p WEB-DL 💾 5 GB", en, { audioLanguages: ["en"], untaggedAudioTracks: 0 });
    expect(hd).toBeGreaterThan(fourK);
  });
});

describe("profile preferences", () => {
  it("validates input and keeps defaults for junk", () => {
    const p = normalizeProfilePreferences({
      audioLanguage: "<script>",
      secondaryAudioLanguage: "fr",
      subtitleLanguage: "off",
      subtitleStyle: { size: "huge", color: "yellow" },
      subtitleOffsetMs: 999_999,
      autoplayPreviews: "yes",
      titlePrefs: { "tmdb-1": { audioLanguage: "ru", subtitleLanguage: "off", sourceHash: "ABCDEF0123456789", updatedAt: 1 } },
    });
    expect(p.audioLanguage).toBe("en");
    expect(p.secondaryAudioLanguage).toBe("fr");
    expect(p.subtitleLanguage).toBe("off");
    expect(p.subtitleStyle).toEqual({ ...DEFAULT_PROFILE_PREFERENCES.subtitleStyle, color: "yellow" });
    expect(p.subtitleOffsetMs).toBe(30_000);
    expect(p.autoplayPreviews).toBe(false);
    expect(p.titlePrefs["tmdb-1"]).toMatchObject({ audioLanguage: "ru", subtitleLanguage: "off", sourceHash: "abcdef0123456789" });
    expect(orderedAudioLanguages(p, "ja")).toEqual(["ja", "en", "fr"]);
  });

  it("defaults: English audio, previews off, autoplay next on", () => {
    expect(DEFAULT_PROFILE_PREFERENCES.audioLanguage).toBe("en");
    expect(DEFAULT_PROFILE_PREFERENCES.autoplayPreviews).toBe(false);
    expect(DEFAULT_PROFILE_PREFERENCES.autoplayNextEpisode).toBe(true);
  });
});
