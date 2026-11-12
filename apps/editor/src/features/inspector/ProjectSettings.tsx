import { describeFps, FRAME_RATE_PRESETS, RESOLUTION_PRESETS, type ProjectSettings } from '@tandem/core';
import { useProject, useSession } from '../../session/hooks';
import { beginGesture, commit } from '../../state/props';
import { Button, ColorField, Dialog, NumberField, Select, TextField } from '../../ui/core';
import { Row } from './controls';
import { changeProjectFrameRate } from './frameRate';

/** Sequence settings. Everything here is non-destructive: clips are resolution independent. */
export function ProjectSettingsForm({ full }: { full?: boolean }) {
  const session = useSession();
  const s = useProject((p) => p.settings);
  const set = (patch: Partial<ProjectSettings>, merge = false) => commit([{ op: 'settings', patch }], merge);
  const preset = RESOLUTION_PRESETS.find((r) => r.width === s.width && r.height === s.height);
  const rate = FRAME_RATE_PRESETS.find((f) => f.fpsNum === s.fpsNum && f.fpsDen === s.fpsDen);
  const hdr = s.colorMode !== 'sdr';
  return (
    <div className="form" style={{ gap: 8 }}>
      {full && (
        <Row label="Name">
          <TextField
            value={s.name}
            onChange={(name) => set({ name }, true)}
            onFocus={beginGesture}
            ariaLabel="Project name"
          />
        </Row>
      )}
      <Row label="Resolution">
        <Select
          value={preset ? `${preset.width}x${preset.height}` : 'custom'}
          options={[
            ...RESOLUTION_PRESETS.map((r) => ({
              value: `${r.width}x${r.height}`,
              label: `${r.label} · ${r.width}×${r.height}`,
              group: r.group,
            })),
            { value: 'custom', label: `Custom · ${s.width}×${s.height}`, group: 'Other' },
          ]}
          onChange={(v) => {
            const r = RESOLUTION_PRESETS.find((x) => `${x.width}x${x.height}` === v);
            if (r) set({ width: r.width, height: r.height });
          }}
        />
      </Row>
      <Row label="Size">
        <NumberField
          value={s.width}
          onChange={(v) => set({ width: Math.max(16, Math.round(v / 2) * 2) }, true)}
          onStart={beginGesture}
          min={16}
          max={8192}
          step={2}
          prefix="W"
        />
        <NumberField
          value={s.height}
          onChange={(v) => set({ height: Math.max(16, Math.round(v / 2) * 2) }, true)}
          onStart={beginGesture}
          min={16}
          max={8192}
          step={2}
          prefix="H"
        />
      </Row>
      <Row label="Frame rate">
        <Select
          value={rate?.label ?? 'custom'}
          options={[
            ...FRAME_RATE_PRESETS.map((f) => ({ value: f.label, label: `${describeFps(f)} fps` })),
            ...(rate ? [] : [{ value: 'custom', label: `${describeFps(s)} fps` }]),
          ]}
          onChange={(v) => {
            const f = FRAME_RATE_PRESETS.find((x) => x.label === v);
            // Changing the rate re-times the whole edit so that it keeps its real-world timing.
            if (f) changeProjectFrameRate(session, f.fpsNum, f.fpsDen);
          }}
        />
      </Row>
      <Row label="Background">
        <ColorField
          value={s.background}
          onChange={(background) => set({ background }, true)}
          onStart={beginGesture}
        />
      </Row>
      <Row label="Colour">
        <Select
          value={s.colorMode}
          options={[
            { value: 'sdr', label: 'SDR · Rec.709' },
            { value: 'hdr-pq', label: 'HDR · Rec.2100 PQ' },
            { value: 'hdr-hlg', label: 'HDR · Rec.2100 HLG' },
          ]}
          onChange={(colorMode) =>
            set({
              colorMode,
              toneMap: colorMode === 'sdr' ? 'none' : s.toneMap === 'none' ? 'bt2390' : s.toneMap,
            })
          }
        />
      </Row>
      {(full || hdr) && (
        <Row label="Tone map">
          <Select
            value={s.toneMap}
            options={[
              { value: 'none', label: hdr ? 'Default roll-off' : 'None (clip)' },
              { value: 'bt2390', label: 'Soft knee' },
              { value: 'reinhard', label: 'Reinhard' },
              { value: 'hable', label: 'Hable (filmic)' },
              { value: 'aces', label: 'ACES (fitted)' },
            ]}
            onChange={(toneMap) => set({ toneMap })}
          />
        </Row>
      )}
      {hdr && (
        <>
          <Row label="Peak">
            <NumberField
              value={s.peakNits}
              onChange={(peakNits) => set({ peakNits: Math.round(peakNits) }, true)}
              onStart={beginGesture}
              min={400}
              max={10000}
              step={10}
              suffix="nits"
            />
          </Row>
          <Row label="Diffuse white">
            <NumberField
              value={s.refWhiteNits}
              onChange={(refWhiteNits) => set({ refWhiteNits: Math.round(refWhiteNits) }, true)}
              onStart={beginGesture}
              min={80}
              max={400}
              step={1}
              suffix="nits"
            />
          </Row>
        </>
      )}
    </div>
  );
}

export function ProjectSettingsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title="Project settings"
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <ProjectSettingsForm full />
      <p className="form__hint">
        Projects are resolution independent — switch between 1080p, 4K or vertical at any time. HDR modes use
        a Rec.2020 working space; SDR media is placed at diffuse white and HDR sources keep their highlights.
        On an SDR project the tone map applies to log, linear and HDR sources only: the finished picture is
        not tone-mapped.
      </p>
    </Dialog>
  );
}
