import { useEffect, useRef, useState } from 'react';
import {
  levels,
  videoTypes,
  type BulkVideoUpdate,
  type CatalogValue,
  type DanceLibraryApi,
  type VideoDetails,
  type VideoUpdate,
} from '../shared/api';

export function DetailPanel({
  api,
  ids,
  onClose,
  onSaved,
}: {
  api: DanceLibraryApi;
  ids: string[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const bulk = ids.length > 1;
  const [detail, setDetail] = useState<VideoDetails | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [styles, setStyles] = useState<CatalogValue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    Promise.all([api.getVideoDetails(ids[0]!), api.searchCatalogValues('style', '')])
      .then(([d, s]) => {
        setDetail(d);
        setStyles(s);
        setValues(fromDetail(d));
        queueMicrotask(() => first.current?.focus());
      })
      .catch((e) => setError(String(e)));
  }, [api, ids]);
  function set(key: string, value: unknown) {
    setValues((v) => ({ ...v, [key]: value }));
    setDirty((d) => new Set(d).add(key));
  }
  async function idsFor(kind: 'instructor' | 'tag', names: string): Promise<string[]> {
    const result = [];
    for (const raw of names.split(',')) {
      const name = raw.trim();
      if (name) result.push((await api.createCatalogValue(kind, name)).id);
    }
    return result;
  }
  async function save() {
    try {
      setError(null);
      const styleName = String(values.styleName ?? '').trim();
      if (styleName && !styles.some((s) => s.id === values.styleId))
        values.styleId = (await api.createCatalogValue('style', styleName)).id;
      if (bulk) {
        const patch: BulkVideoUpdate = {};
        for (const key of dirty)
          if (key !== 'instructors' && key !== 'tags')
            (patch as unknown as Record<string, unknown>)[key] = values[key];
        if (dirty.has('instructors'))
          patch.addInstructorIds = await idsFor('instructor', String(values.instructors ?? ''));
        if (dirty.has('tags')) patch.addTagIds = await idsFor('tag', String(values.tags ?? ''));
        await api.bulkUpdateVideos(ids, patch);
      } else {
        const patch: VideoUpdate = {};
        for (const key of [
          'title',
          'videoType',
          'styleId',
          'level',
          'eventName',
          'eventDate',
          'rating',
          'favorite',
          'notes',
        ])
          (patch as unknown as Record<string, unknown>)[key] =
            values[key] || (key === 'favorite' ? false : null);
        patch.instructorIds = await idsFor('instructor', String(values.instructors ?? ''));
        patch.tagIds = await idsFor('tag', String(values.tags ?? ''));
        await api.updateVideo(ids[0]!, patch);
      }
      await onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  if (!detail)
    return (
      <aside className="detail-panel" aria-label="Catalog editor">
        <p>{error ?? 'Loading details…'}</p>
      </aside>
    );
  const mixed = bulk ? '— Mixed / unchanged —' : '';
  return (
    <aside
      className="detail-panel"
      aria-label={bulk ? `Bulk edit ${ids.length} videos` : `Edit ${detail.displayTitle}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          void save();
        }
        const typing = (e.target as HTMLElement).matches('input, textarea');
        if (!typing && /^[1-5]$/.test(e.key)) set('rating', Number(e.key));
        if (!typing && e.key.toLowerCase() === 'f') set('favorite', !values.favorite);
      }}
    >
      <div className="detail-head">
        <h2>{bulk ? `Edit ${ids.length} videos` : detail.displayTitle}</h2>
        <button onClick={onClose} aria-label="Close editor">
          ×
        </button>
      </div>
      <p className="shortcut-hint">Tab through fields · Ctrl/⌘S save · Esc cancel · rating 1–5</p>
      <label>
        Title
        <input
          ref={first}
          value={String(values.title ?? '')}
          placeholder={mixed || detail.displayTitle}
          onChange={(e) => set('title', e.target.value || null)}
        />
      </label>
      <label>
        Type
        <select
          value={String(values.videoType ?? '')}
          onChange={(e) => set('videoType', e.target.value || null)}
        >
          <option value="">{mixed || 'None'}</option>
          {videoTypes.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </label>
      <label>
        Style
        <input
          role="combobox"
          aria-controls="style-options"
          list="style-options"
          value={String(values.styleName ?? '')}
          placeholder={mixed}
          onChange={(e) => {
            const name = e.target.value;
            setValues((v) => ({ ...v, styleName: name }));
            const found = styles.find(
              (s) => s.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
            );
            set('styleId', found?.id ?? null);
          }}
        />
        <datalist id="style-options">
          {styles.map((x) => (
            <option key={x.id} value={x.name} />
          ))}
        </datalist>
      </label>
      <label>
        Instructors
        <input
          role="combobox"
          aria-label="Instructors (comma separated)"
          value={String(values.instructors ?? '')}
          placeholder={mixed || 'Type a name, comma to add another'}
          onChange={(e) => set('instructors', e.target.value)}
        />
      </label>
      <label>
        Level
        <select
          value={String(values.level ?? '')}
          onChange={(e) => set('level', e.target.value || null)}
        >
          <option value="">{mixed || 'None'}</option>
          {levels.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </label>
      <label>
        Event
        <input
          value={String(values.eventName ?? '')}
          placeholder={mixed}
          onChange={(e) => set('eventName', e.target.value || null)}
        />
      </label>
      <label>
        Date
        <input
          type="date"
          value={String(values.eventDate ?? '')}
          onChange={(e) => set('eventDate', e.target.value || null)}
        />
      </label>
      <label>
        Tags
        <input
          role="combobox"
          aria-label="Tags (comma separated)"
          value={String(values.tags ?? '')}
          placeholder={mixed || 'Type a tag, comma to add another'}
          onChange={(e) => set('tags', e.target.value)}
        />
      </label>
      <label>
        Rating
        <select
          value={String(values.rating ?? '')}
          onChange={(e) => set('rating', e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">{mixed || 'Unrated'}</option>
          {[1, 2, 3, 4, 5].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </label>
      <label className="favorite-toggle">
        <input
          type="checkbox"
          checked={Boolean(values.favorite)}
          onChange={(e) => set('favorite', e.target.checked)}
        />{' '}
        Favorite
      </label>
      <label>
        Notes
        <textarea
          value={String(values.notes ?? '')}
          placeholder={mixed}
          onChange={(e) => set('notes', e.target.value || null)}
        />
      </label>
      {!bulk ? (
        <LinkPicker
          api={api}
          detail={detail}
          onChanged={() => api.getVideoDetails(detail.id).then(setDetail)}
        />
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="detail-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={() => void save()} disabled={bulk && dirty.size === 0}>
          Save
        </button>
      </div>
    </aside>
  );
}

function fromDetail(d: VideoDetails): Record<string, unknown> {
  return {
    title: d.title ?? '',
    videoType: d.videoType ?? '',
    styleId: d.style?.id ?? null,
    styleName: d.style?.name ?? '',
    instructors: d.instructors.map((x) => x.name).join(', '),
    level: d.level ?? '',
    eventName: d.eventName ?? '',
    eventDate: d.eventDate ?? '',
    tags: d.tags.map((x) => x.name).join(', '),
    rating: d.rating ?? '',
    favorite: d.favorite,
    notes: d.notes ?? '',
  };
}

function LinkPicker({
  api,
  detail,
  onChanged,
}: {
  api: DanceLibraryApi;
  detail: VideoDetails;
  onChanged: () => void;
}) {
  const [q, setQ] = useState('');
  const [options, setOptions] = useState<
    { id: string; displayTitle: string; videoType: string | null }[]
  >([]);
  useEffect(() => {
    if (!q) {
      setOptions([]);
      return;
    }
    void api
      .listVideos({ text: q, limit: 12 })
      .then((result) =>
        setOptions(
          result.items.filter(
            (video) =>
              video.id !== detail.id &&
              ((detail.videoType === 'lesson' && video.videoType === 'demo') ||
                (detail.videoType === 'demo' && video.videoType === 'lesson')),
          ),
        ),
      );
  }, [api, q, detail]);
  return (
    <fieldset>
      <legend>Lesson/demo links</legend>
      {detail.lessonDemos.map((x) => (
        <div key={x.id} className="linked-item">
          {x.title}
          <button
            onClick={() => {
              const lesson = detail.videoType === 'lesson' ? detail.id : x.id;
              const demo = detail.videoType === 'demo' ? detail.id : x.id;
              void api.unlinkLessonDemo(lesson, demo).then(onChanged);
            }}
          >
            Unlink
          </button>
        </div>
      ))}
      {detail.videoType === 'lesson' || detail.videoType === 'demo' ? (
        <>
          <input
            aria-label="Find lesson or demo"
            placeholder="Search videos to link"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <ul role="listbox">
            {options.map((x) => (
              <li key={x.id} role="option" aria-selected="false">
                <button
                  onClick={() => {
                    const lesson = detail.videoType === 'lesson' ? detail.id : x.id;
                    const demo = detail.videoType === 'demo' ? detail.id : x.id;
                    void api.linkLessonDemo(lesson, demo).then(() => {
                      setQ('');
                      onChanged();
                    });
                  }}
                >
                  {x.displayTitle}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>Set this video to Lesson or Demo, save, then add a link.</p>
      )}
    </fieldset>
  );
}
