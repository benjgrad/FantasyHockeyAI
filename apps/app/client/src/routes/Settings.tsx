import type { Me } from '@fha/api';
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { InstallAppCard } from '../pwa/InstallAppCard';
import { NotificationSettings } from '../settings/NotificationSettings';
import { PermissionsEditor } from '../settings/PermissionsEditor';
import { YahooConnect } from '../settings/YahooConnect';

export function Settings({ me }: { me: Me }) {
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);

  return (
    <div className="flex flex-col gap-6 overflow-y-auto p-3 pb-10">
      <h1 className="text-lg font-semibold">Settings</h1>
      <section id="yahoo" className="flex flex-col gap-3">
        <h2 className="font-semibold">Yahoo Fantasy</h2>
        <YahooConnect me={me} />
      </section>
      <section id="permissions" className="flex flex-col gap-3">
        <h2 className="font-semibold">Permissions</h2>
        <PermissionsEditor />
      </section>
      <section id="notifications" className="flex flex-col gap-3">
        <h2 className="font-semibold">Notifications</h2>
        <p className="text-xs text-mut">
          On iPhone and iPad, push notifications only work in the installed app (Safari → Share →
          Add to Home Screen, then open it from the Home Screen).
        </p>
        <NotificationSettings />
      </section>
      <section id="app" className="flex flex-col gap-3">
        <h2 className="font-semibold">App</h2>
        <InstallAppCard />
      </section>
    </div>
  );
}
