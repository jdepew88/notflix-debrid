using Notflix.MediaEngine.Media;
using Notflix.MediaEngine.Playback;

namespace Notflix.MediaEngine.Tests;

public class AudioLanguageTests
{
    private static MediaProbe Probe(params (int index, string? lang, int channels, bool def, string? title)[] tracks) => new()
    {
        FormatName = "matroska,webm",
        Video = new VideoStreamInfo { Codec = "h264", Width = 1920, Height = 1080 },
        Audio = tracks.Select(t => new AudioStreamInfo { Index = t.index, Codec = "ac3", Language = t.lang, Channels = t.channels, Default = t.def, Title = t.title }).ToList(),
    };

    private static PlaybackPreferences Prefs(params string[] langs) => new() { AudioLanguages = langs.ToList() };

    [Theory]
    [InlineData("eng", "en")]
    [InlineData("en-US", "en")]
    [InlineData("English", "en")]
    [InlineData("rus", "ru")]
    [InlineData("fre", "fr")]
    [InlineData("ger", "de")]
    [InlineData("und", null)]
    [InlineData("", null)]
    [InlineData(null, null)]
    public void NormalisesTrackTags(string? tag, string? expected) => Assert.Equal(expected, Languages.Normalize(tag));

    [Fact]
    public void FirstTrackIsNotAssumedEnglish()
    {
        // Russian first and default, English second: English preference must pick track 2.
        var probe = Probe((1, "rus", 6, true, null), (2, "eng", 6, false, null));
        var d = PlaybackDecider.Decide(probe, ClientCapabilities.Conservative, Prefs("en"), new HardwareCapabilities { FfmpegAvailable = true }, new EngineOptions());
        Assert.Equal(2, d.AudioStreamIndex);
        Assert.Equal("en", d.SelectedAudioLanguage);
        Assert.True(d.AudioLanguageMatched);
        Assert.Equal(new[] { "ru", "en" }, d.AvailableAudioLanguages);
    }

    [Fact]
    public void SecondaryLanguageIsUsedWhenPrimaryIsMissing()
    {
        var probe = Probe((1, "rus", 6, true, null), (2, "fra", 2, false, null));
        var picked = PlaybackDecider.SelectAudio(probe, null, Prefs("en", "fr"));
        Assert.Equal(2, picked!.Index);
    }

    [Fact]
    public void UntaggedTrackIsUnknownNotEnglish()
    {
        var probe = Probe((1, null, 2, true, null), (2, "rus", 6, false, null));
        var d = PlaybackDecider.Decide(probe, ClientCapabilities.Conservative, Prefs("en"), new HardwareCapabilities { FfmpegAvailable = true }, new EngineOptions());
        Assert.Equal(1, d.AudioStreamIndex);          // falls back to the default track
        Assert.Null(d.SelectedAudioLanguage);         // but never claims it is English
        Assert.Null(d.AudioLanguageMatched);
    }

    [Fact]
    public void PreferredLanguageMissing_ReportsMismatch()
    {
        var probe = Probe((1, "rus", 6, true, null));
        var d = PlaybackDecider.Decide(probe, ClientCapabilities.Conservative, Prefs("en"), new HardwareCapabilities { FfmpegAvailable = true }, new EngineOptions());
        Assert.Equal("ru", d.SelectedAudioLanguage);
        Assert.False(d.AudioLanguageMatched);
    }

    [Fact]
    public void OriginalLanguageWinsWhenRequested()
    {
        var probe = Probe((1, "eng", 6, true, null), (2, "jpn", 6, false, null));
        var prefs = new PlaybackPreferences { AudioLanguages = ["en"], OriginalLanguage = "ja", PreferOriginalAudio = true };
        Assert.Equal(2, PlaybackDecider.SelectAudio(probe, null, prefs)!.Index);
        prefs.PreferOriginalAudio = false;
        Assert.Equal(1, PlaybackDecider.SelectAudio(probe, null, prefs)!.Index);
    }

    [Fact]
    public void CommentarySkipped_AndSurroundPreferenceHonoured()
    {
        var probe = Probe((1, "eng", 2, true, "Director's Commentary"), (2, "eng", 2, false, "Stereo"), (3, "eng", 6, false, "Surround"));
        Assert.Equal(2, PlaybackDecider.SelectAudio(probe, null, Prefs("en"))!.Index);
        Assert.Equal(3, PlaybackDecider.SelectAudio(probe, null, new PlaybackPreferences { AudioLanguages = ["en"], Surround = true })!.Index);
    }
}
