# Hardware acceleration

Notflix works on any PC that can run FFmpeg. A graphics card only speeds up the rare case where a
video must be **re-encoded**; most files never are.

## The playback ladder

For every title the media engine probes the actual file (container, codecs, bit depth, HDR, audio
tracks) and compares it with what *this* browser reports it can decode. It then takes the first rung
that works:

1. **Direct Play** — the original file over HTTP range requests (MP4/WebM the browser decodes).
2. **Direct Play with native audio** — same, when the browser decodes the audio track as is.
3. **Audio-only conversion** — video copied untouched, audio converted to AAC (e.g. AC-3, DTS, TrueHD).
4. **Remux** — video and audio copied into fragmented-MP4 HLS when only the container is the problem (e.g. MKV).
5. **Hardware video conversion** — decode and/or encode on a tested GPU.
6. **Software video conversion** — the processor (x264).

(The engine checks remux before audio conversion because it is cheaper; it never re-encodes video
the client can already decode.) Video is converted only when the browser cannot decode the codec
(e.g. HEVC, AV1, MPEG-2 in many browsers), the profile (10-bit H.264), the chroma format, Dolby
Vision without an HDR10 base layer, image subtitles that must be drawn in, or a resolution/bitrate
cap. HDR sources are tone-mapped to SDR when converted (GPU via libplacebo/Vulkan when available,
otherwise CPU).

## Supported acceleration

| Backend | Vendor / OS | Encoders tried | Hardware decode |
|---|---|---|---|
| NVENC / NVDEC | NVIDIA · Windows, Linux | `h264_nvenc`, `hevc_nvenc`, `av1_nvenc` | CUDA (frames verified on the GPU) |
| Quick Sync Video | Intel · Windows, Linux | `h264_qsv`, `hevc_qsv`, `av1_qsv` | D3D11VA (Windows) / VA-API (Linux) on the Intel adapter |
| AMF | AMD · Windows | `h264_amf`, `hevc_amf`, `av1_amf` | D3D11VA on the AMD adapter |
| VA-API | Intel/AMD · Linux | `h264_vaapi`, `hevc_vaapi`, `av1_vaapi` | VA-API |
| VideoToolbox | Apple · macOS | `h264_videotoolbox`, `hevc_videotoolbox` | VideoToolbox |
| Direct3D 11 video | any vendor · Windows | — (decode only) | D3D11VA per adapter |
| Software | everywhere | `libx264` | FFmpeg decoders |

**Nothing is assumed from the brand.** At startup (and when you press *Test again*) the engine:

1. lists adapters (Windows: WMI/CIM, physical PCI devices only — virtual display drivers such as
   remote-desktop adapters are flagged and ignored; Linux: `/sys/class/drm` and `/dev/dri`; macOS:
   `system_profiler`; NVIDIA details from `nvidia-smi`);
2. asks FFmpeg which encoders/decoders/hwaccels it has;
3. runs a tiny real **test encode** (15 frames of a test pattern) with every listed hardware encoder,
   and a real **test decode** of a generated sample for each codec, downloading the frames from the
   GPU so a silent fallback to the CPU cannot pass;
4. reports each backend as **verified** (a test encode succeeded), **detected** (listed or present
   but the tests failed, with the first error line as a note) or **unsupported**, and each codec as
   verified / failed / not listed / untested.

Automatic selection uses the first **verified** backend in the order NVENC → Quick Sync → AMF →
VA-API → VideoToolbox, else the processor. If the owner picks a backend that is not verified (or
that disappears after a driver change), the engine falls back to automatic selection and reports
`fallbackReason` in Settings. If a hardware conversion fails while playing, the session steps down
the ladder (hardware decode + hardware encode → CPU decode + hardware encode → CPU decode + x264)
without the viewer doing anything.

With several adapters of the same kind (e.g. two NVIDIA cards) the owner can pick one by index; on
Linux a render node (`/dev/dri/renderD129`) can be given in `engine.json`.

## Results on the development machine (real, not simulated)

Windows 11, AMD Ryzen 7 7800X3D, NVIDIA GeForce RTX 4080 SUPER (driver 617.42), AMD Radeon
integrated graphics (RDNA2), FFmpeg 8.1.1 (gyan.dev full build). Detection took about 4.3 s.

| Backend | Status | Encode | Decode |
|---|---|---|---|
| NVENC / NVDEC | verified (auto choice) | H.264 ✓ HEVC ✓ AV1 ✓ | H.264, HEVC, AV1, VP9, MPEG-2, MPEG-4 ✓ |
| AMF (Radeon iGPU) | verified | H.264 ✓ HEVC ✓ **AV1 ✗** (`CreateComponent(AMFVideoEncoderHW_AV1) failed`) | via D3D11VA: H.264, HEVC, AV1, VP9 ✓; MPEG-2, MPEG-4 ✗ |
| Quick Sync | detected only (FFmpeg lists it; no Intel adapter) | all ✗ | untested |
| Direct3D 11 decode | verified (AMD adapter) | — | H.264, HEVC, AV1, VP9 ✓ |
| VA-API, VideoToolbox | unsupported on Windows | | |

The AMD row shows why brand alone is not enough: the same driver offers AV1 encoding in FFmpeg's list,
but this GPU cannot do it.

End-to-end through Notflix (authenticated relay, output checked with ffprobe), the HEVC/AC-3 sample
played as H.264 + AAC with **NVDEC + NVENC**, **D3D11VA + AMF** and **CPU decode + x264**. The engine's
real-FFmpeg matrix (35 cases: codecs, 10-bit, 4K HDR tone mapping, seeking, cancellation, network drop,
expired links) passed 35/35 with NVENC, with AMF forced, and with acceleration off.

Intel Quick Sync, Linux VA-API and macOS VideoToolbox were **not** available here; their detection
and argument generation are covered by simulated unit tests (canned FFmpeg output for an Intel box,
an AMD box without AV1, a Linux VA-API box, a Mac, a machine without a GPU and a machine without
FFmpeg), clearly labelled `Simulated` in the engine test project. Treat them as untested on real
hardware until someone reports results.

## Without a GPU

Everything works: Direct Play, remux and audio conversion barely use the CPU; video conversion uses
x264 (`veryfast`). A modern 4-core CPU handles a 1080p conversion in real time; 4K HEVC → H.264 on
the CPU may not keep up, in which case lower **Settings → Playback → Maximum resolution** or pick
releases the browser can play directly.

## Without FFmpeg

The engine stays up and reports `ffmpeg.available: false`; setup cannot be completed until FFmpeg and
FFprobe are installed (`winget install Gyan.FFmpeg`), because even Direct Play needs FFprobe to
inspect files. New playback sessions fail with the code `ffmpeg-missing`.

## Monitoring

The player's *Stream information* panel shows the pipeline (e.g. `D3D11VA + AMF H.264`), encoder,
speed and FFmpeg CPU use. GPU utilization figures are only available for NVIDIA cards (`nvidia-smi`).
