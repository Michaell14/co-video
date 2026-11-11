import { CloudOff, Copy, History, Link2, RotateCcw, ShieldCheck, UploadCloud, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { initials, ProjectStore, USER_COLORS, type Role, type VersionInfo } from '@tandem/core';
import { navigate } from '../../App';
import { api } from '../../session/api';
import { usePeers, useSession, useSessionMeta } from '../../session/hooks';
import { deleteLocalProject } from '../../session/projects';
import { Button, Dialog, Segmented, TextField, toast } from '../../ui/core';
import './collab.css';

const ROLE_COPY: Record<Exclude<Role, 'owner'>, { label: string; text: string }> = {
  editor: { label: 'Can edit', text: 'Full access to the timeline, media and settings.' },
  commenter: {
    label: 'Can comment',
    text: 'Can watch, scrub and leave time-coded comments. Cannot change the edit.',
  },
  viewer: { label: 'Can view', text: 'Read-only. Sees edits live, cannot change or comment.' },
};

export function ShareDialog({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const meta = useSessionMeta();
  const peers = usePeers();
  const [role, setRole] = useState<Exclude<Role, 'owner'>>('editor');
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canInvite = meta.role === 'owner' || meta.role === 'editor';

  const copy = async () => {
    setBusy(true);
    try {
      const url = await session.inviteLink(role);
      setLink(url);
      await navigator.clipboard?.writeText(url).catch(() => {});
      toast(`${ROLE_COPY[role].label} link copied`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create a link', 'error');
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    setBusy(true);
    try {
      const old = session.id;
      const id = await session.publish();
      toast('Project published — you can now invite people', 'success');
      onClose();
      navigate(id);
      // The local-only copy has been moved; forget its old identity.
      setTimeout(() => void deleteLocalProject(old), 1500);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not publish', 'error');
      setBusy(false);
    }
  };

  let body: React.ReactNode;
  if (!meta.online && !meta.shared) {
    body = (
      <div className="share__state">
        <CloudOff />
        <b>No collaboration server found</b>
        <p>
          Tandem is running in local mode: this project lives in your browser only. To edit with other people,
          run the bundled server (<code>pnpm start</code>) or host it somewhere everyone can reach, then
          reload.
        </p>
      </div>
    );
  } else if (!meta.shared) {
    body = (
      <div className="share__state">
        <UploadCloud />
        <b>This project is only on this device</b>
        <p>
          Publishing uploads the project and its media to your collaboration server so others can join. You
          stay the owner.
        </p>
        <Button
          variant="primary"
          size="lg"
          icon={<UploadCloud />}
          disabled={busy}
          onClick={() => void publish()}
        >
          {busy ? 'Publishing…' : 'Publish and share'}
        </Button>
      </div>
    );
  } else {
    body = (
      <div className="vstack" style={{ gap: 14 }}>
        {canInvite ? (
          <>
            <Segmented
              block
              value={role}
              options={(Object.keys(ROLE_COPY) as Exclude<Role, 'owner'>[]).map((r) => ({
                value: r,
                label: ROLE_COPY[r].label,
              }))}
              onChange={(r) => {
                setRole(r);
                setLink(null);
              }}
            />
            <p className="form__hint" style={{ margin: 0 }}>
              {ROLE_COPY[role].text}
            </p>
            <div className="hstack">
              <TextField
                value={link ?? ''}
                onChange={() => {}}
                readOnly
                placeholder="Create a link to invite people"
                prefix={<Link2 size={13} />}
                style={{ flex: 1 }}
                ariaLabel="Share link"
              />
              <Button variant="primary" icon={<Copy />} disabled={busy} onClick={() => void copy()}>
                {link ? 'Copy again' : 'Copy link'}
              </Button>
            </div>
          </>
        ) : (
          <div className="callout">
            <ShieldCheck />
            <div>
              You have {meta.role === 'commenter' ? 'comment-only' : 'view-only'} access. Ask an editor for an
              invite link if you need to share this project.
            </div>
          </div>
        )}
        <div>
          <div className="color__group" style={{ marginBottom: 8 }}>
            In this project now
          </div>
          <div className="people">
            <div className="person">
              <span className="avatar avatar--sm" style={{ background: meta.user.color }}>
                {initials(meta.user.name)}
              </span>
              <span>{meta.user.name} (you)</span>
              <span className="badge">{meta.role}</span>
            </div>
            {peers.map((p) => (
              <div key={p.clientId} className="person">
                <span className="avatar avatar--sm" style={{ background: p.user.color }}>
                  {initials(p.user.name)}
                </span>
                <span>{p.user.name}</span>
                <span className="badge">{p.role}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="callout">
          <ShieldCheck />
          <div>
            Links are keys: anyone holding one gets that access level, with no account needed. Share them the
            way you would share a password.
          </div>
        </div>
      </div>
    );
  }

  return (
    <Dialog title="Share project" onClose={onClose}>
      {body}
    </Dialog>
  );
}

export function VersionsDialog({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const meta = useSessionMeta();
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const token = session.token;

  const load = () => {
    if (!token || !meta.shared) return;
    api.versions(session.id, token).then(setVersions, () => setVersions([]));
  };
  useEffect(load, [token, meta.shared, session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!token) return;
    setBusy(true);
    try {
      await api.saveVersion(
        session.id,
        token,
        name.trim() || `Version ${new Date().toLocaleString()}`,
        meta.user.name,
      );
      setName('');
      load();
      toast('Version saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save version', 'error');
    } finally {
      setBusy(false);
    }
  };

  const restore = async (v: VersionInfo) => {
    if (!token) return;
    if (!confirm(`Restore “${v.name}”? The current state is replaced for everyone — you can undo it.`))
      return;
    setBusy(true);
    try {
      const data = await api.versionData(session.id, token, v.id);
      const doc = new Y.Doc();
      Y.applyUpdate(doc, data);
      const snapshot = new ProjectStore(doc).get();
      session.store.replaceAll(snapshot);
      toast(`Restored “${v.name}”`, 'success');
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not restore version', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Version history" onClose={onClose} icon={<History size={16} />}>
      {!meta.shared ? (
        <div className="share__state">
          <History />
          <b>Versions live on the collaboration server</b>
          <p>
            Publish this project to get named versions and automatic snapshots. Meanwhile, “Save project file”
            in the menu makes a portable backup.
          </p>
        </div>
      ) : (
        <div className="vstack" style={{ gap: 12 }}>
          {session.canEdit && (
            <div className="hstack">
              <TextField
                value={name}
                onChange={setName}
                placeholder="Name this version (e.g. Rough cut v2)"
                style={{ flex: 1 }}
                onEnter={() => void save()}
              />
              <Button variant="primary" disabled={busy} onClick={() => void save()}>
                Save version
              </Button>
            </div>
          )}
          <div className="versions">
            {versions === null ? (
              <div className="hstack muted" style={{ padding: 16 }}>
                <span className="spinner" /> Loading
              </div>
            ) : versions.length === 0 ? (
              <div className="muted" style={{ padding: 16, fontSize: 12 }}>
                No versions yet. Snapshots are also taken automatically while people are editing.
              </div>
            ) : (
              versions.map((v) => (
                <div key={v.id} className="version">
                  <div className="grow">
                    <b>{v.name}</b>
                    <span>
                      {new Date(v.createdAt).toLocaleString()} {v.author && `· ${v.author}`}
                    </span>
                  </div>
                  {v.auto && <span className="badge">Auto</span>}
                  {session.canEdit && (
                    <Button size="sm" icon={<RotateCcw />} disabled={busy} onClick={() => void restore(v)}>
                      Restore
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function ProfileDialog({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const meta = useSessionMeta();
  const [name, setName] = useState(meta.user.name);
  const [color, setColor] = useState(meta.user.color);
  return (
    <Dialog
      title="Your profile"
      onClose={onClose}
      icon={<UserRound size={16} />}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              session.renameUser(name, color);
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="vstack" style={{ gap: 14 }}>
        <div className="hstack" style={{ gap: 12 }}>
          <span className="avatar avatar--lg" style={{ background: color }}>
            {initials(name || '?')}
          </span>
          <TextField
            value={name}
            onChange={setName}
            autoFocus
            ariaLabel="Display name"
            style={{ flex: 1, height: 32 }}
          />
        </div>
        <div className="hstack" style={{ flexWrap: 'wrap' }}>
          {USER_COLORS.map((c) => (
            <button
              key={c}
              aria-label={`Colour ${c}`}
              onClick={() => setColor(c)}
              className="swatch-btn"
              style={{
                background: c,
                boxShadow: c === color ? '0 0 0 2px var(--bg-3), 0 0 0 4px #fff' : 'none',
              }}
            />
          ))}
        </div>
        <p className="form__hint" style={{ margin: 0 }}>
          This is how collaborators see your cursor, playhead and comments. It is stored in this browser only
          — there are no accounts.
        </p>
      </div>
    </Dialog>
  );
}
