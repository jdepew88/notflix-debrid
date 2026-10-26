using System.Buffers.Binary;

namespace Notflix.MediaEngine.Playback;

/// <summary>
/// Minimal ISO-BMFF reader: track timescales from the init segment (moov/trak/mdhd) and the
/// first decode time of a media segment (moof/traf/tfdt). Used to learn exactly where a
/// generation starts on the source timeline after an input seek on a keyframe boundary.
/// </summary>
public static class Fmp4Inspector
{
    public static Dictionary<uint, uint> ReadTimescales(ReadOnlySpan<byte> init)
    {
        var result = new Dictionary<uint, uint>();
        foreach (var moov in Children(init, "moov"))
        foreach (var trak in Children(moov, "trak"))
        {
            uint? trackId = null, timescale = null;
            foreach (var tkhd in Children(trak, "tkhd"))
            {
                var version = tkhd[0];
                var offset = version == 1 ? 4 + 16 : 4 + 8;
                if (tkhd.Length >= offset + 4) trackId = BinaryPrimitives.ReadUInt32BigEndian(tkhd[offset..]);
            }
            foreach (var mdia in Children(trak, "mdia"))
            foreach (var mdhd in Children(mdia, "mdhd"))
            {
                var version = mdhd[0];
                var offset = version == 1 ? 4 + 16 : 4 + 8;
                if (mdhd.Length >= offset + 4) timescale = BinaryPrimitives.ReadUInt32BigEndian(mdhd[offset..]);
            }
            if (trackId is { } id && timescale is { } ts && ts > 0) result[id] = ts;
        }
        return result;
    }

    /// <summary>Earliest decode time over all tracks (each traf considered).</summary>
    public static double? EarliestDecodeTimeSeconds(ReadOnlySpan<byte> segment, IReadOnlyDictionary<uint, uint> timescales)
    {
        double? earliest = null;
        foreach (var moof in Children(segment, "moof"))
        {
            foreach (var traf in Children(moof, "traf"))
            {
                uint? trackId = null;
                ulong? baseTime = null;
                foreach (var tfhd in Children(traf, "tfhd"))
                    if (tfhd.Length >= 8) trackId = BinaryPrimitives.ReadUInt32BigEndian(tfhd[4..]);
                foreach (var tfdt in Children(traf, "tfdt"))
                {
                    var version = tfdt[0];
                    if (version == 1 && tfdt.Length >= 12) baseTime = BinaryPrimitives.ReadUInt64BigEndian(tfdt[4..]);
                    else if (tfdt.Length >= 8) baseTime = BinaryPrimitives.ReadUInt32BigEndian(tfdt[4..]);
                }
                if (trackId is { } id && baseTime is { } bt && timescales.TryGetValue(id, out var ts))
                {
                    var seconds = bt / (double)ts;
                    earliest = earliest is null ? seconds : Math.Min(earliest.Value, seconds);
                }
            }
            if (earliest is not null) break;
        }
        return earliest;
    }

    /// <summary>Box payloads (after the 8/16-byte header) with the given type, at one nesting level.</summary>
    private static List<byte[]> Children(ReadOnlySpan<byte> data, string type)
    {
        var found = new List<byte[]>();
        var pos = 0;
        while (pos + 8 <= data.Length)
        {
            ulong size = BinaryPrimitives.ReadUInt32BigEndian(data[pos..]);
            var boxType = System.Text.Encoding.ASCII.GetString(data.Slice(pos + 4, 4));
            var header = 8;
            if (size == 1)
            {
                if (pos + 16 > data.Length) break;
                size = BinaryPrimitives.ReadUInt64BigEndian(data[(pos + 8)..]);
                header = 16;
            }
            else if (size == 0)
            {
                size = (ulong)(data.Length - pos);
            }
            if (size < (ulong)header || (ulong)pos + size > (ulong)data.Length) break;
            if (boxType == type) found.Add(data.Slice(pos + header, (int)size - header).ToArray());
            pos += (int)size;
        }
        return found;
    }

    private static List<byte[]> Children(byte[] data, string type) => Children(data.AsSpan(), type);
}
