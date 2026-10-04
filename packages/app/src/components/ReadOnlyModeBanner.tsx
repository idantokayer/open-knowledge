import { Trans } from '@lingui/react/macro';
import { Lock } from 'lucide-react';
import { SkillModeBanner } from '@/components/SkillModeBanner';

/**
 * Advisory banner shown at the top of the editor pane when the server reports
 * `server.readOnly`. Thin wrapper over {@link SkillModeBanner} (mirrors
 * {@link SkillEditBanner}). Advisory only — the server is the enforcement point.
 */
export function ReadOnlyModeBanner() {
  return (
    <SkillModeBanner icon={<Lock className="size-4" aria-hidden />}>
      <Trans>This knowledge base is read-only. Editing is disabled.</Trans>
    </SkillModeBanner>
  );
}
