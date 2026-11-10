import { useEffect, useId, useRef, useState } from 'react';
import {
  levels,
  videoTypes,
  type BulkVideoUpdate,
  type CatalogValue,
  type CatalogValueKind,
  type DanceLibraryApi,
  type VideoDetails,
  type VideoUpdate,
} from '../shared/api';

type Values = Record<string, unknown>;

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
  const [details, setDetails] = useState<VideoDetails[]>([]);
  const [values, setValues] = useState<Values>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const styleInput = useRef<HTMLInputElement>(null);
  const eventInput = useRef<HTMLInputElement>(null);
  const dateInput = useRef<HTMLInputElement>(null);
  const notesInput = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setDetails([]);
    setValues({});
    setDirty(new Set());
    setError(null);
    Promise.all(ids.map((id) => api.getVideoDetails(id)))
      .then((loaded) => {
        if (cancelled) return;
        setDetails(loaded);
        setValues(bulk ? commonValues(loaded) : fromDetail(loaded[0]!));
        queueMicrotask(() => first.current?.focus());
      })
      .catch((e) => {
        if (!cancelled) setError(message(e));
      });
    return () => {
      cancelled = true;
    };
  }, [api, bulk, ids]);
  const detail = details[0];
  function set(key: string, value: unknown) {
    setValues((v) => ({ ...v, [key]: value }));
    setDirty((d) => new Set(d).add(key));
  }
  function leaveUnchanged(key: string, input: HTMLElement | null) {
    setValues((current) => ({ ...current, [key]: commonValues(details)[key] ?? '' }));
    setDirty((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    queueMicrotask(() => input?.focus());
  }
  async function valueIds(
    kind: CatalogValueKind,
    names: string,
    create: boolean,
  ): Promise<string[]> {
    const out: string[] = [];
    for (const raw of names.split(',')) {
      const name = raw.trim();
      if (!name) continue;
      if (create) out.push((await api.createCatalogValue(kind, name)).id);
      else {
        const match = (await api.searchCatalogValues(kind, name)).find(
          (value) => value.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0,
        );
        if (!match) throw new Error(`Unknown ${kind}: ${name}`);
        out.push(match.id);
      }
    }
    return [...new Set(out)];
  }
  async function save() {
    if (saving) return;
    try {
      setError(null);
      setSaving(true);
      if (bulk) {
        const patch: BulkVideoUpdate = {};
        for (const key of dirty) {
          if (
            ['addInstructors', 'removeInstructors', 'addTags', 'removeTags', 'styleName'].includes(
              key,
            )
          )
            continue;
          (patch as Values)[key] = values[key];
        }
        const removeInstructorIds = dirty.has('removeInstructors')
          ? await valueIds('instructor', String(values.removeInstructors ?? ''), false)
          : undefined;
        const removeTagIds = dirty.has('removeTags')
          ? await valueIds('tag', String(values.removeTags ?? ''), false)
          : undefined;
        if (dirty.has('styleName'))
          patch.styleId = String(values.styleName ?? '').trim()
            ? (await api.createCatalogValue('style', String(values.styleName))).id
            : null;
        if (dirty.has('addInstructors'))
          patch.addInstructorIds = await valueIds(
            'instructor',
            String(values.addInstructors ?? ''),
            true,
          );
        if (removeInstructorIds) patch.removeInstructorIds = removeInstructorIds;
        if (dirty.has('addTags'))
          patch.addTagIds = await valueIds('tag', String(values.addTags ?? ''), true);
        if (removeTagIds) patch.removeTagIds = removeTagIds;
        const result = await api.bulkUpdateVideos(ids, patch);
        if (result.changed !== result.requested)
          throw new Error(
            `Updated ${result.changed} of ${result.requested} videos. The selection changed; please review it.`,
          );
      } else {
        const patch: VideoUpdate = {};
        for (const key of dirty) {
          if (['instructors', 'tags', 'styleName'].includes(key)) continue;
          (patch as Values)[key] = values[key];
        }
        if (dirty.has('styleName'))
          patch.styleId = String(values.styleName ?? '').trim()
            ? (await api.createCatalogValue('style', String(values.styleName))).id
            : null;
        if (dirty.has('instructors'))
          patch.instructorIds = await valueIds(
            'instructor',
            String(values.instructors ?? ''),
            true,
          );
        if (dirty.has('tags'))
          patch.tagIds = await valueIds('tag', String(values.tags ?? ''), true);
        if (Object.keys(patch).length) await api.updateVideo(ids[0]!, patch);
      }
      if (!mounted.current) return;
      await onSaved();
      if (!mounted.current) return;
      onClose();
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }
  if (!detail)
    return (
      <aside className="detail-panel" role="dialog" aria-modal="true" aria-label="Catalog editor">
        <p>{error ?? 'Loading details…'}</p>
      </aside>
    );
  const mixed = '— Mixed / unchanged —';
  const select = (
    key: string,
    label: string,
    choices: readonly (string | number)[],
    clear: string,
  ) => (
    <label>
      {label}
      <select
        value={dirty.has(key) || !bulk ? String(values[key] ?? '') : '__unchanged'}
        onChange={(e) => {
          if (e.target.value === '__unchanged') {
            setDirty((d) => {
              const n = new Set(d);
              n.delete(key);
              return n;
            });
          } else
            set(
              key,
              e.target.value === ''
                ? null
                : key === 'rating'
                  ? Number(e.target.value)
                  : e.target.value,
            );
        }}
      >
        <option value="__unchanged" hidden={!bulk}>
          {mixed}
        </option>
        <option value="">{clear}</option>
        {choices.map((x) => (
          <option key={x}>{x}</option>
        ))}
      </select>
    </label>
  );
  return (
    <aside
      ref={panel}
      className="detail-panel"
      role="dialog"
      aria-modal="true"
      aria-label={bulk ? `Bulk edit ${ids.length} videos` : `Edit ${detail.displayTitle}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          void save();
        }
        const typing = (e.target as HTMLElement).matches('input, textarea, select');
        if (!typing && /^[1-5]$/.test(e.key)) set('rating', Number(e.key));
        if (!typing && e.key.toLowerCase() === 'f') set('favorite', !values.favorite);
        if (e.key === 'Tab') trapTab(e, panel.current);
      }}
    >
      <div className="detail-head">
        <h2>{bulk ? `Edit ${ids.length} videos` : detail.displayTitle}</h2>
        <button onClick={onClose} aria-label="Close editor">
          ×
        </button>
      </div>
      <p className="shortcut-hint">Tab through fields · Ctrl/⌘S save · Esc cancel · rating 1–5</p>
      <div className="combo-field">
        <label htmlFor="catalog-title">Title</label>
        <input
          id="catalog-title"
          ref={first}
          value={String(values.title ?? '')}
          placeholder={bulk && !dirty.has('title') ? mixed : ''}
          onChange={(e) => set('title', e.target.value || null)}
        />
        {bulk ? (
          <button
            type="button"
            disabled={!dirty.has('title')}
            onClick={() => leaveUnchanged('title', first.current)}
          >
            Leave title unchanged
          </button>
        ) : null}
      </div>
      {select('videoType', 'Type', videoTypes, 'Clear type')}
      <CatalogCombo
        api={api}
        kind="style"
        label="Style"
        inputRef={styleInput}
        value={String(values.styleName ?? '')}
        placeholder={bulk && !dirty.has('styleName') ? mixed : ''}
        onChange={(v) =>
          bulk && !v ? leaveUnchanged('styleName', styleInput.current) : set('styleName', v)
        }
      />
      {bulk ? (
        <div className="field-actions">
          <button
            type="button"
            disabled={!dirty.has('styleName')}
            onClick={() => leaveUnchanged('styleName', styleInput.current)}
          >
            Leave style unchanged
          </button>
          <button type="button" onClick={() => set('styleName', null)}>
            Clear style on all
          </button>
        </div>
      ) : null}
      {bulk ? (
        <>
          <CommonChips
            label="Instructors on every selected video"
            values={intersection(details.map((d) => d.instructors))}
            onRemove={(name) => set('removeInstructors', append(values.removeInstructors, name))}
          />
          <CatalogCombo
            api={api}
            kind="instructor"
            label="Add instructors"
            value={String(values.addInstructors ?? '')}
            onChange={(v) => set('addInstructors', v)}
          />
          <CatalogCombo
            api={api}
            kind="instructor"
            label="Remove instructors"
            value={String(values.removeInstructors ?? '')}
            onChange={(v) => set('removeInstructors', v)}
          />
        </>
      ) : (
        <CatalogCombo
          api={api}
          kind="instructor"
          label="Instructors (comma separated)"
          value={String(values.instructors ?? '')}
          onChange={(v) => set('instructors', v)}
        />
      )}
      {select('level', 'Level', levels, 'Clear level')}
      <div className="combo-field">
        <label htmlFor="catalog-event">Event</label>
        <input
          id="catalog-event"
          ref={eventInput}
          value={String(values.eventName ?? '')}
          placeholder={bulk && !dirty.has('eventName') ? mixed : ''}
          onChange={(e) => set('eventName', e.target.value || null)}
        />
        {bulk ? (
          <button
            type="button"
            disabled={!dirty.has('eventName')}
            onClick={() => leaveUnchanged('eventName', eventInput.current)}
          >
            Leave event unchanged
          </button>
        ) : null}
      </div>
      <div className="combo-field">
        <label htmlFor="catalog-date">Date</label>
        <input
          id="catalog-date"
          ref={dateInput}
          type="date"
          value={String(values.eventDate ?? '')}
          aria-label={`Date${bulk && !dirty.has('eventDate') && values.eventDate === undefined ? ' (mixed or unchanged)' : ''}`}
          onChange={(e) =>
            bulk && !e.target.value
              ? leaveUnchanged('eventDate', dateInput.current)
              : set('eventDate', e.target.value)
          }
        />
        {bulk && !dirty.has('eventDate') && values.eventDate === undefined ? (
          <small>{mixed}</small>
        ) : null}
        {bulk ? (
          <div className="field-actions">
            <button
              type="button"
              disabled={!dirty.has('eventDate')}
              onClick={() => leaveUnchanged('eventDate', dateInput.current)}
            >
              Leave date unchanged
            </button>
            <button type="button" onClick={() => set('eventDate', null)}>
              Clear date on all
            </button>
          </div>
        ) : null}
      </div>
      {bulk ? (
        <>
          <CommonChips
            label="Tags on every selected video"
            values={intersection(details.map((d) => d.tags))}
            onRemove={(name) => set('removeTags', append(values.removeTags, name))}
          />
          <CatalogCombo
            api={api}
            kind="tag"
            label="Add tags"
            value={String(values.addTags ?? '')}
            onChange={(v) => set('addTags', v)}
          />
          <CatalogCombo
            api={api}
            kind="tag"
            label="Remove tags"
            value={String(values.removeTags ?? '')}
            onChange={(v) => set('removeTags', v)}
          />
        </>
      ) : (
        <CatalogCombo
          api={api}
          kind="tag"
          label="Tags (comma separated)"
          value={String(values.tags ?? '')}
          onChange={(v) => set('tags', v)}
        />
      )}
      {select('rating', 'Rating', [1, 2, 3, 4, 5], 'Clear rating')}
      {bulk ? (
        <label className="favorite-toggle">
          Favorite
          <select
            value={dirty.has('favorite') ? String(values.favorite) : '__unchanged'}
            onChange={(e) => {
              if (e.target.value === '__unchanged')
                setDirty((d) => {
                  const next = new Set(d);
                  next.delete('favorite');
                  return next;
                });
              else set('favorite', e.target.value === 'true');
            }}
          >
            <option value="__unchanged">{mixed}</option>
            <option value="true">Favorite</option>
            <option value="false">Not favorite</option>
          </select>
        </label>
      ) : (
        <label className="favorite-toggle">
          <input
            type="checkbox"
            checked={Boolean(values.favorite)}
            onChange={(e) => set('favorite', e.target.checked)}
          />{' '}
          Favorite
        </label>
      )}
      <div className="combo-field">
        <label htmlFor="catalog-notes">Notes</label>
        <textarea
          id="catalog-notes"
          ref={notesInput}
          value={String(values.notes ?? '')}
          placeholder={bulk && !dirty.has('notes') ? mixed : ''}
          onChange={(e) => set('notes', e.target.value || null)}
        />
        {bulk ? (
          <button
            type="button"
            disabled={!dirty.has('notes')}
            onClick={() => leaveUnchanged('notes', notesInput.current)}
          >
            Leave notes unchanged
          </button>
        ) : null}
      </div>
      {!bulk ? (
        <LinkPicker
          api={api}
          detail={detail}
          onChanged={() => api.getVideoDetails(detail.id).then((d) => setDetails([d]))}
          onError={setError}
        />
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="detail-actions">
        <button onClick={onClose}>Cancel</button>
        <button
          className="primary"
          onClick={() => void save()}
          disabled={dirty.size === 0 || saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </aside>
  );
}

function CatalogCombo({
  api,
  kind,
  label,
  value,
  placeholder = '',
  inputRef,
  onChange,
}: {
  api: DanceLibraryApi;
  kind: CatalogValueKind;
  label: string;
  value: string;
  placeholder?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  onChange: (v: string) => void;
}) {
  const id = useId(),
    [options, setOptions] = useState<CatalogValue[]>([]),
    [open, setOpen] = useState(false),
    [active, setActive] = useState(-1),
    [optionsToken, setOptionsToken] = useState(''),
    [focused, setFocused] = useState(false),
    seq = useRef(0);
  const token = value.split(',').at(-1)?.trim() ?? '';
  useEffect(() => {
    if (!focused || !token) {
      ++seq.current;
      setOptions([]);
      setOptionsToken('');
      setOpen(false);
      return;
    }
    const current = ++seq.current;
    const timer = setTimeout(() => {
      api
        .searchCatalogValues(kind, token)
        .then((v) => {
          if (current === seq.current) {
            setOptions(v);
            setOptionsToken(token);
            setActive(-1);
            setOpen(v.length > 0);
          }
        })
        .catch(() => {});
    }, 100);
    return () => clearTimeout(timer);
  }, [api, focused, kind, token]);
  const currentOptions = optionsToken === token ? options : [];
  const optionsOpen = open && currentOptions.length > 0;
  function accept(name: string) {
    const parts = value.split(',');
    parts[parts.length - 1] = ` ${name}`;
    onChange(parts.join(',').replace(/^ /, ''));
    setOpen(false);
  }
  return (
    <div className="combo-field">
      <label htmlFor={`${id}-input`}>{label}</label>
      <input
        ref={inputRef}
        id={`${id}-input`}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={optionsOpen}
        aria-controls={id}
        aria-activedescendant={optionsOpen && active >= 0 ? `${id}-${active}` : undefined}
        value={value}
        placeholder={placeholder || 'Type a name; comma adds another'}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setOpen(false);
        }}
        onChange={(e) => {
          setFocused(true);
          onChange(e.target.value);
          setOpen(false);
          setOptionsToken('');
          setActive(-1);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && optionsOpen) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
            return;
          }
          if (!optionsOpen) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setActive(
              (a) =>
                (a + (e.key === 'ArrowDown' ? 1 : -1) + currentOptions.length) %
                currentOptions.length,
            );
          }
          if (e.key === 'Enter') {
            if (currentOptions[active]) {
              e.preventDefault();
              accept(currentOptions[active].name);
            }
          }
        }}
      />
      {optionsOpen ? (
        <ul id={id} role="listbox" className="combo-options">
          {currentOptions.map((x, i) => (
            <li
              id={`${id}-${i}`}
              key={x.id}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(x.name);
              }}
            >
              {x.name}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CommonChips({
  label,
  values,
  onRemove,
}: {
  label: string;
  values: CatalogValue[];
  onRemove: (name: string) => void;
}) {
  return (
    <div className="common-values">
      <span>{label}</span>
      {values.length ? (
        values.map((x) => (
          <button key={x.id} onClick={() => onRemove(x.name)} aria-label={`Remove ${x.name}`}>
            {x.name} ×
          </button>
        ))
      ) : (
        <small>None in common</small>
      )}
    </div>
  );
}

function LinkPicker({
  api,
  detail,
  onChanged,
  onError,
}: {
  api: DanceLibraryApi;
  detail: VideoDetails;
  onChanged: () => void;
  onError: (e: string | null) => void;
}) {
  const listId = useId();
  const [q, setQ] = useState(''),
    [options, setOptions] = useState<
      { id: string; displayTitle: string; videoType: string | null }[]
    >([]),
    [active, setActive] = useState(0),
    seq = useRef(0);
  const wanted = detail.videoType === 'lesson' ? 'demo' : 'lesson';
  useEffect(() => {
    if (!q) {
      setOptions([]);
      return;
    }
    const current = ++seq.current,
      t = setTimeout(() => {
        api
          .listVideos({ text: q, videoTypes: [wanted as 'lesson' | 'demo'], limit: 12 })
          .then((r) => {
            if (current === seq.current) {
              setActive(0);
              setOptions(
                r.items.filter(
                  (x) => x.id !== detail.id && !detail.lessonDemos.some((l) => l.id === x.id),
                ),
              );
            }
          })
          .catch((e) => onError(message(e)));
      }, 150);
    return () => clearTimeout(t);
  }, [api, detail, q, wanted, onError]);
  function link(id: string) {
    const lesson = detail.videoType === 'lesson' ? detail.id : id,
      demo = detail.videoType === 'demo' ? detail.id : id;
    api
      .linkLessonDemo(lesson, demo)
      .then(() => {
        setQ('');
        onChanged();
      })
      .catch((e) => onError(message(e)));
  }
  return (
    <fieldset>
      <legend>Lesson/demo links</legend>
      {detail.lessonDemos.map((x) => (
        <div key={x.id} className="linked-item">
          {x.title}
          <button
            onClick={() =>
              api
                .unlinkLessonDemo(detail.id, x.id)
                .then(onChanged)
                .catch((e) => onError(message(e)))
            }
          >
            Unlink
          </button>
        </div>
      ))}
      {detail.videoType === 'lesson' || detail.videoType === 'demo' ? (
        <>
          <input
            role="combobox"
            aria-autocomplete="list"
            aria-label="Find lesson or demo"
            aria-expanded={options.length > 0}
            aria-controls={listId}
            aria-activedescendant={options[active] ? `${listId}-${active}` : undefined}
            placeholder="Search videos to link"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && (q || options.length > 0)) {
                e.preventDefault();
                e.stopPropagation();
                setQ('');
                setOptions([]);
                return;
              }
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setActive(
                  (a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length,
                );
              }
              if (e.key === 'Enter' && options[active]) {
                e.preventDefault();
                link(options[active].id);
              }
            }}
          />
          {options.length ? (
            <ul id={listId} role="listbox" className="combo-options link-options">
              {options.map((x, i) => (
                <li
                  id={`${listId}-${i}`}
                  key={x.id}
                  role="option"
                  aria-selected={i === active}
                  onClick={() => link(x.id)}
                >
                  {x.displayTitle}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p>Set this video to Lesson or Demo, save, then add a link.</p>
      )}
    </fieldset>
  );
}

function fromDetail(d: VideoDetails): Values {
  return {
    title: d.title ?? '',
    videoType: d.videoType ?? '',
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
function commonValues(ds: VideoDetails[]): Values {
  const fields = [
      'title',
      'videoType',
      'level',
      'eventName',
      'eventDate',
      'rating',
      'favorite',
      'notes',
    ] as const,
    out: Values = {};
  for (const f of fields) {
    const vals = ds.map((d) => d[f]);
    if (vals.every((v) => v === vals[0])) out[f] = vals[0] ?? '';
  }
  const styles = ds.map((d) => d.style?.name ?? '');
  if (styles.every((v) => v === styles[0])) out.styleName = styles[0];
  return out;
}
function intersection(groups: CatalogValue[][]): CatalogValue[] {
  return groups[0]?.filter((x) => groups.every((g) => g.some((y) => y.id === x.id))) ?? [];
}
function append(value: unknown, name: string) {
  return [String(value ?? '').trim(), name].filter(Boolean).join(', ');
}
function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
function trapTab(e: React.KeyboardEvent, root: HTMLElement | null) {
  if (!root) return;
  const items = [
    ...root.querySelectorAll<HTMLElement>(
      'button,input,select,textarea,[tabindex]:not([tabindex="-1"])',
    ),
  ].filter((x) => !x.hasAttribute('disabled'));
  if (!items.length) return;
  const first = items[0]!,
    last = items.at(-1)!;
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
