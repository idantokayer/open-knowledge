import type { HocuspocusProvider } from '@hocuspocus/provider';
import { useSyncExternalStore } from 'react';
import { ReadonlyPropertyPanel } from '@/components/ReadonlyPropertyPanel';

/**
 * Read-only frontmatter view: feeds the live `source` Y.Text into the existing
 * {@link ReadonlyPropertyPanel} (also used by SkillMarkdownViewer). Rendered in
 * place of the editable {@link PropertyPanel} when the server is read-only.
 *
 * Subscribes to the Y.Text so a collab update from another writer still
 * reflects — the panel is display-only, so no binding/mutation machinery is
 * needed.
 */
export function ReadonlyFrontmatterPanel({ provider }: { provider: HocuspocusProvider }) {
  const ytext = provider.document.getText('source');
  const text = useSyncExternalStore(
    (onChange) => {
      ytext.observe(onChange);
      return () => ytext.unobserve(onChange);
    },
    () => ytext.toString(),
  );
  return <ReadonlyPropertyPanel text={text} />;
}
