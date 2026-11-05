import type { CatalogFacets, Level, VideoSort, VideoType } from '../shared/api';
import { levels, videoSorts, videoTypes } from '../shared/api';
import type { BrowseFilters, DurationPreset } from '../shared/search';
import {
  durationPresets,
  emptyBrowseFilters,
  filtersAreActive,
  videoTypeLabels,
} from '../shared/search';

const sortLabels: Record<VideoSort, string> = {
  newest: 'Newest',
  oldest: 'Oldest',
  title: 'Title A-Z',
  'title-desc': 'Title Z-A',
  longest: 'Longest',
  shortest: 'Shortest',
  relevance: 'Relevance',
};

export function FilterBar({
  facets,
  value,
  onChange,
}: {
  facets: CatalogFacets;
  value: BrowseFilters;
  onChange: (next: BrowseFilters) => void;
}) {
  function patch(partial: Partial<BrowseFilters>): void {
    onChange({ ...value, ...partial });
  }

  return (
    <div className="filters">
      <div className="filter-row">
        <label className="filter-field search-field">
          Search
          <input
            type="search"
            value={value.text}
            placeholder="Titles, notes, tags, and file names"
            onChange={(event) => patch({ text: event.target.value })}
          />
        </label>
        <label className="filter-field">
          Sort
          <select
            value={value.sort}
            onChange={(event) => patch({ sort: event.target.value as VideoSort })}
          >
            {videoSorts.map((sort) => (
              <option key={sort} value={sort}>
                {sortLabels[sort]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="filter-row">
        <label className="filter-field">
          From
          <input
            type="date"
            value={value.capturedFrom}
            onChange={(event) => patch({ capturedFrom: event.target.value })}
          />
        </label>
        <label className="filter-field">
          To
          <input
            type="date"
            value={value.capturedTo}
            onChange={(event) => patch({ capturedTo: event.target.value })}
          />
        </label>
        <label className="filter-field">
          Type
          <select
            value={value.videoType}
            onChange={(event) => patch({ videoType: event.target.value as VideoType | '' })}
          >
            <option value="">Any type</option>
            {videoTypes.map((type) => (
              <option key={type} value={type}>
                {videoTypeLabels[type]}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          Style
          <select
            value={value.styleId}
            onChange={(event) => patch({ styleId: event.target.value })}
          >
            <option value="">Any style</option>
            {facets.styles.map((style) => (
              <option key={style.id} value={style.id}>
                {style.name}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          Instructor
          <select
            value={value.instructorId}
            onChange={(event) => patch({ instructorId: event.target.value })}
          >
            <option value="">Any instructor</option>
            {facets.instructors.map((instructor) => (
              <option key={instructor.id} value={instructor.id}>
                {instructor.name}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          Level
          <select
            value={value.level}
            onChange={(event) => patch({ level: event.target.value as Level | '' })}
          >
            <option value="">Any level</option>
            {levels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          Tag
          <select value={value.tagId} onChange={(event) => patch({ tagId: event.target.value })}>
            <option value="">Any tag</option>
            {facets.tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          Duration
          <select
            value={value.duration}
            onChange={(event) => patch({ duration: event.target.value as DurationPreset | '' })}
          >
            <option value="">Any length</option>
            {durationPresets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          Source
          <select
            value={value.libraryId}
            onChange={(event) => patch({ libraryId: event.target.value })}
          >
            <option value="">Any folder</option>
            {facets.libraries.map((library) => (
              <option key={library.id} value={library.id}>
                {library.label}
              </option>
            ))}
          </select>
        </label>
        <label className="favorite-toggle">
          <input
            type="checkbox"
            checked={value.favoriteOnly}
            onChange={(event) => patch({ favoriteOnly: event.target.checked })}
          />
          Favorites
        </label>
        <button
          type="button"
          onClick={() => onChange(emptyBrowseFilters())}
          disabled={!filtersAreActive(value)}
        >
          Clear
        </button>
      </div>
    </div>
  );
}
