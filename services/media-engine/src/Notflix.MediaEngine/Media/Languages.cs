namespace Notflix.MediaEngine.Media;

/// <summary>
/// ISO 639 handling for track language tags. Files tag tracks inconsistently ("en", "eng",
/// "en-US", "English"); preferences arrive as two-letter codes. Unknown stays unknown: a missing tag
/// is never treated as a match for any language.
/// </summary>
public static class Languages
{
    private static readonly Dictionary<string, string[]> Variants = new(StringComparer.OrdinalIgnoreCase)
    {
        ["en"] = ["en", "eng", "english"],
        ["es"] = ["es", "spa", "spanish", "español", "castellano", "latino"],
        ["fr"] = ["fr", "fra", "fre", "french", "français"],
        ["de"] = ["de", "deu", "ger", "german", "deutsch"],
        ["it"] = ["it", "ita", "italian", "italiano"],
        ["pt"] = ["pt", "por", "portuguese", "português"],
        ["ru"] = ["ru", "rus", "russian", "русский"],
        ["ja"] = ["ja", "jpn", "japanese"],
        ["ko"] = ["ko", "kor", "korean"],
        ["zh"] = ["zh", "zho", "chi", "chinese", "mandarin", "cantonese", "cmn", "yue"],
        ["hi"] = ["hi", "hin", "hindi"],
        ["nl"] = ["nl", "nld", "dut", "dutch"],
        ["sv"] = ["sv", "swe", "swedish"],
        ["pl"] = ["pl", "pol", "polish"],
        ["tr"] = ["tr", "tur", "turkish"],
        ["ar"] = ["ar", "ara", "arabic"],
        ["uk"] = ["uk", "ukr", "ukrainian"],
        ["cs"] = ["cs", "ces", "cze", "czech"],
        ["da"] = ["da", "dan", "danish"],
        ["fi"] = ["fi", "fin", "finnish"],
        ["no"] = ["no", "nor", "nob", "norwegian"],
        ["hu"] = ["hu", "hun", "hungarian"],
        ["th"] = ["th", "tha", "thai"],
        ["vi"] = ["vi", "vie", "vietnamese"],
        ["ta"] = ["ta", "tam", "tamil"],
        ["te"] = ["te", "tel", "telugu"],
    };

    private static readonly Dictionary<string, string> ToTwoLetter = Variants
        .SelectMany(kv => kv.Value.Select(v => (v, kv.Key)))
        .ToDictionary(x => x.v, x => x.Key, StringComparer.OrdinalIgnoreCase);

    /// <summary>Canonical two-letter code for a track tag, or null when unknown/untagged ("und").</summary>
    public static string? Normalize(string? tag)
    {
        if (string.IsNullOrWhiteSpace(tag)) return null;
        var t = tag.Trim().ToLowerInvariant();
        if (t is "und" or "unknown" or "mis" or "mul" or "zxx") return null;
        var primary = t.Split('-', '_')[0];
        if (ToTwoLetter.TryGetValue(primary, out var code)) return code;
        return primary.Length == 2 ? primary : null;
    }

    public static bool Matches(string? trackTag, string preference) =>
        Normalize(trackTag) is { } code && code == Normalize(preference);
}
