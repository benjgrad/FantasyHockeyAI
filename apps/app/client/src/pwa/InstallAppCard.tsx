import { useState } from 'react';
import { isIos } from '../push/notifications';
import { isStandalone } from './browser';
import { promptInstall, useInstallState } from './install';

/** Settings → App: install from here (Android/desktop), or how to on iOS. */
export function InstallAppCard() {
  const install = useInstallState();
  const [outcome, setOutcome] = useState<string | null>(null);
  const standalone = isStandalone();

  let body: string;
  if (standalone || install.installed) body = 'Installed — you’re using the app.';
  else if (install.canInstall) body = 'Add Hockey GM to your home screen or dock.';
  else if (isIos()) body = 'In Safari, tap Share → Add to Home Screen.';
  else body = 'Use your browser’s menu → Install app (or Add to Home screen).';

  return (
    <div className="card flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="font-semibold">Install app</div>
        <div className="text-xs text-mut">{outcome ?? body}</div>
      </div>
      {install.canInstall && !standalone ? (
        <button
          className="btn btn-primary"
          onClick={() =>
            void promptInstall().then((result) =>
              setOutcome(result === 'accepted' ? 'Installing…' : null),
            )
          }
        >
          Install app
        </button>
      ) : null}
    </div>
  );
}
