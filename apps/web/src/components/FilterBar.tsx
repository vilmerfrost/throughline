import type { ReactNode } from 'react';
import type { EdgeDirection, Language, Trust } from '@throughline/core';
import { langTag, toneDotClass, toneOf } from '../lib/trust';
import { ALL_DIRECTIONS, ALL_LANGS, ALL_TRUST, isDefault, type FilterState } from '../lib/filters';

interface FilterBarProps {
  state: FilterState;
  contracts: { id: string; label: string }[];
  visibleNodes: number;
  totalNodes: number;
  onToggleTrust: (t: Trust) => void;
  onToggleLang: (l: Language) => void;
  onToggleDir: (d: EdgeDirection) => void;
  onFocus: (id: string | null) => void;
  onReset: () => void;
}

function Chip({
  active,
  onClick,
  children,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide transition ${
        active
          ? 'border-neutral-600 bg-neutral-800 text-neutral-100'
          : 'border-neutral-800 text-neutral-500 hover:text-neutral-300'
      }`}
    >
      {children}
    </button>
  );
}

export function FilterBar({
  state,
  contracts,
  visibleNodes,
  totalNodes,
  onToggleTrust,
  onToggleLang,
  onToggleDir,
  onFocus,
  onReset,
}: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-neutral-800 bg-neutral-900 px-5 py-2 text-neutral-400">
      <Group label="Trust">
        {ALL_TRUST.map((t) => (
          <Chip key={t} active={state.trust.has(t)} onClick={() => onToggleTrust(t)}>
            <span className={`h-2 w-2 rounded-full ${toneDotClass(toneOf('touch', t))}`} />
            {t}
          </Chip>
        ))}
      </Group>

      <Group label="Lang">
        {ALL_LANGS.map((l) => (
          <Chip key={l} active={state.languages.has(l)} onClick={() => onToggleLang(l)}>
            {langTag(l) || l.toUpperCase()}
          </Chip>
        ))}
      </Group>

      <Group label="Dir">
        {ALL_DIRECTIONS.map((d) => (
          <Chip key={d} active={state.directions.has(d)} onClick={() => onToggleDir(d)}>
            {d}
          </Chip>
        ))}
      </Group>

      <Group label="Focus">
        <select
          value={state.focusContractId ?? ''}
          onChange={(e) => onFocus(e.target.value || null)}
          className="max-w-[180px] rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-300"
        >
          <option value="">All contracts</option>
          {contracts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </Group>

      <div className="ml-auto flex items-center gap-3 text-[11px]">
        <span className="text-neutral-500">
          showing <span className="text-neutral-300">{visibleNodes}</span> / {totalNodes} nodes
        </span>
        {!isDefault(state) ? (
          <button
            type="button"
            onClick={onReset}
            className="rounded border border-neutral-700 px-2 py-1 font-medium text-neutral-300 transition hover:bg-neutral-800"
          >
            Reset
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-600">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}
