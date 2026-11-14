import { useState } from 'react';
import { Ban, Check, Search, Upload } from 'lucide-react';
import { backgrounds, frames, templateThumbnail, type Background } from './templates';
import { appPath } from './paths';

export function TemplatePicker({ background, frame, choose, upload }: {
  background: string; frame: string; choose: (kind: 'background' | 'frame', id: string) => void; upload: () => void;
}) {
  const [kind, setKind] = useState<'background' | 'frame'>('background');
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('Semua');
  const items = kind === 'background' ? backgrounds : frames.filter((frame) => frame.art);
  const active = kind === 'background' ? background : frame;
  const groups = ['Semua', ...new Set(items.map((item) => item.group))];
  const search = query.trim().toLocaleLowerCase('id');
  const matches = items.filter((item) => (group === 'Semua' || item.group === group) &&
    (item.label + ' ' + item.group).toLocaleLowerCase('id').includes(search));
  if (group === 'Semua' && !search) matches.sort((a, b) => Number(Boolean(b.art)) - Number(Boolean(a.art)));

  return <section className="control-group template-picker" aria-label="Koleksi template">
    <div className="template-heading"><h3>Template</h3><span>{items.length} pilihan</span></div>
    <div className="tabs" aria-label="Jenis template">
      <button type="button" className={kind === 'background' ? 'active' : ''} aria-pressed={kind === 'background'}
        onClick={() => { setKind('background'); setGroup('Semua'); setQuery(''); }}>Latar</button>
      <button type="button" className={kind === 'frame' ? 'active' : ''} aria-pressed={kind === 'frame'}
        onClick={() => { setKind('frame'); setGroup('Semua'); setQuery(''); }}>Bingkai</button>
    </div>
    <label className="template-search"><Search size={16} /><input type="search" aria-label="Cari template" value={query}
      placeholder={kind === 'background' ? 'Cari latar' : 'Cari bingkai'} onChange={(event) => setQuery(event.target.value)} /></label>
    <div className="template-filters" aria-label="Kategori template">
      {groups.map((category) => <button key={category} type="button" aria-pressed={group === category} onClick={() => setGroup(category)}>{category}</button>)}
    </div>
    <div className="template-grid">
      {kind === 'frame' && <button type="button" className="template-card" aria-pressed={active === 'none'} onClick={() => choose('frame', 'none')}>
        <span className="template-art frame-card"><Ban size={22} aria-hidden="true" />
          {active === 'none' && <span className="template-check"><Check size={13} /></span>}
        </span>
        <span>None</span>
      </button>}
      {matches.map((item) => {
        const bg = kind === 'background' ? item as Background : undefined;
        return <button key={item.id} type="button" className="template-card" aria-pressed={item.id === active} onClick={() => choose(kind, item.id)}>
          <span className={`template-art ${kind === 'frame' ? 'frame-card' : ''}`} style={{ background: bg ? `linear-gradient(145deg, ${bg.colors.join(', ')})` : undefined }}>
            {item.art && <img src={appPath(templateThumbnail(item.art))} alt="" loading="lazy" decoding="async" />}
            {item.id === active && <span className="template-check"><Check size={13} /></span>}
          </span>
          <span>{item.label}</span>
        </button>;
      })}
    </div>
    {!matches.length && <p className="template-empty">Template tidak ditemukan.</p>}
    {kind === 'background' && <button className="button secondary small template-upload" type="button" onClick={upload}><Upload size={16} /> Unggah latar</button>}
  </section>;
}
