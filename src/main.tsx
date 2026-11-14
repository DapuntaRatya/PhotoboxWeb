import { useEffect, useRef, useState, type FormEvent, type PointerEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowDownToLine, ArrowLeft, ArrowRight, Camera, CameraOff, Check, ChevronRight, Clock3, Eye, FlipHorizontal2, Focus, Heart,
  Image as ImageIcon, Images, Link2, LockKeyhole, LogOut, Mic, MicOff, Scan, SlidersHorizontal,
  Sparkles, Trash2, UserRound, Users, Volume2, X } from 'lucide-react';
import '@fontsource-variable/dm-sans';
import './style.css';
import { Studio } from './studio';
import { StripEditor, type StripDraft } from './strip-editor';
import { TemplatePicker } from './template-picker';
import formats from './photo-formats.json';
import { albumLink, api, canTakePhoto, filterNames, fullFrame, inviteLink, mirrorKey, neutral, sessionKey,
  type AlbumFile, type FilterKey, type Person, type RoomState, type Seat, type Session, type Version } from './types';

const errorText = (error: unknown) => error instanceof Error ? error.message : 'Terjadi kesalahan. Coba lagi.';
const isId = (id: string) => /^[a-f0-9]{32}$/.test(id);
const isToken = (token: string) => /^[A-Za-z0-9_-]{43}$/.test(token);

function Brand() {
  return <a href="/" className="brand" aria-label="PhotoboxWeb, halaman awal"><span className="brand-mark"><Camera size={19} strokeWidth={2.1} /></span>
    <span>photobox<span className="brand-accent">web</span><span className="brand-period">.</span></span></a>;
}

function Header({ children }: { children?: ReactNode }) {
  return <header className="topbar"><div className="topbar-inner"><Brand />{children}</div></header>;
}

function Footer() {
  return <footer className="footer"><p>Made with <Heart size={13} fill="currentColor" role="img" aria-label="love" /> by Dapunta &amp; Sol 6.1</p></footer>;
}

function CopyButton({ text, children }: { text: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  return <><button className="button secondary small" onClick={async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setManual(true);
    }
  }}>{copied ? <Check size={16} /> : <Link2 size={16} />}{copied ? 'Tersalin' : children}</button>
    {manual && <dialog open className="copy-dialog"><label>Salin tautan<input value={text} readOnly autoFocus onFocus={(event) => event.target.select()} /></label>
      <button className="button secondary small" onClick={() => setManual(false)}>Tutup</button></dialog>}</>;
}

function Home() {
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function create() {
    setBusy(true);
    setMessage('');
    try {
      const session = await api<Session>('/rooms', undefined, { method: 'POST' });
      sessionStorage.setItem(sessionKey(session.roomId), JSON.stringify(session));
      location.assign(`/room/${session.roomId}`);
    } catch (error) {
      setMessage(errorText(error));
      setBusy(false);
    }
  }
  function join(event: FormEvent) {
    event.preventDefault();
    try {
      const url = new URL(invite.trim(), location.origin);
      const id = url.pathname.split('/')[2] ?? '';
      if (url.origin !== location.origin || url.pathname !== `/room/${id}` || !isId(id) || !isToken(url.hash.slice(1))) throw Error();
      location.assign(url);
    } catch {
      setMessage('Masukkan tautan undangan PhotoboxWeb yang lengkap.');
    }
  }
  return <><Header><span className="header-note"><LockKeyhole size={14} /> Tanpa akun</span></Header>
    <main className="home wrap">
      <section className="hero">
        <div className="hero-content">
          <h1>Jauh di sana,<br /><em>dekat di frame.</em></h1>
          <p>Pilih latar, atur pose, dan buat photostrip sendiri atau bersama hingga 10 peserta.</p>
          <button className="button primary hero-button" onClick={create} disabled={busy}><Camera size={19} />{busy ? 'Membuat room…' : 'Buat room baru'}<ArrowRight size={18} /></button>
          <form className="join-form" onSubmit={join}>
            <label htmlFor="invite">Sudah punya undangan?</label>
            <div className="join-input"><Link2 size={17} /><input id="invite" placeholder="Tempel tautan undangan" value={invite} onChange={(event) => setInvite(event.target.value)} required />
              <button className="button secondary small" type="submit">Gabung <ChevronRight size={16} /></button></div>
          </form>
          {message && <p role="alert" className="error">{message}</p>}
        </div>
        <div className="hero-visual" aria-label="Contoh photostrip dua orang">
          <div className="visual-grid" />
          <Sparkles className="art-sparkle one" strokeWidth={1.25} size={60} />
          <Sparkles className="art-sparkle two" strokeWidth={1.4} size={35} />
          <div className="strip-shadow" />
          <div className="hero-print">
            <div className="print-photo" /><div className="print-photo second" /><div className="print-photo third" /><div className="print-photo fourth" />
            <Heart className="print-heart" size={22} strokeWidth={1.5} />
          </div>
        </div>
      </section>
      <section className="home-features" aria-label="Cara menggunakan PhotoboxWeb">
        <div><span className="feature-icon"><Users size={21} /></span><span><strong>Undang teman</strong><small>Satu tautan untuk masuk room yang sama.</small></span></div>
        <div><span className="feature-icon"><Sparkles size={21} /></span><span><strong>Foto bareng</strong><small>Atur latar, bingkai, dan pose bersama.</small></span></div>
        <div><span className="feature-icon"><Images size={21} /></span><span><strong>Simpan photostrip</strong><small>Unduh hasil dari album privat.</small></span></div>
      </section>
    </main><Footer /></>;
}

function Gate({ roomId, invite }: { roomId: string; invite: string }) {
  const [session, setSession] = useState<Session | null>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(sessionKey(roomId)) ?? 'null');
      return value?.roomId === roomId && isToken(value.credential) ? value : null;
    } catch { return null; }
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  if (session) return <Room session={session} />;
  async function join() {
    setBusy(true);
    setMessage('');
    try {
      const session = await api<Session>(`/rooms/${roomId}/join`, undefined, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite }),
      });
      sessionStorage.setItem(sessionKey(roomId), JSON.stringify(session));
      history.replaceState(null, '', location.pathname);
      setSession(session);
    } catch (error) {
      setMessage(errorText(error));
      setBusy(false);
    }
  }
  return <><Header /><main className="wrap center-page">
    <section className="gate-card"><span className="feature-icon"><Users size={26} /></span>
      <h1>Undangan photobox</h1><p>{isToken(invite) ? 'Masuk ke room untuk mulai foto bersama.' : 'Buka tautan undangan lengkap untuk bergabung.'}</p>
      {isToken(invite) && <button className="button primary" onClick={join} disabled={busy}>{busy ? 'Bergabung…' : 'Gabung room'}<ArrowRight size={17} /></button>}
      {message && <p role="alert" className="error">{message}</p>}
      <a className="text-link" href="/"><ArrowLeft size={15} /> Halaman awal</a>
    </section></main><Footer /></>;
}

function Range({ label, value, min, max, step = 1, onChange, display }: {
  label: string; value: number; min: number; max: number; step?: number;
  onChange: (value: number) => void; display?: string | number;
}) {
  return <label className="range"><span>{label}<output aria-hidden="true">{display ?? value}</output></span>
    <input type="range" aria-label={label} value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function Thumbnail({ blob, slot }: { blob?: Blob; slot: number }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!blob) { setUrl(''); return; }
    const url = URL.createObjectURL(blob);
    setUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return url ? <img src={url} alt={`Foto ${slot}`} /> : <ImageIcon size={21} strokeWidth={1.5} />;
}

const layerLabel = (seat: Seat, local: Seat) => seat === local ? 'Kamu' : `Peserta ${seat.charCodeAt(0) - 96}`;
const clampPosition = (value: number) => Math.max(-1, Math.min(2, value));

function Room({ session }: { session: Session }) {
  const [state, setState] = useState<RoomState>();
  const [status, setStatus] = useState('Membuka room…');
  const [online, setOnline] = useState(false);
  const [notice, setNotice] = useState('');
  const [activity, setActivity] = useState('');
  const [countdown, setCountdown] = useState<number>();
  const [camera, setCamera] = useState(false);
  const [mic, setMic] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [mediaBusy, setMediaBusy] = useState('');
  const [photos, setPhotos] = useState<(Blob | undefined)[]>([]);
  const [templatesReady, setTemplatesReady] = useState(false);
  const [selected, select] = useState(0);
  const [photoToPreview, setPhotoToPreview] = useState<{ slot: number; blob: Blob }>();
  const [photoToClear, setPhotoToClear] = useState<{ slot: number; id: string; blob?: Blob }>();
  const [stripDraft, setStripDraft] = useState<StripDraft>();
  const [tab, setTab] = useState('layout');
  const [person, setPerson] = useState(session.seat);
  const [dragged, setDragged] = useState<Person>();
  const [filters, setFilters] = useState({ ...neutral });
  const [mirror, setMirror] = useState(() => sessionStorage.getItem(mirrorKey(session.roomId)) === '1');
  const [leaving, setLeaving] = useState(false);
  const [closed, setClosed] = useState(false);
  const studio = useRef<Studio>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const photoDialog = useRef<HTMLDialogElement>(null);
  const clearDialog = useRef<HTMLDialogElement>(null);
  const drag = useRef<{ seat: Seat; id: number; start: Person; current: Person; x: number; y: number; resize: boolean; corner: string }>(null);
  const backgroundInput = useRef<HTMLInputElement>(null);
  const autoSelect = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!preview.current) return;
    studio.current = new Studio(session, preview.current, {
      state: (next) => {
        setState(next);
        const completed = autoSelect.current;
        if (completed !== undefined) {
          autoSelect.current = undefined;
          const available = next.slots.findIndex((slot, index) => index > completed && !slot);
          const first = next.slots.indexOf(null);
          if (available >= 0 || first >= 0) select(available >= 0 ? available : first);
        }
        select((index) => Math.min(index, next.slots.length - 1));
      },
      status: setStatus, notice: setNotice, media: (video, audio, blocked) => { setCamera(video); setMic(audio); setAudioBlocked(blocked); },
      activity: (message, count) => { setActivity(message); setCountdown(count); }, photos: setPhotos,
      captured: (slot) => { autoSelect.current = slot; }, connection: setOnline, templates: setTemplatesReady,
      closed: () => {
        sessionStorage.removeItem(sessionKey(session.roomId));
        sessionStorage.removeItem(mirrorKey(session.roomId));
        setClosed(true);
        studio.current?.close();
      },
    });
    return () => studio.current?.close();
  }, [session]);

  async function media(kind: 'video' | 'audio' | 'both') {
    setMediaBusy(kind);
    if (kind === 'both') await Promise.all([studio.current?.toggleMedia('video'), studio.current?.toggleMedia('audio')]);
    else await studio.current?.toggleMedia(kind);
    setMediaBusy('');
  }
  async function leave() {
    if (!window.confirm('Keluar dari room? Hasil yang sudah diekspor tetap tersedia di album sampai kedaluwarsa.')) return;
    setLeaving(true);
    try {
      await studio.current?.leave();
      sessionStorage.removeItem(sessionKey(session.roomId));
      sessionStorage.removeItem(mirrorKey(session.roomId));
      studio.current?.close();
      location.assign(albumLink(session));
    } catch (error) {
      setLeaving(false);
      setNotice(errorText(error));
    }
  }
  const layout = state?.layout;
  const strip = formats.strips[layout?.strip ?? '4x1'];
  const [ratioWidth, ratioHeight] = formats.ratios[layout?.ratio ?? '4:3'];
  const selectedPhoto = state?.slots[selected];
  const canClearPhoto = photoToClear && state?.slots[photoToClear.slot]?.id === photoToClear.id;
  const filled = state?.slots.filter(Boolean).length ?? 0;
  const presence = state?.presence ?? {};
  const active = Object.values(presence).filter((peer) => peer.online).length;
  const hasCamera = Object.values(presence).some((peer) => peer.camera);
  const busy = !online || !!state?.busy;
  const canCapture = !busy && templatesReady && state && canTakePhoto(state, session.seat);
  const canExport = !busy && filled === layout?.count && photos.length === layout.count && photos.every(Boolean);
  const editorStale = Boolean(stripDraft && (state?.layout.strip !== stripDraft.layout.strip ||
    state.layout.ratio !== stripDraft.layout.ratio || state.layout.frame !== stripDraft.layout.frame ||
    state.slots.length !== stripDraft.slots.length ||
    state.slots.some((slot, index) => slot?.id !== stripDraft.slots[index])));
  const adjust = (key: string, value: unknown, options?: object) => studio.current?.change(key, value, options);
  const selectedSeat = layout?.people[person] ? person : session.seat;
  const selectedLayer = dragged ?? layout?.people[selectedSeat];
  const selectedIndex = layout?.order.indexOf(selectedSeat) ?? -1;
  useEffect(() => {
    if (!drag.current) return;
    studio.current?.previewLayer(drag.current.seat);
    drag.current = null;
    setDragged(undefined);
  }, [busy, layout?.ratio, selectedSeat, tab]);

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (busy || !selectedLayer || event.button !== 0 || drag.current) return;
    const corner = (event.target as HTMLElement).dataset.corner ?? '';
    drag.current = { seat: selectedSeat, id: event.pointerId, start: selectedLayer, current: selectedLayer,
      x: event.clientX, y: event.clientY, resize: Boolean(corner), corner };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const gesture = drag.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    const { width, height } = event.currentTarget.getBoundingClientRect();
    const dx = (event.clientX - gesture.x) / width, dy = (event.clientY - gesture.y) / height;
    const { start, corner } = gesture;
    const sx = corner.includes('e') ? 1 : -1, sy = corner.includes('s') ? 1 : -1;
    const delta = 2 * (dx * sx * width ** 2 + dy * sy * height ** 2) / (width ** 2 + height ** 2);
    gesture.current = gesture.resize ? { ...start, scale: Math.min(3, Math.max(0.1, start.scale + delta)) }
      : { ...start, x: clampPosition(start.x + dx), y: clampPosition(start.y + dy) };
    studio.current?.previewLayer(gesture.seat, gesture.current);
    setDragged(gesture.current);
  }

  function finishDrag(event: PointerEvent<HTMLDivElement>, commit: boolean) {
    const gesture = drag.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    drag.current = null;
    studio.current?.previewLayer(gesture.seat);
    setDragged(undefined);
    if (commit && !busy && gesture.current !== gesture.start) adjust('transform', gesture.current, { person: gesture.seat });
  }
  return <><Header>
    <div className="header-actions"><CopyButton text={inviteLink(session)}>Undangan</CopyButton>
      <a className="button secondary small" href={albumLink(session)} target="_blank" rel="noreferrer"><Images size={16} /> Album</a>
      {!closed && <button className="button ghost small leave" onClick={leave} disabled={leaving}><LogOut size={16} /> Keluar</button>}</div>
  </Header>
    {closed ? <main className="wrap center-page"><section className="gate-card"><h1>Room ditutup</h1>
      <a className="button primary" href={albumLink(session)}><Images size={17} /> Buka album</a><a className="text-link" href="/"><ArrowLeft size={15} /> Halaman awal</a>
    </section></main> : <main className="wrap room">
      <div className="room-heading"><div><h1>Photo Studio</h1><p>Abadikan momen, semua kontrol ada di tanganmu.</p></div>
        <div className="connection"><span className={online ? 'live-dot ready' : 'live-dot'} />{status} · {active}/10 peserta</div>
      </div>
      {notice && <div className="notice" role="status">{notice}<button className="icon-button" aria-label="Tutup pemberitahuan" onClick={() => setNotice('')}><X size={17} /></button></div>}
      <div className="studio-grid">
        <div className="studio-left">
          <section className="panel preview-panel">
            <div className="panel-title"><h2><Focus size={19} /> Preview bersama</h2><span>{layout?.ratio ?? '4:3'}</span></div>
            <div className="preview-stage" style={{ '--ratio': (layout?.ratio ?? '4:3').replace(':', '/') } as React.CSSProperties}>
              <div className="preview-frame">
                <canvas ref={preview} aria-label="Komposisi kamera peserta" />
                {tab === 'layout' && selectedLayer && hasCamera && !busy && <div className="layer-editor" aria-label={`Geser atau ubah skala layer ${layerLabel(selectedSeat, session.seat)}`}
                  onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={(event) => finishDrag(event, true)}
                  onPointerCancel={(event) => finishDrag(event, false)} onLostPointerCapture={(event) => finishDrag(event, false)}>
                  <div className="layer-outline" style={{
                    left: `${(selectedLayer.x - selectedLayer.scale / 2) * 100}%`, top: `${(selectedLayer.y - selectedLayer.scale / 2) * 100}%`,
                    width: `${selectedLayer.scale * 100}%`, height: `${selectedLayer.scale * 100}%`,
                  }}>
                    {['nw', 'ne', 'sw', 'se'].map((corner) => <span key={corner} className="layer-handle" data-corner={corner} aria-hidden="true" />)}
                  </div>
                </div>}
              </div>
              {!camera && !hasCamera && <div className="preview-empty"><span><CameraOff size={27} strokeWidth={1.4} /></span>
                <strong>Kamera belum aktif</strong>
                <button className="button light small" onClick={() => media('both')} disabled={!!mediaBusy || !online}>{mediaBusy ? 'Meminta izin…' : 'Aktifkan kamera dan mikrofon'}</button></div>}
              {!templatesReady && <div className="stage-badge" role="status">Memuat latar dan bingkai…</div>}
              {countdown && <div className="countdown" role="status" aria-label={`Hitung mundur ${countdown}`}>{countdown}</div>}
            </div>
            <div className="preview-capture">
              <button className="button primary" disabled={!canCapture} onClick={() => studio.current?.capture(selected)}><Camera size={18} />
                {selectedPhoto ? `Retake slot ${selected + 1}` : `Ambil foto ${selected + 1}`}</button>
            </div>
            <div className="media-bar">
              <div className="participants">{Object.entries(presence).filter(([, peer]) => peer.online).map(([seat, peer]) =>
                <span key={seat}><i className={peer.camera ? 'live-dot ready' : 'live-dot'} />{layerLabel(seat, session.seat)}</span>)}</div>
              <div className="media-actions">
                {status === 'Koneksi video gagal' && <button className="button secondary small" onClick={() => studio.current?.reconnect()}>Sambung ulang</button>}
                {audioBlocked && <button className="icon-button" aria-label="Putar audio peserta" onClick={() => studio.current?.playAudio()}><Volume2 size={19} /></button>}
                <button className={`icon-button media-toggle ${camera ? 'on' : ''}`} aria-label={camera ? 'Matikan kamera' : 'Nyalakan kamera'} aria-pressed={camera} disabled={!!mediaBusy} onClick={() => media('video')}>{camera ? <Camera size={19} /> : <CameraOff size={19} />}</button>
                <button className={`icon-button media-toggle ${mic ? 'on' : ''}`} aria-label={mic ? 'Matikan mikrofon' : 'Nyalakan mikrofon'} aria-pressed={mic} disabled={!!mediaBusy} onClick={() => media('audio')}>{mic ? <Mic size={19} /> : <MicOff size={19} />}</button>
              </div>
            </div>
          </section>
          <section className="panel slots-panel">
            <div className="panel-title"><h2><Images size={19} /> Photostrip</h2><span>{filled}/{layout?.count ?? 4} foto</span></div>
            <div className="slots" style={{ '--thumbnail-columns': strip.count === 2 ? 2 : 4 } as React.CSSProperties}>
              {(state?.slots ?? Array(4).fill(null)).map((slot, index) => {
                const number = index + 1;
                const blob = slot ? photos[index] : undefined;
                const previewLabel = `Pratinjau foto ${number}`;
                return <div className="slot-card" key={index}>
                  <button className={`slot ${index === selected ? 'selected' : ''}`}
                    aria-label={`Slot ${number}${slot ? ', terisi' : ', kosong'}`} aria-pressed={index === selected} onClick={() => select(index)}>
                    <span className="slot-thumb"><Thumbnail key={slot?.id ?? 'empty'} blob={blob} slot={number} /></span><span>{String(number).padStart(2, '0')}</span>
                  </button>
                  {slot && <button type="button" className="icon-button slot-preview" aria-label={previewLabel} title={previewLabel}
                    aria-haspopup="dialog" disabled={!blob} onClick={() => {
                      if (!blob) return;
                      setPhotoToPreview({ slot: number, blob });
                      photoDialog.current?.showModal();
                    }}><Eye size={16} /></button>}
                </div>;
              })}
            </div>
            <div className="slot-footer"><div className="slot-actions">
              {selectedPhoto && <button className="button secondary" disabled={busy} onClick={() => {
                setPhotoToClear({ slot: selected, id: selectedPhoto.id, blob: photos[selected] });
                clearDialog.current?.showModal();
              }}><Trash2 size={18} /> Hapus foto {selected + 1}</button>}
              <button className="button secondary" disabled={!canExport} onClick={async () => {
                if (!canExport || !state || !studio.current) return;
                const slots = state.slots.flatMap((slot) => slot ? [slot.id] : []);
                try {
                  const readyPhotos = await studio.current.getStripPhotos(slots);
                  setStripDraft({ photos: readyPhotos, slots, layout: state.layout });
                } catch (error) { setNotice(errorText(error)); }
              }}><Images size={18} /> Pratinjau &amp; edit</button>
            </div>
              {activity ? <p role="status">{activity}</p> : filled !== layout?.count ? <p>{state?.slots.filter((slot) => !slot).length ?? 4} slot kosong sebelum ekspor.</p> : null}
            </div>
          </section>
        </div>
        <aside className="panel controls">
          <div className="panel-title"><h2><SlidersHorizontal size={18} /> Pengaturan</h2></div>
          <div className="tabs" aria-label="Pengaturan studio">
            <button className={tab === 'layout' ? 'active' : ''} aria-pressed={tab === 'layout'} onClick={() => setTab('layout')}><Scan size={16} /> Komposisi</button>
            <button className={tab === 'camera' ? 'active' : ''} aria-pressed={tab === 'camera'} onClick={() => setTab('camera')}><SlidersHorizontal size={16} /> Kamera</button>
          </div>
          {tab === 'layout' && layout && <fieldset disabled={busy}>
            <TemplatePicker background={layout.background} frame={layout.frame} choose={adjust} upload={() => backgroundInput.current?.click()} />
            <input ref={backgroundInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(event) => {
              const file = event.target.files?.[0]; if (file) void studio.current?.uploadBackground(file); event.target.value = '';
            }} />
            <div className="control-group"><h3 id="ratio-label">Rasio foto</h3><div className="format-options ratio-options" role="group" aria-labelledby="ratio-label">
              {Object.entries(formats.ratios).map(([ratio, [width, height]]) => {
                const scale = 30 / Math.max(width, height);
                return <button key={ratio} className="format-option" aria-pressed={layout.ratio === ratio} onClick={() => adjust('ratio', ratio)}>
                  <span className="format-figure" aria-hidden="true"><span className="ratio-outline" style={{ width: width * scale, height: height * scale }} /></span>
                  <span>{ratio}</span>
                </button>;
              })}
            </div></div>
            <div className="control-group"><h3 id="strip-label">Template photostrip</h3><div className="format-options strip-options" role="group" aria-labelledby="strip-label">
              {Object.entries(formats.strips).map(([id, { rows, columns, count }]) => <button key={id} className="format-option" aria-pressed={layout.strip === id} onClick={() => {
                const drop = state.slots.slice(count).some(Boolean);
                if (!drop || window.confirm(`Template ${count} foto akan membuang isi slot di atas ${count} dari draft.`)) adjust('strip', id, { confirm: drop });
              }}>
                <span className="format-figure" aria-hidden="true"><span className="strip-diagram" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
                  {Array.from({ length: count }, (_, index) => <i key={index} style={{
                    width: ratioWidth * 7 / Math.max(ratioWidth, ratioHeight), height: ratioHeight * 7 / Math.max(ratioWidth, ratioHeight),
                  }} />)}
                </span></span>
                <span>{count} foto <small>{rows}×{columns}</small></span>
              </button>)}
            </div></div>
            <div className="control-group positions"><h3>Layer kamera</h3>
              <div className="layer-list">{[...layout.order].reverse().map((seat) => <button key={seat} className={seat === selectedSeat ? 'active' : ''}
                aria-pressed={seat === selectedSeat} onClick={() => setPerson(seat)}>
                <UserRound size={15} />{layerLabel(seat, session.seat)}<small>{presence[seat]?.camera ? 'Kamera aktif' : presence[seat]?.online ? 'Kamera mati' : 'Offline'}</small>
              </button>)}</div>
              {selectedLayer && <><div className="choices layer-actions">
                <button disabled={selectedIndex <= 0} onClick={() => adjust('order', -1, { person: selectedSeat })}>Ke belakang</button>
                <button disabled={selectedIndex >= layout.order.length - 1} onClick={() => adjust('order', 1, { person: selectedSeat })}>Ke depan</button>
                <button onClick={() => adjust('transform', fullFrame, { person: selectedSeat })}>Reset</button>
              </div>
              {(['x', 'y', 'scale'] as const).map((axis) => <Range key={axis} label={axis === 'x' ? 'Horizontal' : axis === 'y' ? 'Vertikal' : 'Skala'}
                value={Math.round(selectedLayer[axis] * 100)} min={axis === 'scale' ? 10 : -100} max={axis === 'scale' ? 300 : 200}
                display={`${Math.round(selectedLayer[axis] * 100)}%`} onChange={(value) => adjust('person', value / 100, { person: selectedSeat, axis })} />)}
              <p className="layer-help">Geser layer di preview. Tarik sudut untuk mengubah skala.</p></>}
            </div>
          </fieldset>}
          {tab === 'camera' && <><div className="control-group mirror-control">
            <label className="mirror-label"><span><FlipHorizontal2 size={17} /> Mirror kamera</span>
              <input type="checkbox" role="switch" checked={mirror} onChange={(event) => {
                setMirror(event.target.checked); studio.current?.setMirror(event.target.checked);
              }} /></label>
            <p>Balik horizontal kamera kamu di preview semua peserta dan foto berikutnya.</p>
          </div><div className="control-group filters"><div className="filter-title"><h3>Camera Enhancement</h3>
            <button className="text-link" onClick={() => {
              setFilters({ ...neutral });
              for (const key of Object.keys(neutral) as FilterKey[]) studio.current?.setFilter(key, 0);
            }}>Reset</button></div>
            {(Object.keys(filterNames) as FilterKey[]).map((key) => <Range key={key} label={filterNames[key]} value={filters[key]} min={-5} max={5}
              display={filters[key] > 0 ? `+${filters[key]}` : filters[key]} onChange={(value) => {
                setFilters((current) => ({ ...current, [key]: value })); studio.current?.setFilter(key, value);
              }} />)}
          </div></>}
        </aside>
      </div>
      <dialog ref={photoDialog} className="album-dialog" aria-labelledby="slot-photo-title" onClose={() => setPhotoToPreview(undefined)}
        onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
        <div className="panel-title"><h2 id="slot-photo-title">Pratinjau foto {photoToPreview?.slot}</h2>
          <button className="icon-button" aria-label="Tutup pratinjau" onClick={() => photoDialog.current?.close()} autoFocus><X size={19} /></button>
        </div>
        {photoToPreview && <Thumbnail blob={photoToPreview.blob} slot={photoToPreview.slot} />}
      </dialog>
      <dialog ref={clearDialog} className="clear-photo-dialog" aria-labelledby="clear-photo-title" aria-describedby="clear-photo-description"
        onClose={() => setPhotoToClear(undefined)} onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}>
        <div className="clear-photo-content">
          <div className="clear-photo-summary">
            {photoToClear && <div className="clear-photo-preview"><Thumbnail blob={photoToClear.blob} slot={photoToClear.slot + 1} /></div>}
            <div>
              <h2 id="clear-photo-title">Hapus foto slot {photoToClear ? photoToClear.slot + 1 : ''}?</h2>
              <p id="clear-photo-description">{canClearPhoto ? 'Slot ini akan dikosongkan untuk semua peserta di room.' : 'Isi slot sudah berubah.'}</p>
            </div>
          </div>
          <div className="clear-photo-actions">
            <button className="button secondary" onClick={() => clearDialog.current?.close()} autoFocus>Batal</button>
            <button className="button primary" disabled={busy || !canClearPhoto} onClick={() => {
              if (!photoToClear || busy || !canClearPhoto) return;
              studio.current?.clearSlot(photoToClear.slot, photoToClear.id);
              clearDialog.current?.close();
            }}><Trash2 size={17} /> Hapus foto</button>
          </div>
        </div>
      </dialog>
      {stripDraft && <StripEditor draft={stripDraft} disabled={busy} stale={editorStale} close={() => setStripDraft(undefined)}
        submit={(blob, slots) => studio.current?.requestExport(blob, slots, stripDraft.layout) ?? Promise.resolve(false)} />}
    </main>}
    <Footer />
  </>;
}

function Album({ id, token }: { id: string; token: string }) {
  const [versions, setVersions] = useState<Version[]>();
  const [message, setMessage] = useState('');
  const [tick, setTick] = useState(Date.now());
  const [selected, setSelected] = useState<{ version: Version; file: AlbumFile }>();
  const [previewUrl, setPreviewUrl] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const offset = useRef(0);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    dialog.current?.showModal();
    void fetch(`/api/albums/${id}/files/${selected.file.id}`, {
      headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw Error(response.status === 410 ? 'Berkas sudah kedaluwarsa.' : 'Foto gagal dimuat.');
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setPreviewUrl(objectUrl);
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setMessage(errorText(error));
      dialog.current?.close();
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, token, selected]);
  useEffect(() => {
    if (!isToken(token)) { setMessage('Buka tautan album privat yang lengkap.'); return; }
    let stopped = false;
    let polling = false;
    async function load() {
      if (polling) return;
      polling = true;
      const began = Date.now();
      try {
        const data = await api<{ versions: Version[]; now: number }>(`/albums/${id}`, token);
        if (stopped) return;
        offset.current = data.now - (began + Date.now()) / 2;
        setVersions(data.versions);
        setMessage('');
      } catch (error) {
        if (!stopped) setMessage(errorText(error));
      } finally {
        polling = false;
      }
    }
    void load();
    const poll = setInterval(load, 12_000);
    const clock = setInterval(() => setTick(Date.now()), 1000);
    return () => { stopped = true; clearInterval(poll); clearInterval(clock); };
  }, [id, token]);
  async function download(version: Version, file: AlbumFile) {
    try {
      const response = await fetch(`/api/albums/${id}/files/${file.id}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      if (!response.ok) throw Error(response.status === 410 ? 'Berkas sudah kedaluwarsa.' : 'Unduhan gagal.');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `photobox-v${version.version}-${file.position ? `foto-${file.position}` : 'photostrip'}.jpg`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 15_000);
    } catch (error) { setMessage(errorText(error)); }
  }
  const visible = versions?.filter((version) => version.expires > tick + offset.current);
  useEffect(() => {
    if (selected && selected.version.expires <= tick + offset.current) dialog.current?.close();
  }, [selected, tick]);
  const fileLabel = (file: AlbumFile) => file.position ? `Foto ${file.position}` : 'Photostrip';
  return <><Header>{isToken(token) && <CopyButton text={location.href}>Tautan album</CopyButton>}</Header>
    <main className="wrap album"><a className="text-link" href="/"><ArrowLeft size={16} /> Halaman awal</a>
      <div className="room-heading"><div><h1>Album privat</h1><p>Foto dan photostrip tersedia selama satu jam sejak disimpan.</p></div><span className="connection"><LockKeyhole size={15} /> Akses via tautan</span></div>
      {message && <p className="notice" role="status">{message}</p>}
      {!versions && !message && <p role="status">Memuat album…</p>}
      {visible?.length === 0 && <div className="panel empty-album"><span className="feature-icon"><Images size={27} /></span><h2>Belum ada hasil yang tersedia</h2><p>Versi ekspor yang masih berlaku akan muncul di sini.</p></div>}
      {visible?.map((version) => {
        const left = Math.max(0, Math.ceil((version.expires - tick - offset.current) / 1000));
        return <section className="panel version" key={version.id}><div className="panel-title"><h2><Images size={20} /> Versi {version.version}</h2>
          <span><Clock3 size={15} /> {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} tersisa</span></div>
          <div className="download-list">{version.files.map((file) => <div className="album-file" key={file.id}>
            <button className="button secondary" aria-label={`Lihat ${fileLabel(file)}`} onClick={() => setSelected({ version, file })}><ImageIcon size={16} /> {fileLabel(file)}</button>
            <button className="icon-button" aria-label={`Unduh ${fileLabel(file)}`} onClick={() => download(version, file)}><ArrowDownToLine size={17} /></button>
          </div>)}</div></section>;
      })}
      <dialog ref={dialog} className="album-dialog" aria-label={selected ? fileLabel(selected.file) : 'Lihat foto'} onClose={() => {
        setSelected(undefined); setPreviewUrl('');
      }}>
        {selected && <><div className="panel-title"><h2>{fileLabel(selected.file)}</h2>
          <button className="icon-button" aria-label="Tutup foto" onClick={() => dialog.current?.close()} autoFocus><X size={19} /></button></div>
          {previewUrl ? <img src={previewUrl} alt={fileLabel(selected.file)} /> : <p role="status">Memuat foto…</p>}</>}
      </dialog>
    </main><Footer /></>;
}

const [, page, id] = location.pathname.split('/');
const token = location.hash.slice(1);
const screen = page === 'room' && isId(id) ? <Gate roomId={id} invite={token} /> : page === 'album' && isId(id) ? <Album id={id} token={token} /> : <Home />;
createRoot(document.getElementById('root')!).render(screen);
