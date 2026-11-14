import { CloudOff, Copy, History, Link2, RotateCcw, ShieldCheck, UploadCloud, UserRound } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { canEdit, initials, ProjectStore, USER_COLORS, type Role, type VersionInfo } from '@tandem/core';
import { navigate } from '../../App';
import { api } from '../../session/api';
import { usePeers, useSession, useSessionMeta } from '../../session/hooks';
import { deleteLocalProject } from '../../session/projects';
import { confirm } from '../../ui/confirm';
import { Button, Dialog, Segmented, TextField, toast } from '../../ui/core';
import { focusables, handFocus } from '../../ui/layers';
import './collab.css';

const ROLE_COPY: Record<Exclude<Role, 'owner'>, { label: string; text: string }> = {
  editor: { label: 'Can edit', text: 'Full access to the timeline, media and settings.' },
  commenter: {
    label: 'Can comment',
    text: 'Can watch, scrub and leave time-coded comments. Cannot change the edit.',
  },
  viewer: { label: 'Can view', text: 'Read-only. Sees edits live, cannot change or comment.' },
};

/** What a person may do here, in the words the invitation used. */
const roleLabel = (role: Role): string => (role === 'owner' ? 'Owner' : ROLE_COPY[role].label);

/** When a version was saved: the day, and the time to the minute. */
const savedAt = (time: number): string =>
  new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function ShareDialog({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const meta = useSessionMeta();
  const peers = usePeers();
  const [role, setRole] = useState<Exclude<Role, 'owner'>>('editor');
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canInvite = meta.role === 'owner' || meta.role === 'editor';
  // A link the browser would not copy is left selected in its field, with the keyboard on it, so
  // that the usual keys copy it from there. The refusals are counted because every press takes the
  // keyboard off the field, and the server answers two presses in one second with the same link.
  const [refusals, setRefusals] = useState(0);
  const linkRow = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const field = refusals ? linkRow.current?.querySelector('input') : null;
    field?.focus();
    field?.select();
  }, [refusals]);

  const copy = async () => {
    setBusy(true);
    try {
      const url = await session.inviteLink(role);
      setLink(url);
      // A page has a clipboard only over HTTPS or on localhost, and may be refused it even there.
      const copied =
        (await navigator.clipboard?.writeText(url).then(
          () => true,
          () => false,
        )) ?? false;
      setRefusals(copied ? 0 : (n) => n + 1);
      if (copied) toast(`${ROLE_COPY[role].label} link copied`, 'success');
      else
        toast('This page cannot reach the clipboard. The link is selected: copy it from its field.', 'info');
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

  const retry = async (pressed: HTMLElement) => {
    // Accepted, the link's two buttons give way to what a shared project is shared with: the
    // keyboard goes on from the first control of that.
    const content = pressed.closest<HTMLElement>('.dialog__body');
    handFocus(pressed, () => content && focusables(content)[0]);
    setBusy(true);
    const answer = await session.retryLink();
    setBusy(false);
    if (answer === 'accepted') toast('The server accepted the link: this project is shared again', 'success');
    else if (answer === 'refused') toast('The server still does not accept the link.', 'error');
    else toast('The collaboration server cannot be reached right now.', 'error');
  };

  const forget = async () => {
    const sure = await confirm({
      title: 'Forget the link to the shared project?',
      message:
        'This copy stays on this device as a project of its own. ' +
        (meta.refusedLink === 'owner'
          ? 'The link is the owner link of the shared project, and no other can be made: without it nobody is its owner any more.'
          : 'To join the shared project again you will need a new link from someone in it.'),
      confirmLabel: 'Forget link',
      danger: true,
    });
    if (sure) session.forgetLink();
  };

  let body: React.ReactNode;
  if (!meta.shared && meta.refusedLink) {
    body = (
      <div className="share__state">
        <CloudOff />
        <b>The server did not accept this project’s link</b>
        <p>
          Your copy stays on this device and does not sync. The link is kept, because a server can be wrong
          for a while: after a restart, or when it has moved.{' '}
          {canEdit(meta.refusedLink)
            ? 'If it is accepted now, this copy joins the shared project again, with the changes made here since.'
            : 'If it is accepted now, the shared project takes the place of this copy: changes made here since are not kept.'}
        </p>
        <div className="hstack">
          <Button
            variant="primary"
            size="lg"
            icon={<RotateCcw />}
            busy={busy}
            onClick={(e) => void retry(e.currentTarget)}
          >
            {busy ? 'Asking the server…' : 'Try again'}
          </Button>
          <Button variant="ghost" size="lg" disabled={busy} onClick={() => void forget()}>
            Forget the link
          </Button>
        </div>
      </div>
    );
  } else if (!meta.online && !meta.shared) {
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
        <Button variant="primary" size="lg" icon={<UploadCloud />} busy={busy} onClick={() => void publish()}>
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
              ariaLabel="People with the link"
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
            <div className="hstack" ref={linkRow}>
              <TextField
                value={link ?? ''}
                onChange={() => {}}
                readOnly
                placeholder="Create a link to invite people"
                prefix={<Link2 size={13} />}
                style={{ flex: 1, height: 28 }}
                ariaLabel="Share link"
              />
              <Button variant="primary" icon={<Copy />} busy={busy} onClick={() => void copy()}>
                {link && !refusals ? 'Copy again' : 'Copy link'}
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
          <div className="share__heading">In this project now</div>
          <div className="people">
            <div className="person">
              <span className="avatar avatar--sm" style={{ background: meta.user.color }}>
                {initials(meta.user.name)}
              </span>
              <span>{meta.user.name} (you)</span>
              <span className="badge">{roleLabel(meta.role)}</span>
            </div>
            {peers.map((p) => (
              <div key={p.clientId} className="person">
                <span className="avatar avatar--sm" style={{ background: p.user.color }}>
                  {initials(p.user.name)}
                </span>
                <span>{p.user.name}</span>
                <span className="badge">{roleLabel(p.role)}</span>
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
  // One thing at a time: a version is being saved, or the one with this id is being restored.
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const token = session.token;

  const load = () => {
    if (!token || !meta.shared) return;
    api.versions(session.id, token).then(setVersions, () => setVersions([]));
  };
  useEffect(load, [token, meta.shared, session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    // Enter in the name field asks as the button does, and has no button to be refused by.
    if (!token || saving || restoring !== null) return;
    setSaving(true);
    try {
      await api.saveVersion(
        session.id,
        token,
        name.trim() || `Version ${savedAt(Date.now())}`,
        meta.user.name,
      );
      setName('');
      load();
      toast('Version saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save version', 'error');
    } finally {
      setSaving(false);
    }
  };

  const restore = async (v: VersionInfo) => {
    if (!token) return;
    const go = await confirm({
      title: `Restore “${v.name}”?`,
      message: 'The current state of the project is replaced for everyone in it. You can undo it.',
      confirmLabel: 'Restore version',
    });
    if (!go) return;
    setRestoring(v.id);
    try {
      const data = await api.versionData(session.id, token, v.id);
      const doc = new Y.Doc();
      Y.applyUpdate(doc, data);
      const snapshot = new ProjectStore(doc).get();
      session.replaceProject(snapshot);
      toast(`Restored “${v.name}”`, 'success');
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not restore version', 'error');
    } finally {
      setRestoring(null);
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
                style={{ flex: 1, height: 28 }}
                ariaLabel="Version name"
                onEnter={() => void save()}
              />
              <Button
                variant="primary"
                busy={saving}
                disabled={restoring !== null}
                onClick={() => void save()}
              >
                Save version
              </Button>
            </div>
          )}
          <div className="versions">
            {versions === null ? (
              <div className="versions__note">
                <span className="spinner" /> Loading
              </div>
            ) : versions.length === 0 ? (
              <div className="versions__note">
                No versions yet. Snapshots are also taken automatically while people are editing.
              </div>
            ) : (
              versions.map((v) => (
                <div key={v.id} className="version">
                  <div className="grow">
                    <b>{v.name}</b>
                    <span>
                      {savedAt(v.createdAt)} {v.author && `· ${v.author}`}
                    </span>
                  </div>
                  {v.auto && <span className="badge">Auto</span>}
                  {session.canEdit && (
                    <Button
                      size="sm"
                      icon={<RotateCcw />}
                      busy={restoring === v.id}
                      disabled={saving || (restoring !== null && restoring !== v.id)}
                      onClick={() => void restore(v)}
                    >
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
        <div className="swatches">
          {USER_COLORS.map((c) => (
            <button
              key={c}
              aria-label={`Colour ${c}`}
              aria-pressed={c === color}
              onClick={() => setColor(c)}
              className="swatch-btn"
              style={{ background: c }}
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
