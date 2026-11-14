import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { ArrowDownToLine, Eye, Plus, Trash2, Type, X } from 'lucide-react';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import { canvas, composeStrip, context, encode } from './graphics';
import { framePreset } from './templates';
import type { Layout } from './types';

const fonts = ['Instrument Serif', 'DM Sans Variable', 'Georgia', 'Verdana', 'Trebuchet MS', 'Courier New', 'Impact'] as const;
type TextLayer = {
  id: number; text: string; font: typeof fonts[number]; size: number; color: string; bold: boolean; italic: boolean;
  align: 'left' | 'center' | 'right'; x: number; y: number; rotation: number;
};
export type StripDraft = { photos: Blob[]; slots: string[]; layout: Layout };
const message = (error: unknown) => error instanceof Error ? error.message : 'Photostrip gagal disiapkan.';
const fontSpec = (layer: TextLayer) => `${layer.italic ? 'italic ' : ''}${layer.bold ? '700' : '400'} ${layer.size}px "${layer.font}"`;
const bounded = (value: number) => Math.max(0, Math.min(1, value));
const loadFonts = (layers: TextLayer[]) => Promise.all(layers.map((layer) => document.fonts.load(fontSpec(layer), layer.text)));

function paint(output: HTMLCanvasElement, strip: HTMLCanvasElement, layers: TextLayer[]) {
  output.width = strip.width;
  output.height = strip.height;
  const ctx = context(output);
  ctx.drawImage(strip, 0, 0);
  for (const layer of layers) {
    ctx.save();
    ctx.translate(layer.x * strip.width, layer.y * strip.height);
    ctx.rotate(layer.rotation * Math.PI / 180);
    ctx.font = fontSpec(layer);
    ctx.fillStyle = layer.color;
    ctx.textBaseline = 'middle';
    ctx.textAlign = layer.align;
    const lines = layer.text.split('\n');
    lines.forEach((line, index) => ctx.fillText(line, 0, (index - (lines.length - 1) / 2) * layer.size * 1.16));
    ctx.restore();
  }
}

export function StripEditor({ draft, disabled, stale, close, submit }: {
  draft: StripDraft; disabled: boolean; stale: boolean; close: () => void; submit: (strip: Blob, slots: string[]) => Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const nextId = useRef(1);
  const drag = useRef<{ id: number; pointer: number; dx: number; dy: number }>(null);
  const [base, setBase] = useState<HTMLCanvasElement>();
  const [layers, setLayers] = useState<TextLayer[]>([]);
  const [selected, select] = useState<number>();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [cleanPreview, setCleanPreview] = useState(false);
  const active = layers.find((layer) => layer.id === selected);

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let live = true;
    void composeStrip(draft.photos, draft.layout).then((strip) => {
      if (!live) return;
      setBase(strip);
      setLayers([{ id: 0, text: 'PhotoboxWeb', font: 'Instrument Serif', size: 52, color: framePreset(draft.layout.frame).ink,
        bold: false, italic: true, align: 'center', x: .5, y: 1 - 79 / strip.height, rotation: 0 }]);
      select(0);
    }).catch((cause) => { if (live) setError(message(cause)); });
    return () => { live = false; };
  }, [draft]);

  useEffect(() => {
    const output = preview.current;
    if (!base || !output) return;
    paint(output, base, layers);
    let live = true;
    void loadFonts(layers).then(() => { if (live) paint(output, base, layers); }).catch(() => {});
    return () => { live = false; };
  }, [base, layers]);

  function update(id: number, patch: Partial<TextLayer>) {
    setLayers((current) => current.map((layer) => layer.id === id ? { ...layer, ...patch } : layer));
  }

  function add() {
    const id = nextId.current++;
    setLayers((current) => [...current, { id, text: 'Teks baru', font: 'DM Sans Variable', size: 54, color: framePreset(draft.layout.frame).ink,
      bold: true, italic: false, align: 'center', x: .5, y: .5, rotation: 0 }]);
    select(id);
  }

  function position(event: PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height };
  }

  async function save() {
    if (!base || disabled || stale || saving) return;
    setSaving(true);
    setError('');
    try {
      await loadFonts(layers);
      const output = canvas();
      paint(output, base, layers);
      const blob = await encode(output, 'image/jpeg', 0.94);
      if (await submit(blob, draft.slots)) close();
      else setError('Photostrip gagal disimpan. Periksa koneksi lalu coba lagi.');
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  }

  return <dialog ref={dialog} className="strip-editor" aria-labelledby="strip-editor-title" onClose={close}
    onCancel={(event) => { if (saving) event.preventDefault(); }}>
    <header className="editor-header">
      <div><h2 id="strip-editor-title">Edit photostrip</h2><p>Atur teks pada hasil gabungan sebelum ekspor.</p></div>
      <div className="editor-header-actions">
        <button className="button secondary small" aria-pressed={cleanPreview} onClick={() => setCleanPreview(!cleanPreview)} disabled={!base}>
          <Eye size={16} /> Pratinjau bersih</button>
        <button className="icon-button" aria-label="Tutup editor" onClick={close} disabled={saving}><X size={21} /></button>
      </div>
    </header>
    <div className="editor-body">
      <div className="editor-stage" aria-label="Pratinjau photostrip">
        {base ? <div className="editor-art" style={{ '--strip-ratio': base.width / base.height } as CSSProperties}
          onPointerDown={(event) => {
            if (saving || event.button !== 0 || !(event.target instanceof Element)) return;
            const handle = event.target.closest<HTMLButtonElement>('[data-text-layer]');
            const layer = layers.find((item) => item.id === Number(handle?.dataset.textLayer));
            if (!layer) return;
            const point = position(event);
            select(layer.id);
            drag.current = { id: layer.id, pointer: event.pointerId, dx: layer.x - point.x, dy: layer.y - point.y };
            event.currentTarget.setPointerCapture(event.pointerId);
          }} onPointerMove={(event) => {
            if (drag.current?.pointer !== event.pointerId) return;
            const point = position(event);
            update(drag.current.id, { x: bounded(point.x + drag.current.dx), y: bounded(point.y + drag.current.dy) });
          }} onLostPointerCapture={() => { drag.current = null; }}>
          <canvas ref={preview} role="img" aria-label="Hasil gabungan foto dan teks" />
          {!cleanPreview && layers.map((layer) => <button key={layer.id} className="editor-text-handle" type="button" data-text-layer={layer.id}
            aria-label={`Pilih teks ${layer.text || 'kosong'}`} aria-pressed={selected === layer.id}
            style={{ left: `${layer.x * 100}%`, top: `${layer.y * 100}%` }} onClick={() => select(layer.id)}><Type size={12} /></button>)}
        </div> : <p role="status">{error ? 'Pratinjau tidak tersedia.' : 'Menggabungkan foto…'}</p>}
      </div>
      <fieldset className="editor-controls" disabled={!base || saving}>
        <div className="editor-controls-heading"><h3>Layer teks</h3><button className="button secondary small" onClick={add}><Plus size={17} /> Tambah teks</button></div>
        <div className="editor-layer-list">
          {layers.map((layer) => <button className="button secondary small" key={layer.id} aria-pressed={layer.id === selected}
            onClick={() => select(layer.id)}><Type size={16} /><span>{layer.text.trim() || 'Teks kosong'}</span></button>)}
          {!layers.length && base && <p>Belum ada teks pada photostrip.</p>}
        </div>
        {active && <div className="editor-fields">
          <label>Teks<textarea aria-label="Teks" rows={3} value={active.text} onChange={(event) => update(active.id, { text: event.target.value })} /></label>
          <label>Font<select aria-label="Font" value={active.font} onChange={(event) => update(active.id, { font: event.target.value as TextLayer['font'] })}>
            {fonts.map((font) => <option key={font}>{font}</option>)}
          </select></label>
          <div className="editor-fields-row">
            <label>Ukuran<input type="range" min={12} max={200} value={active.size} onChange={(event) => update(active.id, { size: Number(event.target.value) })} /></label>
            <label>Warna<input type="color" value={active.color} onChange={(event) => update(active.id, { color: event.target.value })} /></label>
          </div>
          <div className="editor-fields-row">
            <button className="button secondary small" aria-pressed={active.bold} onClick={() => update(active.id, { bold: !active.bold })}>Tebal</button>
            <button className="button secondary small" aria-pressed={active.italic} onClick={() => update(active.id, { italic: !active.italic })}>Miring</button>
          </div>
          <label>Perataan<select aria-label="Perataan" value={active.align} onChange={(event) => update(active.id, { align: event.target.value as TextLayer['align'] })}>
            <option value="left">Kiri</option><option value="center">Tengah</option><option value="right">Kanan</option>
          </select></label>
          <div className="editor-fields-row">
            <label>Posisi X<input type="range" min={0} max={100} value={Math.round(active.x * 100)} onChange={(event) => update(active.id, { x: Number(event.target.value) / 100 })} /></label>
            <label>Posisi Y<input type="range" min={0} max={100} value={Math.round(active.y * 100)} onChange={(event) => update(active.id, { y: Number(event.target.value) / 100 })} /></label>
          </div>
          <label>Rotasi<input type="range" min={-180} max={180} value={active.rotation} onChange={(event) => update(active.id, { rotation: Number(event.target.value) })} /></label>
          <button className="button secondary small" onClick={() => {
            setLayers((current) => current.filter((layer) => layer.id !== active.id));
            select(layers.find((layer) => layer.id !== active.id)?.id);
          }}><Trash2 size={16} /> Hapus teks</button>
        </div>}
      </fieldset>
    </div>
    <footer className="editor-footer">
      {(stale || error) && <p role="alert">{stale ? 'Foto atau template berubah. Buka editor lagi untuk memakai pilihan terbaru.' : error}</p>}
      <button className="button secondary" onClick={close} disabled={saving}>Kembali</button>
      <button className="button primary" onClick={() => void save()} disabled={!base || disabled || stale || saving}>
        <ArrowDownToLine size={18} /> {saving ? 'Menyimpan…' : 'Simpan ke album'}</button>
    </footer>
  </dialog>;
}
