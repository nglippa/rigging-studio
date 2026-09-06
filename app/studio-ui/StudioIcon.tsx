/** Shared precision glyphs. Labels stay on the owning controls. */
export function StudioIcon({ name }: { name: 'rig' | 'select' | 'pan' | 'fit' | 'search' | 'undo' | 'redo' | 'edit' }) {
  const paths = {
    rig: 'M6 5h7l5 6-5 8H6V5Zm0 0 7 7-7 7m7-7 5-1',
    select: 'm5 3 14 9-7 1-3 7-4-17Z',
    pan: 'M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3m12-6 3 3-3 3',
    fit: 'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5M9 9h6v6H9Z',
    search: 'm15 15 5 5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z',
    undo: 'M8 5 3 10l5 5M3 10h11a6 6 0 0 1 6 6v3',
    redo: 'm16 5 5 5-5 5m5-5H10a6 6 0 0 0-6 6v3',
    edit: 'm14 5 5 5M4 20l5-1L20 8l-5-5L4 14v6Z',
  };
  return <svg className="studio-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>;
}
