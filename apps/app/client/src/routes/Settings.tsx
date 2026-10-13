import type { Me } from '@fha/api';
import { useEffect } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { InstallAppCard } from '../pwa/InstallAppCard';
import { NotificationSettings } from '../settings/NotificationSettings';
import { PermissionsEditor } from '../settings/PermissionsEditor';
import { ThemeSettings } from '../settings/ThemeSettings';
import { YahooConnect } from '../settings/YahooConnect';
import { usePane } from '../components/pane';

export function Settings({ me }: { me: Me }) {
  const pane = usePane();
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);

  return (
    <div ref={pane} className="pane flex flex-col gap-6 p-3 pb-10">
      <h1 className="display text-2xl leading-tight">Settings</h1>
      <section id="yahoo" className="flex flex-col gap-3">
        <h2 className="font-semibold">Yahoo Fantasy</h2>
        <YahooConnect me={me} />
      </section>
      <section id="activity" className="flex flex-col gap-3">
        <h2 className="font-semibold">Background agents</h2>
        <Link to="/activity" className="card flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-medium">What the agents watch</div>
            <div className="text-xs text-mut">
              Players followed and why, watcher checks, the schedule, and the activity chat.
            </div>
          </div>
          <span className="text-acc">→</span>
        </Link>
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
      <section id="appearance" className="flex flex-col gap-3">
        <h2 className="font-semibold">Appearance</h2>
        <ThemeSettings />
      </section>
      <section id="app" className="flex flex-col gap-3">
        <h2 className="font-semibold">App</h2>
        <InstallAppCard />
      </section>
    </div>
  );
}
