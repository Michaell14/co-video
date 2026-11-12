import { CircleAlert, CircleCheck, Download, Film, Info, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  describeFps,
  formatBytes,
  formatClock,
  formatTimecode,
  framesToSeconds,
  FRAME_RATE_PRESETS,
  sequenceEnd,
  type Fps,
  type Project,
} from '@tandem/core';
import {
  AUDIO_CODEC_LABELS,
  checkExportMedia,
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
  type ExportWarning,
} from '@tandem/engine';
import { usePlayerState, useProject, useSession } from '../../session/hooks';
import { cmd, downloadBlob } from '../../state/commands';
import { useUI } from '../../state/ui';
import { Button, Dialog, NumberField, Segmented, Select, tip } from '../../ui/core';
import { Row } from '../inspector/controls';
import { groupProblems, hasUnseen, usableCodec, type ProblemPlace } from './plan';
import './export.css';

type Quality = 'low' | 'medium' | 'high' | 'max';
type VideoCodec = ExportSettings['videoCodec'];
type AudioCodec = ExportSettings['audioCodec'];

interface Preset {
  id: string;
  label: string;
  hint: string;
  /**
   * `native` is the dynamic range of the project itself. Every preset with a picture names its
   * dynamic range, so that it gives the same export whichever preset was chosen before it.
   */
  apply: (project: { width: number; height: number }, native: ExportDynamicRange) => Partial<Draft>;
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
    apply: (p, native) => ({
      container: 'mp4',
      videoCodec: 'avc',
      height: p.height,
      fps: 'project',
      quality: 'high',
      dynamicRange: native,
    }),
  },
  {
    id: 'web',
    label: 'Web 1080p',
    hint: 'H.264 MP4, plays everywhere',
    // What plays everywhere is 8-bit SDR, so an HDR timeline is tone-mapped for this one.
    apply: (p) => ({
      container: 'mp4',
      videoCodec: 'avc',
      height: Math.min(p.height, p.width >= p.height ? 1080 : 1920),
      fps: 'project',
      quality: 'high',
      dynamicRange: 'sdr',
    }),
  },
  {
    id: '4k',
    label: '4K master',
    hint: 'High bitrate for archive / upload',
    apply: (p, native) => ({
      container: 'mp4',
      videoCodec: 'avc',
      height: p.width >= p.height ? 2160 : 3840,
      fps: 'project',
      quality: 'max',
      dynamicRange: native,
    }),
  },
  {
    id: 'small',
    label: 'Small file',
    hint: 'AV1 / VP9 for sharing',
    apply: (p, native) => ({
      container: 'webm',
      videoCodec: 'av1',
      height: Math.min(p.height, 1080),
      fps: 'project',
      quality: 'medium',
      dynamicRange: native,
    }),
  },
  {
    id: 'hdr',
    label: 'HDR10',
    hint: '10-bit Rec.2100 PQ',
    apply: (p) => ({
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
  | { kind: 'running'; progress: ExportProgress; warnings: ExportWarning[] }
  | {
      kind: 'done';
      blob: Blob | null;
      name: string;
      seconds: number;
      bytes: number | null;
      warnings: ExportWarning[];
    }
  | { kind: 'error'; message: string };

/** How many timecodes one problem lists before the rest are only counted. */
const MAX_PLACES = 8;

/** Export problems, one sentence per file, each with the places on the timeline it affects. */
function ProblemList({
  warnings,
  fps,
  onShow,
}: {
  warnings: ExportWarning[];
  fps: Fps;
  /** Go to a clip. Left out while an export is running, when leaving would throw it away. */
  onShow?: (place: ProblemPlace) => void;
}) {
  return (
    <ul className="exp__problems">
      {groupProblems(warnings).map((g) => (
        <li key={g.key}>
          <span>{g.message}</span>
          <span className="exp__places mono">
            {g.places.slice(0, MAX_PLACES).map((place) =>
              onShow ? (
                <button
                  key={place.clipId}
                  type="button"
                  className="exp__place"
                  onClick={() => onShow(place)}
                  {...tip('Go to this clip')}
                >
                  {formatTimecode(place.frame, fps)}
                </button>
              ) : (
                <span key={place.clipId} className="exp__place">
                  {formatTimecode(place.frame, fps)}
                </span>
              ),
            )}
            {g.places.length > MAX_PLACES && <span>and {g.places.length - MAX_PLACES} more</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const project = useProject((p) => p);
  const range = usePlayerState().range;
  const s = project.settings;
  const hdrProject = s.colorMode !== 'sdr';
  const native: ExportDynamicRange = hdrProject ? (s.colorMode === 'hdr-hlg' ? 'hlg' : 'pq') : 'sdr';
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
    dynamicRange: native,
    hardware: 'no-preference',
  });
  const [probed, setProbed] = useState<{ key: string; support: CodecSupport } | null>(null);
  /** Media problems found before exporting; null until the first look has finished. */
  const [problems, setProblems] = useState<ExportWarning[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const abort = useRef<AbortController | null>(null);
  const closed = useRef(false);
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

  // Ask the browser which encoders it really has for this format, size and bit depth. The answer
  // is kept with the question it belongs to, so a stale one is never taken for the current choice.
  const probeKey = `${draft.container}|${width}x${height}|${hdr}`;
  useEffect(() => {
    let cancelled = false;
    void probeEncoders(draft.container, width, height, hdr).then((sup) => {
      if (!cancelled) setProbed({ key: probeKey, support: sup });
    });
    return () => {
      cancelled = true;
    };
  }, [probeKey, draft.container, width, height, hdr]);
  const support = probed?.key === probeKey ? probed.support : null;
  // A preset or an earlier choice can name a codec this browser cannot encode here (H.264 for a
  // 10-bit HDR export, for one). What is shown, sized and exported is the codec that will be used.
  const videoCodec = usableCodec(draft.videoCodec, support?.video ?? null);
  const audioCodec = usableCodec(draft.audioCodec, support?.audio ?? null) ?? draft.audioCodec;

  const end = sequenceEnd(project);
  const span =
    draft.range === 'inout' && range ? { in: range.in, out: Math.min(range.out, end) } : { in: 0, out: end };
  const seconds = framesToSeconds(Math.max(0, span.out - span.in), s);
  const videoBitrate = draft.customMbps
    ? draft.customMbps * 1e6
    : suggestBitrate(width, height, fps, videoCodec ?? draft.videoCodec, draft.quality, hdr);
  const estBytes = audioOnly ? seconds * 48000 * 4 : (seconds * (videoBitrate + draft.audioKbps * 1000)) / 8;
  const noVideoEncoder = !audioOnly && support !== null && videoCodec === null;
  const pixels = width * height;

  const settings: ExportSettings = {
    container: draft.container,
    videoCodec: videoCodec ?? draft.videoCodec,
    audioCodec,
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
  const latest = useRef(settings);
  latest.current = settings;

  // Look for media the export cannot get at while the settings are still on screen, so the gaps
  // are known before a long render and not after it. Only the range and whether there is a
  // picture decide which clips count.
  const choosing = phase.kind === 'idle' || phase.kind === 'error';
  const scope = `${audioOnly}|${span.in}|${span.out}`;
  /** What the list in `problems` was made for. */
  const checked = useRef<{ project: Project; scope: string } | null>(null);
  useEffect(() => {
    if (!choosing) return;
    let cancelled = false;
    // Edits by collaborators arrive in bursts; one look after they settle is enough.
    const timer = setTimeout(() => {
      void checkExportMedia(project, session.exportResolver(), latest.current)
        .catch(() => [])
        .then((found) => {
          if (cancelled) return;
          checked.current = { project, scope };
          setProblems(found);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [session, project, choosing, scope]);
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
    };
  }, []);

  const start = async () => {
    const resolver = session.exportResolver();
    const now = session.store.get();
    // The list on screen stands for what is being exported unless the project or the range has
    // changed under it, or it has not arrived yet. Then the look is taken now, and whatever the
    // person has not been shown is shown first: going ahead takes a second, informed press.
    // (When the list is current nothing is awaited here, so the browser still counts the save
    // prompt below as part of the press.)
    if (checked.current?.project !== now || checked.current.scope !== scope) {
      setChecking(true);
      const found = await checkExportMedia(now, resolver, settings).catch(() => []);
      if (closed.current) return;
      setChecking(false);
      checked.current = { project: now, scope };
      const unseen = hasUnseen(found, problems ?? []);
      setProblems(found);
      if (unseen) return;
    }
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
      warnings: [],
    });
    try {
      const result = await exportProject(session.store.get(), resolver, settings, {
        writable,
        signal: ctrl.signal,
        onProgress: (progress) =>
          setPhase((prev) => (prev.kind === 'running' ? { ...prev, progress } : prev)),
        onWarning: (w) =>
          setPhase((prev) => (prev.kind === 'running' ? { ...prev, warnings: [...prev.warnings, w] } : prev)),
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
        warnings: result.warnings,
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
    closed.current = true;
    abort.current?.abort();
    onClose();
  };
  const show = (place: ProblemPlace) => {
    close();
    useUI.getState().select([place.clipId]);
    cmd.seek(place.frame);
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
        footer={
          <Button
            variant={phase.warnings.length ? 'danger' : 'default'}
            onClick={() => abort.current?.abort()}
          >
            Cancel export
          </Button>
        }
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
          {phase.warnings.length > 0 && (
            <div className="callout callout--warn" role="status">
              <TriangleAlert />
              <div>
                <b>This export will have gaps.</b>
                <ProblemList warnings={phase.warnings} fps={s} />
                {phase.warnings.some((w) => w.reason === 'timeout')
                  ? 'A file that keeps the export waiting can cost up to eight seconds on every frame of its clip. Cancel to sort the media out first, or let the export run on.'
                  : 'Cancel to sort the media out first, or let the export run on.'}
              </div>
            </div>
          )}
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
        title={phase.warnings.length ? 'Exported with gaps' : 'Export complete'}
        onClose={close}
        icon={
          phase.warnings.length ? (
            <TriangleAlert size={18} style={{ color: 'var(--amber)' }} />
          ) : (
            <CircleCheck size={18} style={{ color: 'var(--accent)' }} />
          )
        }
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
        <div className="exp">
          <div className="exp__done">
            <Film />
            <div>
              <b>{phase.name}</b>
              <span>
                {phase.bytes !== null
                  ? `${formatBytes(phase.bytes)} · `
                  : 'Saved to the location you chose · '}
                rendered in {formatClock(phase.seconds, true)}
              </span>
            </div>
          </div>
          {phase.warnings.length > 0 && (
            <div className="callout callout--warn">
              <TriangleAlert />
              <div>
                <b>The file was written, but not everything is in it.</b>
                <ProblemList warnings={phase.warnings} fps={s} onShow={show} />
                Pick a timecode to go to that clip.
              </div>
            </div>
          )}
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
            disabled={end === 0 || noVideoEncoder || support === null || checking}
            onClick={() => void start()}
          >
            {checking ? 'Checking media…' : problems?.length ? 'Export anyway' : 'Export'}
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
                  ...p.apply(s, native),
                });
              }}
            >
              <b>{p.label}</b>
              <span>{p.hint}</span>
            </button>
          ))}
        </div>

        {phase.kind === 'error' && (
          <div className="callout exp__failed" role="alert">
            <CircleAlert />
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
        {!!problems?.length && (
          <div className="callout callout--warn" role="alert">
            <TriangleAlert />
            <div>
              <b>Not everything can be exported.</b>
              <ProblemList warnings={problems} fps={s} onShow={show} />
              Pick a timecode to go to that clip, or export anyway.
            </div>
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
                  ) : videoCodec ? (
                    <Select<VideoCodec>
                      value={videoCodec}
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
                      onChange={(dynamicRange) => {
                        setPreset('');
                        update({ dynamicRange });
                      }}
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
                    value={audioCodec}
                    options={(support?.audio.length ? support.audio : [audioCodec]).map((c) => ({
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
