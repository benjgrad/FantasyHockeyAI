import { useState } from 'react';
import { dismissIosHint, iosHintVisible } from './browser';

/**
 * iOS Safari, not installed: explain Share → Add to Home Screen once. Dismissing is
 * remembered, and running from the Home Screen hides it for good.
 */
export function IosInstallHint() {
  const [visible, setVisible] = useState(iosHintVisible);
  if (!visible) return null;
  return (
    <div className="flex items-start gap-3 border-b border-line bg-card px-3 py-2 text-sm">
      <p className="min-w-0 flex-1 text-soft">
        Install Hockey GM: tap <b>Share</b> then <b>Add to Home Screen</b>. Notifications on iPhone
        only work in the installed app.
      </p>
      <button
        className="text-mut hover:text-ink"
        aria-label="Dismiss"
        onClick={() => {
          dismissIosHint();
          setVisible(false);
        }}
      >
        ✕
      </button>
    </div>
  );
}
