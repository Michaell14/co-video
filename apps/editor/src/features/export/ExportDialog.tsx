import { CircleCheck, Download, Film, Info, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  describeFps,
  formatBytes,
  formatClock,
  framesToSeconds,
  FRAME_RATE_PRESETS,
  sequenceEnd,
} from '@tandem/core';
import {
  AUDIO_CODEC_LABELS,
  CONTAINER_LABELS,
  exportProject,
  ExportCancelled,
  probeEncoders,
  suggestBitrate,
  VIDEO_CODEC_LABELS,
  type CodecSupport,
  type ExportContainer,
  type ExportDynamicRange,
  type ExportProgress,
  type ExportSettings,
} from '@tandem/engine';
import { usePlayerState, useProject, useSession } from '../../session/hooks';
import { downloadBlob } from '../../state/commands';
import { Button, Dialog, NumberField, Segmented, Select } from '../../ui/core';
import { Row } from '../inspector/controls';
import './export.css';

type Quality = 'low' | 'medium' | 'high' | 'max';
type VideoCodec = ExportSettings['videoCodec'];
type AudioCodec = ExportSettings['audioCodec'];

interface Preset {
  id: string;
  label: string;
  hint: string;
  apply: (base: Draft, project: { width: number; height: number }) => Partial<Draft>;
}

interface Draft {
  container: ExportContainer;
  videoCodec: VideoCodec;
  audioCodec: AudioCodec;
  /** Output height; width follows the project aspect unless `customWidth` is set. */
  height: number;
  fps: string;
  quality: Quality;
  customMbps: number | null;
  audioKbps: number;
  range: 'all' | 'inout';
  dynamicRange: ExportDynamicRange;
  hardware: ExportSettings['hardwareAcceleration'];
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

const PRESETS: Preset[] = [
  {
    id: 'match',
    label: 'Match project',
    hint: 'Project size and frame rate',
    apply: (_d, p) => ({
      container: 'mp4',
      videoCodec: 'avc',
      height: p.height,
      fps: 'project',
      quality: 'high',
    }),
  },
  {
    id: 'web',
    label: 'Web 1080p',
    hint: 'H.264 MP4, plays everywhere',
    apply: (_d, p) => ({
      container: 'mp4',
      videoCodec: 'avc',
      height: Math.min(p.height, p.width >= p.height ? 1080 : 1920),
      fps: 'project',
      quality: 'high',
    }),
  },
  {
    id: '4k',
    label: '4K master',
    hint: 'High bitrate for archive / upload',
    apply: (_d, p) => ({
      container: 'mp4',
      videoCodec: 'avc',
      height: p.width >= p.height ? 2160 : 3840,
      fps: 'project',
      quality: 'max',
    }),
  },
  {
    id: 'small',
    label: 'Small file',
    hint: 'AV1 / VP9 for sharing',
    apply: (_d, p) => ({
      container: 'webm',
      videoCodec: 'av1',
      height: Math.min(p.height, 1080),
      fps: 'project',
      quality: 'medium',
    }),
  },
  {
    id: 'hdr',
    label: 'HDR10',
    hint: '10-bit Rec.2100 PQ',
    apply: (_d, p) => ({
      container: 'mp4',
      videoCodec: 'hevc',
      height: p.height,
      fps: 'project',
      quality: 'max',
      dynamicRange: 'pq',
    }),
  },
  { id: 'audio', label: 'Audio only', hint: 'Uncompressed WAV', apply: () => ({ container: 'wav' }) },
];

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; progress: ExportProgress }
  | { kind: 'done'; blob: Blob | null; name: string; seconds: number; bytes: number | null }
  | { kind: 'error'; message: string };

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const project = useProject((p) => p);
  const range = usePlayerState().range;
  const s = project.settings;
  const hdrProject = s.colorMode !== 'sdr';
  const [preset, setPreset] = useState('match');
  const [draft, setDraft] = useState<Draft>({
    container: 'mp4',
    videoCodec: 'avc',
    audioCodec: 'aac',
    height: s.height,
    fps: 'project',
    quality: 'high',
    customMbps: null,
    audioKbps: 192,
    range: range ? 'inout' : 'all',
    dynamicRange: hdrProject ? (s.colorMode === 'hdr-hlg' ? 'hlg' : 'pq') : 'sdr',
    hardware: 'no-preference',
  });
  const [support, setSupport] = useState<CodecSupport | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const abort = useRef<AbortController | null>(null);
  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const audioOnly = draft.container === 'wav';
  const hdr = hdrProject && draft.dynamicRange !== 'sdr' && !audioOnly;
  const width = even((draft.height * s.width) / s.height);
  const height = even(draft.height);
  const rate =
    draft.fps === 'project'
      ? { fpsNum: s.fpsNum, fpsDen: s.fpsDen }
      : (FRAME_RATE_PRESETS.find((f) => f.label === draft.fps) ?? { fpsNum: s.fpsNum, fpsDen: s.fpsDen });
  const fps = rate.fpsNum / rate.fpsDen;

  // Ask the browser which encoders it really has for this size.
  useEffect(() => {
    let cancelled = false;
    setSupport(null);
    void probeEncoders(draft.container, width, height, hdr).then((sup) => {
      if (cancelled) return;
      setSupport(sup);
      setDraft((d) => ({
        ...d,
        videoCodec: sup.video.includes(d.videoCodec) || !sup.video.length ? d.videoCodec : sup.video[0],
        audioCodec: sup.audio.includes(d.audioCodec) || !sup.audio.length ? d.audioCodec : sup.audio[0],
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [draft.container, width, height, hdr]);

  const end = sequenceEnd(project);
  const span =
    draft.range === 'inout' && range ? { in: range.in, out: Math.min(range.out, end) } : { in: 0, out: end };
  const seconds = framesToSeconds(Math.max(0, span.out - span.in), s);
  const videoBitrate = draft.customMbps
    ? draft.customMbps * 1e6
    : suggestBitrate(width, height, fps, draft.videoCodec, draft.quality, hdr);
  const estBytes = audioOnly ? seconds * 48000 * 4 : (seconds * (videoBitrate + draft.audioKbps * 1000)) / 8;
  const noVideoEncoder = !audioOnly && support !== null && support.video.length === 0;
  const pixels = width * height;

  const start = async () => {
    const settings: ExportSettings = {
      container: draft.container,
      videoCodec: draft.videoCodec,
      audioCodec: draft.audioCodec,
      width,
      height,
      fpsNum: rate.fpsNum,
      fpsDen: rate.fpsDen,
      videoBitrate,
      audioBitrate: draft.audioKbps * 1000,
      range: draft.range === 'inout' && range ? range : null,
      includeVideo: !audioOnly,
      includeAudio: true,
      dynamicRange: hdr ? draft.dynamicRange : 'sdr',
      keyFrameInterval: 2,
      hardwareAcceleration: draft.hardware,
    };
    const ext = draft.container;
    const name = `${s.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Untitled'}.${ext}`;

    // Prefer streaming straight to disk: no size limit and no second copy held in memory.
    let writable: FileSystemWritableFileStream | undefined;
    const picker = (
      window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }
    ).showSaveFilePicker;
    if (picker && estBytes > 64 * 1024 * 1024) {
      try {
        const handle = await picker({
          suggestedName: name,
          types: [
            {
              description: CONTAINER_LABELS[draft.container],
              accept: {
                [audioOnly
                  ? 'audio/wav'
                  : `video/${ext === 'mov' ? 'quicktime' : ext === 'mkv' ? 'x-matroska' : ext}`]: [`.${ext}`],
              },
            },
          ],
        });
        writable = await handle.createWritable();
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
      }
    }

    session.player?.pause();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setPhase({
      kind: 'running',
      progress: { phase: 'preparing', frame: 0, totalFrames: 1, speed: 0, etaSeconds: 0, elapsedSeconds: 0 },
    });
    try {
      const resolver = session.exportResolver();
      const result = await exportProject(session.store.get(), resolver, settings, {
        writable,
        signal: ctrl.signal,
        onProgress: (progress) => setPhase({ kind: 'running', progress }),
      });
      if (result.blob) downloadBlob(result.blob, name);
      console.info('[export] finished', {
        frames: result.frames,
        seconds: result.seconds,
        ...result.timings,
      });
      setPhase({
        kind: 'done',
        blob: result.blob,
        name,
        seconds: result.seconds,
        bytes: result.blob?.size ?? null,
      });
    } catch (err) {
      if (err instanceof ExportCancelled) setPhase({ kind: 'idle' });
      else {
        console.error(err);
        setPhase({ kind: 'error', message: err instanceof Error ? err.message : 'Export failed' });
      }
    } finally {
      abort.current = null;
    }
  };

  const close = () => {
    abort.current?.abort();
    onClose();
  };

  const heights = useMemo(() => {
    const base = s.width >= s.height ? [480, 720, 1080, 1440, 2160, 4320] : [854, 1280, 1920, 2560, 3840];
    const list = Array.from(new Set([s.height, ...base])).sort((a, b) => a - b);
    return list.map((h) => ({
      value: h,
      label: `${even((h * s.width) / s.height)} × ${even(h)}${h === s.height ? ' — project' : ''}`,
    }));
  }, [s.width, s.height]);

  if (phase.kind === 'running') {
    const p = phase.progress;
    const pct = p.totalFrames ? Math.min(100, (p.frame / p.totalFrames) * 100) : 0;
    return (
      <Dialog
        solid
        title="Exporting…"
        onClose={() => {}}
        icon={<span className="spinner" />}
        footer={<Button onClick={() => abort.current?.abort()}>Cancel export</Button>}
      >
        <div className="exp__run">
          <div className="exp__pct mono">{pct.toFixed(0)}%</div>
          <div className="progress exp__bar">
            <i style={{ width: `${pct}%` }} />
          </div>
          <dl className="kv">
            <dt>Stage</dt>
            <dd>
              {p.phase === 'preparing'
                ? 'Preparing'
                : p.phase === 'finalizing'
                  ? 'Writing file'
                  : audioOnly
                    ? 'Mixing audio'
                    : 'Rendering'}
            </dd>
            {!audioOnly && (
              <>
                <dt>Frame</dt>
                <dd>
                  {p.frame.toLocaleString()} / {p.totalFrames.toLocaleString()}
                </dd>
                <dt>Speed</dt>
                <dd>
                  {p.speed.toFixed(1)} fps
                  {fps > 0 && p.speed > 0 ? ` · ${(p.speed / fps).toFixed(2)}× real time` : ''}
                </dd>
                <dt>Remaining</dt>
                <dd>{p.speed > 0 ? formatClock(p.etaSeconds) : '—'}</dd>
              </>
            )}
            <dt>Elapsed</dt>
            <dd>{formatClock(p.elapsedSeconds)}</dd>
          </dl>
          <p className="form__hint">
            Rendering happens on this machine, frame by frame, at full quality. Keep this tab visible —
            browsers slow down background tabs.
          </p>
        </div>
      </Dialog>
    );
  }

  if (phase.kind === 'done') {
    return (
      <Dialog
        title="Export complete"
        onClose={close}
        icon={<CircleCheck size={18} style={{ color: 'var(--accent)' }} />}
        footer={
          <>
            {phase.blob && (
              <Button icon={<Download />} onClick={() => downloadBlob(phase.blob!, phase.name)}>
                Download again
              </Button>
            )}
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </>
        }
      >
        <div className="exp__done">
          <Film />
          <div>
            <b>{phase.name}</b>
            <span>
              {phase.bytes !== null ? `${formatBytes(phase.bytes)} · ` : 'Saved to the location you chose · '}
              rendered in {formatClock(phase.seconds, true)}
            </span>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Export"
      wide
      onClose={close}
      footer={
        <>
          <span className="exp__est mono">
            {formatClock(seconds, true)} · ≈ {formatBytes(estBytes)}
          </span>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Download />}
            disabled={end === 0 || noVideoEncoder || support === null}
            onClick={() => void start()}
          >
            Export
          </Button>
        </>
      }
    >
      <div className="exp">
        <div className="exp__presets">
          {PRESETS.filter((p) => p.id !== 'hdr' || hdrProject).map((p) => (
            <button
              key={p.id}
              className="exp__preset"
              aria-pressed={preset === p.id}
              onClick={() => {
                setPreset(p.id);
                update({
                  customMbps: null,
                  dynamicRange: hdrProject ? draft.dynamicRange : 'sdr',
                  ...p.apply(draft, s),
                });
              }}
            >
              <b>{p.label}</b>
              <span>{p.hint}</span>
            </button>
          ))}
        </div>

        {phase.kind === 'error' && (
          <div className="callout callout--warn">
            <TriangleAlert />
            <div>
              <b>Export failed.</b> {phase.message}
            </div>
          </div>
        )}
        {end === 0 && (
          <div className="callout callout--warn">
            <TriangleAlert />
            <div>The timeline is empty — add a clip before exporting.</div>
          </div>
        )}

        <div className="exp__cols">
          <div className="form">
            <div className="color__group">Video</div>
            <Row label="Format">
              <Select<ExportContainer>
                value={draft.container}
                options={(Object.keys(CONTAINER_LABELS) as ExportContainer[]).map((c) => ({
                  value: c,
                  label: CONTAINER_LABELS[c],
                }))}
                onChange={(container) => {
                  setPreset('');
                  update({ container });
                }}
              />
            </Row>
            {!audioOnly && (
              <>
                <Row label="Codec">
                  {support === null ? (
                    <span className="hstack muted" style={{ fontSize: 12 }}>
                      <span className="spinner" /> Checking encoders
                    </span>
                  ) : support.video.length ? (
                    <Select<VideoCodec>
                      value={draft.videoCodec}
                      options={support.video.map((c) => ({ value: c, label: VIDEO_CODEC_LABELS[c] ?? c }))}
                      onChange={(videoCodec) => {
                        setPreset('');
                        update({ videoCodec });
                      }}
                    />
                  ) : (
                    <span style={{ color: 'var(--red)', fontSize: 12 }}>
                      No encoder available for this format{hdr ? ' in 10-bit' : ''}
                    </span>
                  )}
                </Row>
                <Row label="Resolution">
                  <Select
                    value={draft.height}
                    options={heights}
                    onChange={(h) => {
                      setPreset('');
                      update({ height: h });
                    }}
                  />
                </Row>
                <Row label="Frame rate">
                  <Select
                    value={draft.fps}
                    options={[
                      { value: 'project', label: `${describeFps(s)} fps — project` },
                      ...FRAME_RATE_PRESETS.map((f) => ({ value: f.label, label: `${f.label} fps` })),
                    ]}
                    onChange={(v) => {
                      setPreset('');
                      update({ fps: v });
                    }}
                  />
                </Row>
                <Row label="Quality">
                  <Segmented<Quality>
                    block
                    value={draft.quality}
                    options={[
                      { value: 'low', label: 'Low' },
                      { value: 'medium', label: 'Medium' },
                      { value: 'high', label: 'High' },
                      { value: 'max', label: 'Max' },
                    ]}
                    onChange={(quality) => update({ quality, customMbps: null })}
                  />
                </Row>
                <Row label="Bitrate">
                  <NumberField
                    value={videoBitrate / 1e6}
                    onChange={(v) => update({ customMbps: Math.max(0.2, Math.round(v * 10) / 10) })}
                    min={0.2}
                    max={400}
                    step={0.1}
                    precision={1}
                    suffix="Mbps"
                  />
                  {draft.customMbps !== null && (
                    <Button size="sm" variant="ghost" onClick={() => update({ customMbps: null })}>
                      Auto
                    </Button>
                  )}
                </Row>
                {hdrProject && (
                  <Row label="Dynamic range">
                    <Select<ExportDynamicRange>
                      value={draft.dynamicRange}
                      options={[
                        { value: 'pq', label: 'HDR10 — Rec.2100 PQ, 10-bit' },
                        { value: 'hlg', label: 'HLG — Rec.2100, 10-bit' },
                        { value: 'sdr', label: 'SDR — tone-mapped Rec.709' },
                      ]}
                      onChange={(dynamicRange) => update({ dynamicRange })}
                    />
                  </Row>
                )}
              </>
            )}
          </div>
          <div className="form">
            <div className="color__group">Audio</div>
            {audioOnly ? (
              <Row label="Codec">
                <span className="insp__read">PCM 16-bit, {s.sampleRate / 1000} kHz stereo</span>
              </Row>
            ) : (
              <>
                <Row label="Codec">
                  <Select<AudioCodec>
                    value={draft.audioCodec}
                    options={(support?.audio ?? [draft.audioCodec]).map((c) => ({
                      value: c,
                      label: AUDIO_CODEC_LABELS[c] ?? c,
                    }))}
                    onChange={(audioCodec) => update({ audioCodec })}
                  />
                </Row>
                <Row label="Bitrate">
                  <Select
                    value={draft.audioKbps}
                    options={[96, 128, 192, 256, 320].map((k) => ({ value: k, label: `${k} kbps` }))}
                    onChange={(audioKbps) => update({ audioKbps })}
                  />
                </Row>
              </>
            )}
            <div className="color__group" style={{ marginTop: 10 }}>
              Range
            </div>
            <Row label="Export">
              <Segmented
                block
                value={draft.range}
                options={[
                  { value: 'all', label: 'Entire timeline' },
                  { value: 'inout', label: 'In – Out' },
                ]}
                onChange={(r) => update({ range: r === 'inout' && !range ? 'all' : r })}
              />
            </Row>
            {!range && (
              <p className="form__hint" style={{ margin: 0 }}>
                Press I and O on the timeline to mark a range.
              </p>
            )}
            {!audioOnly && (
              <>
                <div className="color__group" style={{ marginTop: 10 }}>
                  Encoder
                </div>
                <Row label="Acceleration">
                  <Select
                    value={draft.hardware}
                    options={[
                      { value: 'no-preference', label: 'Automatic' },
                      { value: 'prefer-hardware', label: 'Prefer GPU encoder' },
                      { value: 'prefer-software', label: 'Prefer software encoder' },
                    ]}
                    onChange={(hardware) => update({ hardware })}
                  />
                </Row>
              </>
            )}
          </div>
        </div>

        <div className="callout">
          <Info />
          <div>
            {audioOnly
              ? 'Exports the full audio mix as an uncompressed WAV file.'
              : `${width}×${height} at ${describeFps(rate)} fps${hdr ? ', 10-bit HDR' : ''}. Your browser encodes the file locally — nothing is uploaded. Available codecs depend on the browser and GPU.`}
            {pixels > 8294400 &&
              !audioOnly &&
              ' Above 4K some hardware encoders refuse; if export fails, try AV1 / VP9 or the software encoder.'}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
